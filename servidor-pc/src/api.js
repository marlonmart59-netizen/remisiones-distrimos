'use strict';
/**
 * API REST del Sistema de Remisiones DISTRIMOS (servidor PC / servidor central).
 * Todas las rutas viven bajo /api y responden JSON.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { ahora, uuid } = require('./db');
const { hashClave, verificarClave, crearToken } = require('./seguridad');
const { err, Enrutador } = require('./http');

const ROLES = ['admin', 'gerente', 'secretario', 'repartidor', 'cliente'];
const INTERNOS = ['admin', 'gerente', 'secretario', 'repartidor'];
const OFICINA = ['admin', 'gerente', 'secretario'];
const EDITORES = ['secretario'];

// ---------------------------------------------------------------- utilidades
const txt = (v, max = 300) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);
const num = (v, def = 0) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
const req = (v, nombre) => { if (v === null || v === undefined || v === '') throw err(400, `El campo "${nombre}" es obligatorio.`); return v; };
const hoyLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function decodificarImagen(dataUrl, campo) {
  const m = /^data:(image\/(png|jpeg|webp));base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!m) throw err(400, `La ${campo} no tiene un formato de imagen válido.`);
  const datos = Buffer.from(m[3], 'base64');
  if (datos.length < 100) throw err(400, `La ${campo} está vacía.`);
  if (datos.length > 8 * 1024 * 1024) throw err(413, `La ${campo} es demasiado grande (máximo 8 MB).`);
  return { mime: m[1], datos };
}

function usuarioPublico(u) {
  if (!u) return null;
  return { id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol, cliente_id: u.cliente_id, activo: !!u.activo, debe_cambiar_clave: !!u.debe_cambiar_clave };
}

function ipsLocales() {
  const res = [];
  for (const lista of Object.values(os.networkInterfaces())) {
    for (const i of lista || []) if (i.family === 'IPv4' && !i.internal) res.push(i.address);
  }
  return res;
}

// ---------------------------------------------------------------- consultas
function cargarContrato(db, id) {
  const c = db.uno(`SELECT c.*, cl.nombre AS cliente_nombre FROM contratos c JOIN clientes cl ON cl.id = c.cliente_id WHERE c.id = ?`, id);
  if (!c) return null;
  c.items = db.todos(`SELECT ci.*, p.nombre AS producto_nombre, p.unidad, p.codigo AS producto_codigo
    FROM contrato_items ci JOIN productos p ON p.id = ci.producto_id WHERE ci.contrato_id = ? ORDER BY p.nombre`, id);
  return c;
}

/** Avance de un contrato: cantidades contratadas, entregadas, en tránsito y valores. */
function avanceContrato(db, contratoId) {
  const items = db.todos(`
    SELECT ci.producto_id, p.nombre AS producto, p.unidad, ci.cantidad AS contratado, ci.precio_unitario,
      COALESCE((SELECT SUM(ri.cantidad) FROM remision_items ri JOIN remisiones r ON r.id = ri.remision_id
                WHERE r.contrato_id = ci.contrato_id AND ri.producto_id = ci.producto_id AND r.estado = 'entregada'), 0) AS entregado,
      COALESCE((SELECT SUM(ri.cantidad) FROM remision_items ri JOIN remisiones r ON r.id = ri.remision_id
                WHERE r.contrato_id = ci.contrato_id AND ri.producto_id = ci.producto_id AND r.estado = 'pendiente'), 0) AS en_transito
    FROM contrato_items ci JOIN productos p ON p.id = ci.producto_id
    WHERE ci.contrato_id = ? ORDER BY p.nombre`, contratoId);
  const t = { contratado: 0, entregado: 0, en_transito: 0, valor_contratado: 0, valor_entregado: 0 };
  for (const i of items) {
    i.pendiente = Math.max(0, i.contratado - i.entregado);
    i.valor_contratado = i.contratado * i.precio_unitario;
    i.valor_entregado = Math.min(i.entregado, i.contratado) * i.precio_unitario;
    i.porcentaje = i.contratado > 0 ? Math.min(100, (i.entregado / i.contratado) * 100) : 0;
    t.contratado += i.contratado;
    t.entregado += Math.min(i.entregado, i.contratado);
    t.en_transito += i.en_transito;
    t.valor_contratado += i.valor_contratado;
    t.valor_entregado += i.valor_entregado;
  }
  t.pendiente = Math.max(0, t.contratado - t.entregado);
  t.saldo_valor = Math.max(0, t.valor_contratado - t.valor_entregado);
  t.porcentaje = t.contratado > 0 ? (t.entregado / t.contratado) * 100 : 0;
  t.porcentaje_valor = t.valor_contratado > 0 ? (t.valor_entregado / t.valor_contratado) * 100 : 0;
  return { items, totales: t };
}

function contratosConAvance(db, filtroClienteId, soloIds) {
  let sql = `SELECT c.*, cl.nombre AS cliente_nombre FROM contratos c JOIN clientes cl ON cl.id = c.cliente_id`;
  const p = [];
  if (filtroClienteId) { sql += ' WHERE c.cliente_id = ?'; p.push(filtroClienteId); }
  sql += ' ORDER BY c.estado, c.fecha_inicio DESC, c.codigo';
  let lista = db.todos(sql, ...p);
  if (soloIds) lista = lista.filter((c) => soloIds.has(c.id));
  return lista.map((c) => ({ ...c, avance: avanceContrato(db, c.id).totales }));
}

function cargarRemision(db, id, conEvidencias = true) {
  const r = db.uno(`SELECT r.*, cl.nombre AS cliente_nombre, cl.nit AS cliente_nit, cl.representante AS cliente_representante,
      cl.direccion AS cliente_direccion, cl.telefono AS cliente_telefono, co.codigo AS contrato_codigo,
      u.nombre AS repartidor_nombre, uc.nombre AS creado_por_nombre
    FROM remisiones r
    JOIN clientes cl ON cl.id = r.cliente_id
    LEFT JOIN contratos co ON co.id = r.contrato_id
    LEFT JOIN usuarios u ON u.id = r.repartidor_id
    LEFT JOIN usuarios uc ON uc.id = r.creado_por
    WHERE r.id = ?`, id);
  if (!r) return null;
  r.items = db.todos(`SELECT ri.*, p.unidad, p.codigo AS producto_codigo FROM remision_items ri LEFT JOIN productos p ON p.id = ri.producto_id
    WHERE ri.remision_id = ? ORDER BY ri.rowid`, id);
  r.total = r.items.reduce((s, i) => s + i.cantidad * i.precio_unitario, 0);
  r.unidades = r.items.reduce((s, i) => s + i.cantidad, 0);
  if (conEvidencias) {
    r.evidencias = db.todos('SELECT id, tipo, rol, mime, tomada_en, length(datos) AS bytes FROM evidencias WHERE remision_id = ? ORDER BY tomada_en', id);
    r.historial = db.todos('SELECT id, fecha, usuario_nombre, accion, motivo, version_anterior FROM remision_historial WHERE remision_id = ? ORDER BY fecha', id)
      .map((h) => ({ ...h, version_anterior: h.version_anterior ? JSON.parse(h.version_anterior) : null }));
  }
  return r;
}

function puedeVerRemision(u, r) {
  if (OFICINA.includes(u.rol)) return true;
  if (u.rol === 'repartidor') return r.repartidor_id === u.id || r.creado_por === u.id;
  if (u.rol === 'cliente') return r.cliente_id === u.cliente_id && r.estado === 'entregada';
  return false;
}

function siguienteNumero(db) {
  const prefijo = db.config('prefijo_remision', 'R');
  let n = Number(db.config('consecutivo_remision', '0'));
  let numero;
  do {
    n += 1;
    numero = `${prefijo}-${String(n).padStart(5, '0')}`;
  } while (db.uno('SELECT 1 AS x FROM remisiones WHERE numero = ?', numero));
  db.setConfig('consecutivo_remision', n);
  return numero;
}

function validarItems(db, items) {
  if (!Array.isArray(items) || items.length === 0) throw err(400, 'La remisión debe tener al menos un producto.');
  return items.map((i, idx) => {
    const cantidad = num(i.cantidad);
    if (cantidad <= 0) throw err(400, `La cantidad del producto ${idx + 1} debe ser mayor que cero.`);
    let descripcion = txt(i.descripcion, 200);
    let precio = num(i.precio_unitario, NaN);
    const productoId = txt(i.producto_id, 64);
    if (productoId) {
      const p = db.uno('SELECT * FROM productos WHERE id = ?', productoId);
      if (!p) throw err(400, `El producto ${idx + 1} no existe.`);
      descripcion = descripcion || p.nombre;
      if (!Number.isFinite(precio)) precio = p.precio;
    }
    if (!descripcion) throw err(400, `Falta la descripción del producto ${idx + 1}.`);
    return { id: i.id && /^[\w-]{8,64}$/.test(i.id) ? i.id : uuid(), producto_id: productoId, descripcion, cantidad, precio_unitario: Number.isFinite(precio) ? precio : 0 };
  });
}

/** Si la remisión es de un contrato, el precio por defecto es el pactado en el contrato. */
function preciosDeContrato(db, contratoId, items) {
  if (!contratoId) return items;
  const precios = new Map(db.todos('SELECT producto_id, precio_unitario FROM contrato_items WHERE contrato_id = ?', contratoId).map((x) => [x.producto_id, x.precio_unitario]));
  return items.map((i) => (i._precioExplicito || !precios.has(i.producto_id) ? i : { ...i, precio_unitario: precios.get(i.producto_id) }));
}

function advertenciasContrato(db, contratoId, items, excluirRemisionId) {
  if (!contratoId) return [];
  const av = avanceContrato(db, contratoId);
  const adv = [];
  for (const i of items) {
    const fila = av.items.find((x) => x.producto_id === i.producto_id);
    if (!fila) { adv.push(`"${i.descripcion}" no hace parte del contrato.`); continue; }
    let comprometido = fila.entregado + fila.en_transito;
    if (excluirRemisionId) {
      const previo = db.uno(`SELECT COALESCE(SUM(cantidad),0) AS c FROM remision_items WHERE remision_id = ? AND producto_id = ?`, excluirRemisionId, i.producto_id);
      comprometido -= previo ? previo.c : 0;
    }
    if (comprometido + i.cantidad > fila.contratado) {
      adv.push(`"${i.descripcion}": con esta remisión se superan las ${fila.contratado} unidades contratadas (ya comprometidas: ${comprometido}).`);
    }
  }
  return adv;
}

function snapshotRemision(r) {
  const campos = ['numero', 'contrato_id', 'contrato_codigo', 'cliente_id', 'cliente_nombre', 'repartidor_id', 'repartidor_nombre', 'fecha', 'municipio', 'direccion_entrega', 'observaciones', 'estado'];
  const s = {};
  for (const c of campos) s[c] = r[c] ?? null;
  s.items = (r.items || []).map((i) => ({ producto_id: i.producto_id, descripcion: i.descripcion, cantidad: i.cantidad, precio_unitario: i.precio_unitario }));
  return s;
}

function registrarHistorial(db, remisionId, usuario, accion, motivo, versionAnterior) {
  db.ejecutar(`INSERT INTO remision_historial(id, remision_id, fecha, usuario_id, usuario_nombre, accion, motivo, version_anterior)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, uuid(), remisionId, ahora(), usuario ? usuario.id : null, usuario ? usuario.nombre : 'sistema', accion, motivo || null,
  versionAnterior ? JSON.stringify(versionAnterior) : null);
}

// ---------------------------------------------------------------- construcción de rutas
function crearApi(ctxGlobal) {
  const { db, dirDatos, version } = ctxGlobal;
  const api = new Enrutador();
  const R = (m, p, roles, fn, op) => api.agregar(m, p, roles, fn, op);
  const intentosFallidos = new Map();

  // ------------------------------------------------ información y sesión
  R('GET', '/api/info', null, () => ({
    sistema: 'Sistema de Remisiones DISTRIMOS',
    empresa: db.config('empresa_nombre', 'DISTRIMOS S.A.S'),
    modo: 'pc',
    version,
    servidor_ahora: ahora(),
    puerto: ctxGlobal.puerto,
    direcciones: ipsLocales().map((ip) => `http://${ip}:${ctxGlobal.puerto}`),
    capacidades: { inventario: false, respaldos: true, usuarios: true, sync_central: true, sync_movil: false, datos_demo: true, edicion_remisiones: true },
  }));

  R('POST', '/api/auth/login', null, ({ body }) => {
    const usuario = txt(body.usuario, 60);
    const clave = String(body.clave || '');
    req(usuario, 'usuario'); req(clave, 'contraseña');
    const clave_intentos = usuario.toLowerCase();
    const reg = intentosFallidos.get(clave_intentos);
    if (reg && reg.bloqueadoHasta > Date.now()) {
      const s = Math.ceil((reg.bloqueadoHasta - Date.now()) / 1000);
      throw err(429, `Demasiados intentos fallidos. Espere ${s} segundos.`);
    }
    const u = db.uno('SELECT * FROM usuarios WHERE usuario = ?', usuario);
    if (!u || !u.activo || !verificarClave(clave, u.clave_hash)) {
      const n = (reg ? reg.n : 0) + 1;
      intentosFallidos.set(clave_intentos, { n, bloqueadoHasta: n >= 5 ? Date.now() + 60000 : 0 });
      db.auditar(usuario, 'login_fallido', null);
      throw err(401, 'Usuario o contraseña incorrectos.');
    }
    intentosFallidos.delete(clave_intentos);
    const horas = body.dispositivo ? 24 * 30 : 12;
    const token = crearToken({ uid: u.id, rol: u.rol, dispositivo: !!body.dispositivo }, ctxGlobal.secreto, horas);
    db.auditar(u.usuario, body.dispositivo ? 'login_dispositivo' : 'login', body.dispositivo ? `Dispositivo: ${txt(body.dispositivo, 80)}` : null);
    return { token, usuario: usuarioPublico(u), expira_horas: horas };
  });

  R('GET', '/api/auth/yo', '*', ({ usuario }) => ({ usuario: usuarioPublico(usuario) }));

  R('POST', '/api/auth/clave', '*', ({ usuario, body }) => {
    const nueva = String(body.nueva || '');
    if (!verificarClave(String(body.actual || ''), usuario.clave_hash)) throw err(400, 'La contraseña actual no es correcta.');
    if (nueva.length < 6) throw err(400, 'La nueva contraseña debe tener al menos 6 caracteres.');
    db.ejecutar('UPDATE usuarios SET clave_hash = ?, debe_cambiar_clave = 0, actualizado_en = ? WHERE id = ?', hashClave(nueva), ahora(), usuario.id);
    db.auditar(usuario.usuario, 'cambio_clave', null);
    return { ok: true };
  });

  // ------------------------------------------------ usuarios
  R('GET', '/api/usuarios', ['admin'], () => db.todos(`SELECT u.*, c.nombre AS cliente_nombre FROM usuarios u LEFT JOIN clientes c ON c.id = u.cliente_id ORDER BY u.rol, u.nombre`).map((u) => ({ ...usuarioPublico(u), cliente_nombre: u.cliente_nombre, creado_en: u.creado_en })));

  R('GET', '/api/repartidores', INTERNOS, () => db.todos(`SELECT id, nombre, usuario FROM usuarios WHERE rol = 'repartidor' AND activo = 1 ORDER BY nombre`));

  function guardarUsuario({ body, usuario, params }) {
    const id = params.id || uuid();
    const existente = params.id ? db.uno('SELECT * FROM usuarios WHERE id = ?', id) : null;
    if (params.id && !existente) throw err(404, 'Usuario no encontrado.');
    const datos = {
      id,
      usuario: req(txt(body.usuario, 60), 'usuario'),
      nombre: req(txt(body.nombre, 120), 'nombre'),
      rol: req(txt(body.rol, 20), 'rol'),
      cliente_id: txt(body.cliente_id, 64),
      activo: body.activo === undefined ? 1 : (body.activo ? 1 : 0),
      actualizado_en: ahora(),
    };
    if (!/^[a-zA-Z0-9._-]{3,60}$/.test(datos.usuario)) throw err(400, 'El usuario solo puede tener letras, números, punto, guion y guion bajo (mínimo 3).');
    if (!ROLES.includes(datos.rol)) throw err(400, 'Rol no válido.');
    if (datos.rol === 'cliente' && !datos.cliente_id) throw err(400, 'Un usuario con rol cliente debe estar asociado a un cliente.');
    if (datos.rol !== 'cliente') datos.cliente_id = null;
    const dup = db.uno('SELECT id FROM usuarios WHERE usuario = ? AND id <> ?', datos.usuario, id);
    if (dup) throw err(409, 'Ya existe un usuario con ese nombre de usuario.');
    if (existente && existente.id === usuario.id && (datos.rol !== 'admin' || !datos.activo)) throw err(400, 'No puede quitarse a sí mismo el rol de administrador ni desactivarse.');
    if (body.clave) {
      if (String(body.clave).length < 6) throw err(400, 'La contraseña debe tener al menos 6 caracteres.');
      datos.clave_hash = hashClave(body.clave);
      datos.debe_cambiar_clave = existente ? 1 : 1;
    } else if (!existente) {
      throw err(400, 'Debe asignar una contraseña inicial.');
    }
    if (!existente) datos.creado_en = ahora();
    db.upsert('usuarios', ['id', 'usuario', 'nombre', 'rol', 'cliente_id', 'clave_hash', 'activo', 'debe_cambiar_clave', 'creado_en', 'actualizado_en'], datos);
    db.auditar(usuario.usuario, existente ? 'usuario_editado' : 'usuario_creado', `${datos.usuario} (${datos.rol})`);
    return usuarioPublico(db.uno('SELECT * FROM usuarios WHERE id = ?', id));
  }
  R('POST', '/api/usuarios', ['admin'], guardarUsuario);
  R('PUT', '/api/usuarios/:id', ['admin'], guardarUsuario);

  // ------------------------------------------------ clientes
  R('GET', '/api/clientes', '*', ({ usuario }) => {
    if (usuario.rol === 'cliente') return db.todos('SELECT * FROM clientes WHERE id = ?', usuario.cliente_id);
    return db.todos('SELECT * FROM clientes ORDER BY activo DESC, nombre');
  });

  function guardarCliente({ body, usuario, params }) {
    const id = params.id || uuid();
    if (params.id && !db.uno('SELECT id FROM clientes WHERE id = ?', id)) throw err(404, 'Cliente no encontrado.');
    const tipo = txt(body.tipo, 20) || 'privado';
    if (!['publico', 'privado', 'fundacion', 'colegio'].includes(tipo)) throw err(400, 'Tipo de cliente no válido.');
    const c = {
      id,
      nombre: req(txt(body.nombre, 150), 'nombre'),
      nit: txt(body.nit, 30),
      tipo,
      representante: txt(body.representante, 120),
      telefono: txt(body.telefono, 40),
      email: txt(body.email, 120),
      direccion: txt(body.direccion, 200),
      municipio: txt(body.municipio, 80),
      autoriza_datos: body.autoriza_datos ? 1 : 0,
      activo: body.activo === undefined ? 1 : (body.activo ? 1 : 0),
      actualizado_en: ahora(),
    };
    db.upsert('clientes', Object.keys(c), c);
    db.auditar(usuario.usuario, params.id ? 'cliente_editado' : 'cliente_creado', c.nombre);
    return db.uno('SELECT * FROM clientes WHERE id = ?', id);
  }
  R('POST', '/api/clientes', EDITORES, guardarCliente);
  R('PUT', '/api/clientes/:id', EDITORES, guardarCliente);

  // ------------------------------------------------ productos
  R('GET', '/api/productos', '*', () => db.todos('SELECT * FROM productos ORDER BY activo DESC, nombre'));

  function guardarProducto({ body, usuario, params }) {
    const id = params.id || uuid();
    if (params.id && !db.uno('SELECT id FROM productos WHERE id = ?', id)) throw err(404, 'Producto no encontrado.');
    const p = {
      id,
      codigo: txt(body.codigo, 40),
      nombre: req(txt(body.nombre, 150), 'nombre'),
      unidad: txt(body.unidad, 30) || 'unidad',
      precio: body.precio === undefined ? (params.id ? db.uno('SELECT precio FROM productos WHERE id = ?', id).precio : 0) : Math.max(0, num(body.precio)),
      activo: body.activo === undefined ? 1 : (body.activo ? 1 : 0),
      actualizado_en: ahora(),
    };
    db.upsert('productos', Object.keys(p), p);
    db.auditar(usuario.usuario, params.id ? 'producto_editado' : 'producto_creado', p.nombre);
    return db.uno('SELECT * FROM productos WHERE id = ?', id);
  }
  R('POST', '/api/productos', ['secretario'], guardarProducto);
  R('PUT', '/api/productos/:id', EDITORES, guardarProducto);

  // ------------------------------------------------ contratos
  R('GET', '/api/contratos', '*', ({ usuario }) => {
    if (usuario.rol === 'cliente') return contratosConAvance(db, usuario.cliente_id);
    return contratosConAvance(db);
  });

  R('GET', '/api/contratos/:id', '*', ({ usuario, params }) => {
    const c = cargarContrato(db, params.id);
    if (!c || (usuario.rol === 'cliente' && c.cliente_id !== usuario.cliente_id)) throw err(404, 'Contrato no encontrado.');
    const av = avanceContrato(db, c.id);
    let sql = `SELECT r.id, r.numero, r.fecha, r.estado, r.municipio, r.entregada_en, r.editada, u.nombre AS repartidor_nombre,
      (SELECT SUM(cantidad) FROM remision_items WHERE remision_id = r.id) AS unidades,
      (SELECT SUM(cantidad * precio_unitario) FROM remision_items WHERE remision_id = r.id) AS total
      FROM remisiones r LEFT JOIN usuarios u ON u.id = r.repartidor_id WHERE r.contrato_id = ?`;
    const p = [c.id];
    if (usuario.rol === 'cliente') sql += ` AND r.estado = 'entregada'`;
    if (usuario.rol === 'repartidor') { sql += ' AND (r.repartidor_id = ? OR r.creado_por = ?)'; p.push(usuario.id, usuario.id); }
    sql += ' ORDER BY r.fecha DESC, r.numero DESC';
    const remisiones = db.todos(sql, ...p);
    if (usuario.rol === 'cliente') {
      av.totales.valor_contratado = undefined; // el cliente ve cantidades y porcentaje
    }
    return { ...c, avance: av, remisiones };
  });

  function guardarContrato({ body, usuario, params }) {
    const id = params.id || uuid();
    if (params.id && !db.uno('SELECT id FROM contratos WHERE id = ?', id)) throw err(404, 'Contrato no encontrado.');
    const c = {
      id,
      codigo: req(txt(body.codigo, 60), 'código'),
      cliente_id: req(txt(body.cliente_id, 64), 'cliente'),
      objeto: txt(body.objeto, 500),
      fecha_inicio: txt(body.fecha_inicio, 10),
      fecha_fin: txt(body.fecha_fin, 10),
      estado: ['activo', 'finalizado', 'suspendido'].includes(body.estado) ? body.estado : 'activo',
      actualizado_en: ahora(),
    };
    if (!db.uno('SELECT id FROM clientes WHERE id = ?', c.cliente_id)) throw err(400, 'El cliente no existe.');
    const items = Array.isArray(body.items) ? body.items : [];
    const vistos = new Set();
    for (const i of items) {
      if (!db.uno('SELECT id FROM productos WHERE id = ?', i.producto_id)) throw err(400, 'Hay un producto del contrato que no existe.');
      if (vistos.has(i.producto_id)) throw err(400, 'Un producto está repetido en el contrato.');
      vistos.add(i.producto_id);
      if (num(i.cantidad) <= 0) throw err(400, 'Las cantidades del contrato deben ser mayores que cero.');
    }
    // Si el cliente no envía precio (p. ej. la secretaria), se conserva el del contrato o el de referencia del producto.
    const preciosPrevios = new Map(db.todos('SELECT producto_id, precio_unitario FROM contrato_items WHERE contrato_id = ?', id).map((x) => [x.producto_id, x.precio_unitario]));
    const precioDeItem = (i) => (i.precio_unitario !== undefined && i.precio_unitario !== null && i.precio_unitario !== ''
      ? Math.max(0, num(i.precio_unitario))
      : (preciosPrevios.has(i.producto_id) ? preciosPrevios.get(i.producto_id) : db.uno('SELECT precio FROM productos WHERE id = ?', i.producto_id).precio));
    db.transaccion(() => {
      db.upsert('contratos', Object.keys(c), c);
      db.ejecutar('DELETE FROM contrato_items WHERE contrato_id = ?', id);
      for (const i of items) {
        db.ejecutar('INSERT INTO contrato_items(id, contrato_id, producto_id, cantidad, precio_unitario) VALUES (?,?,?,?,?)',
          uuid(), id, i.producto_id, num(i.cantidad), precioDeItem(i));
      }
    });
    db.auditar(usuario.usuario, params.id ? 'contrato_editado' : 'contrato_creado', c.codigo);
    return cargarContrato(db, id);
  }
  R('POST', '/api/contratos', ['secretario'], guardarContrato);
  R('PUT', '/api/contratos/:id', EDITORES, guardarContrato);

  // ------------------------------------------------ remisiones
  R('GET', '/api/remisiones', '*', ({ usuario, query }) => {
    const w = [];
    const p = [];
    if (usuario.rol === 'repartidor') { w.push('(r.repartidor_id = ? OR r.creado_por = ?)'); p.push(usuario.id, usuario.id); }
    if (usuario.rol === 'cliente') { w.push(`r.cliente_id = ? AND r.estado = 'entregada'`); p.push(usuario.cliente_id); }
    if (query.estado) { w.push('r.estado = ?'); p.push(query.estado); }
    if (query.cliente_id) { w.push('r.cliente_id = ?'); p.push(query.cliente_id); }
    if (query.contrato_id) { w.push('r.contrato_id = ?'); p.push(query.contrato_id); }
    if (query.repartidor_id) { w.push('r.repartidor_id = ?'); p.push(query.repartidor_id); }
    if (query.desde) { w.push('r.fecha >= ?'); p.push(query.desde); }
    if (query.hasta) { w.push('r.fecha <= ?'); p.push(query.hasta); }
    if (query.q) {
      w.push('(r.numero LIKE ? OR cl.nombre LIKE ? OR r.municipio LIKE ? OR r.receptor_nombre LIKE ? OR co.codigo LIKE ?)');
      const q = `%${query.q}%`;
      p.push(q, q, q, q, q);
    }
    const limite = Math.min(500, Math.max(1, num(query.limite, 200)));
    return db.todos(`SELECT r.id, r.numero, r.fecha, r.estado, r.editada, r.municipio, r.entregada_en, r.receptor_nombre, r.origen, r.pendiente_sync,
        r.cliente_id, cl.nombre AS cliente_nombre, r.contrato_id, co.codigo AS contrato_codigo, r.repartidor_id, u.nombre AS repartidor_nombre,
        (SELECT SUM(cantidad) FROM remision_items WHERE remision_id = r.id) AS unidades,
        (SELECT SUM(cantidad * precio_unitario) FROM remision_items WHERE remision_id = r.id) AS total,
        (SELECT COUNT(*) FROM evidencias WHERE remision_id = r.id) AS evidencias
      FROM remisiones r JOIN clientes cl ON cl.id = r.cliente_id
      LEFT JOIN contratos co ON co.id = r.contrato_id LEFT JOIN usuarios u ON u.id = r.repartidor_id
      ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
      ORDER BY r.fecha DESC, r.creado_en DESC LIMIT ${limite}`, ...p);
  });

  R('GET', '/api/remisiones/:id', '*', ({ usuario, params }) => {
    const r = cargarRemision(db, params.id);
    if (!r || !puedeVerRemision(usuario, r)) throw err(404, 'Remisión no encontrada.');
    if (usuario.rol === 'cliente') r.historial = r.historial.map((h) => ({ ...h, version_anterior: null }));
    return r;
  });

  R('POST', '/api/remisiones', ['secretario'], ({ usuario, body }) => {
    const contratoId = txt(body.contrato_id, 64);
    let clienteId = txt(body.cliente_id, 64);
    if (contratoId) {
      const c = db.uno('SELECT * FROM contratos WHERE id = ?', contratoId);
      if (!c) throw err(400, 'El contrato no existe.');
      if (c.estado !== 'activo') throw err(400, 'El contrato no está activo.');
      clienteId = c.cliente_id;
    }
    req(clienteId, 'cliente');
    const cliente = db.uno('SELECT * FROM clientes WHERE id = ?', clienteId);
    if (!cliente) throw err(400, 'El cliente no existe.');
    let repartidorId = txt(body.repartidor_id, 64);
    if (usuario.rol === 'repartidor') repartidorId = usuario.id;
    if (repartidorId && !db.uno(`SELECT id FROM usuarios WHERE id = ? AND rol = 'repartidor'`, repartidorId)) throw err(400, 'El repartidor no existe.');
    const items = preciosDeContrato(db, contratoId, validarItems(db, body.items).map((i, k) => ({ ...i, _precioExplicito: body.items[k].precio_unitario !== undefined && body.items[k].precio_unitario !== '' })));
    const advertencias = advertenciasContrato(db, contratoId, items);
    const id = uuid();
    const t = ahora();
    db.transaccion(() => {
      const numero = siguienteNumero(db);
      db.ejecutar(`INSERT INTO remisiones(id, numero, contrato_id, cliente_id, repartidor_id, fecha, municipio, direccion_entrega, observaciones,
        estado, creado_por, creado_en, actualizado_en, origen) VALUES (?,?,?,?,?,?,?,?,?, 'pendiente', ?, ?, ?, 'pc')`,
      id, numero, contratoId, clienteId, repartidorId, txt(body.fecha, 10) || hoyLocal(), txt(body.municipio, 80) || cliente.municipio,
      txt(body.direccion_entrega, 200) || cliente.direccion, txt(body.observaciones, 1000), usuario.id, t, t);
      for (const i of items) {
        db.ejecutar('INSERT INTO remision_items(id, remision_id, producto_id, descripcion, cantidad, precio_unitario) VALUES (?,?,?,?,?,?)',
          i.id, id, i.producto_id, i.descripcion, i.cantidad, i.precio_unitario);
      }
      registrarHistorial(db, id, usuario, 'creada', null, null);
    });
    const r = cargarRemision(db, id);
    db.auditar(usuario.usuario, 'remision_creada', r.numero);
    return { ...r, advertencias };
  });

  R('PUT', '/api/remisiones/:id', EDITORES, ({ usuario, body, params }) => {
    const anterior = cargarRemision(db, params.id);
    if (!anterior) throw err(404, 'Remisión no encontrada.');
    if (anterior.estado === 'anulada') throw err(400, 'Una remisión anulada no se puede editar.');
    const motivo = txt(body.motivo, 500);
    if (!motivo || motivo.length < 5) throw err(400, 'Debe escribir el motivo de la edición (mínimo 5 caracteres).');
    const contratoId = body.contrato_id === undefined ? anterior.contrato_id : txt(body.contrato_id, 64);
    let clienteId = body.cliente_id === undefined ? anterior.cliente_id : txt(body.cliente_id, 64);
    if (contratoId) {
      const c = db.uno('SELECT * FROM contratos WHERE id = ?', contratoId);
      if (!c) throw err(400, 'El contrato no existe.');
      clienteId = c.cliente_id;
    }
    if (!db.uno('SELECT id FROM clientes WHERE id = ?', clienteId)) throw err(400, 'El cliente no existe.');
    const repartidorId = body.repartidor_id === undefined ? anterior.repartidor_id : txt(body.repartidor_id, 64);
    const items = body.items ? validarItems(db, body.items) : null;
    const advertencias = items ? advertenciasContrato(db, contratoId, items, anterior.id) : [];
    db.transaccion(() => {
      db.ejecutar(`UPDATE remisiones SET contrato_id = ?, cliente_id = ?, repartidor_id = ?, fecha = ?, municipio = ?, direccion_entrega = ?,
        observaciones = ?, editada = 1, actualizado_en = ? WHERE id = ?`,
      contratoId, clienteId, repartidorId, txt(body.fecha, 10) || anterior.fecha,
      body.municipio === undefined ? anterior.municipio : txt(body.municipio, 80),
      body.direccion_entrega === undefined ? anterior.direccion_entrega : txt(body.direccion_entrega, 200),
      body.observaciones === undefined ? anterior.observaciones : txt(body.observaciones, 1000), ahora(), anterior.id);
      if (items) {
        db.ejecutar('DELETE FROM remision_items WHERE remision_id = ?', anterior.id);
        for (const i of items) {
          db.ejecutar('INSERT INTO remision_items(id, remision_id, producto_id, descripcion, cantidad, precio_unitario) VALUES (?,?,?,?,?,?)',
            uuid(), anterior.id, i.producto_id, i.descripcion, i.cantidad, i.precio_unitario);
        }
      }
      registrarHistorial(db, anterior.id, usuario, 'editada', motivo, snapshotRemision(anterior));
    });
    db.auditar(usuario.usuario, 'remision_editada', `${anterior.numero}: ${motivo}`);
    return { ...cargarRemision(db, anterior.id), advertencias };
  });

  R('POST', '/api/remisiones/:id/entrega', ['secretario', 'repartidor'], ({ usuario, body, params }) => {
    const r = cargarRemision(db, params.id, false);
    if (!r) throw err(404, 'Remisión no encontrada.');
    if (usuario.rol === 'repartidor' && r.repartidor_id && r.repartidor_id !== usuario.id) throw err(403, 'Esta remisión está asignada a otro repartidor.');
    if (r.estado !== 'pendiente') throw err(400, `La remisión ya está ${r.estado}.`);
    const receptor = req(txt(body.receptor_nombre, 120), 'nombre de quien recibe');
    const firma = decodificarImagen(req(body.firma, 'firma'), 'firma');
    const firmaRep = body.firma_repartidor ? decodificarImagen(body.firma_repartidor, 'firma del repartidor') : null;
    const foto = body.foto ? decodificarImagen(body.foto, 'foto') : null;
    if (!foto && !body.sin_foto_motivo) throw err(400, 'Debe tomar la foto de la entrega o indicar por qué no fue posible.');
    const t = ahora();
    db.transaccion(() => {
      db.ejecutar(`UPDATE remisiones SET estado = 'entregada', entregada_en = ?, receptor_nombre = ?, receptor_documento = ?, observaciones_entrega = ?,
        repartidor_id = COALESCE(repartidor_id, ?), actualizado_en = ? WHERE id = ?`,
      t, receptor, txt(body.receptor_documento, 30), txt(body.observaciones_entrega || body.sin_foto_motivo, 1000),
      usuario.rol === 'repartidor' ? usuario.id : null, t, r.id);
      db.ejecutar('INSERT INTO evidencias(id, remision_id, tipo, mime, datos, tomada_en) VALUES (?,?,?,?,?,?)', uuid(), r.id, 'firma', firma.mime, firma.datos, t);
      if (firmaRep) db.ejecutar('INSERT INTO evidencias(id, remision_id, tipo, mime, datos, tomada_en, rol) VALUES (?,?,?,?,?,?,?)', uuid(), r.id, 'firma', firmaRep.mime, firmaRep.datos, t, 'repartidor');
      if (foto) db.ejecutar('INSERT INTO evidencias(id, remision_id, tipo, mime, datos, tomada_en) VALUES (?,?,?,?,?,?)', uuid(), r.id, 'foto', foto.mime, foto.datos, t);
      registrarHistorial(db, r.id, usuario, 'entregada', foto ? null : `Sin foto: ${txt(body.sin_foto_motivo, 300)}`, null);
    });
    db.auditar(usuario.usuario, 'remision_entregada', r.numero);
    return cargarRemision(db, r.id);
  });

  R('POST', '/api/remisiones/:id/anular', EDITORES, ({ usuario, body, params }) => {
    const r = cargarRemision(db, params.id, false);
    if (!r) throw err(404, 'Remisión no encontrada.');
    if (r.estado === 'anulada') throw err(400, 'La remisión ya está anulada.');
    const motivo = txt(body.motivo, 500);
    if (!motivo || motivo.length < 5) throw err(400, 'Debe escribir el motivo de la anulación (mínimo 5 caracteres).');
    db.transaccion(() => {
      db.ejecutar(`UPDATE remisiones SET estado = 'anulada', motivo_anulacion = ?, actualizado_en = ? WHERE id = ?`, motivo, ahora(), r.id);
      registrarHistorial(db, r.id, usuario, 'anulada', motivo, snapshotRemision(r));
    });
    db.auditar(usuario.usuario, 'remision_anulada', `${r.numero}: ${motivo}`);
    return cargarRemision(db, r.id);
  });

  R('GET', '/api/evidencias/:id', '*', ({ usuario, params, res }) => {
    const e = db.uno('SELECT * FROM evidencias WHERE id = ?', params.id);
    if (!e) throw err(404, 'Evidencia no encontrada.');
    const r = db.uno('SELECT * FROM remisiones WHERE id = ?', e.remision_id);
    if (!r || !puedeVerRemision(usuario, r)) throw err(404, 'Evidencia no encontrada.');
    return { __binario: true, tipo: e.mime, datos: Buffer.from(e.datos), cabeceras: { 'Cache-Control': 'private, max-age=86400' } };
  });

  // ------------------------------------------------ panel por rol
  R('GET', '/api/panel', '*', ({ usuario }) => {
    const hoy = hoyLocal();
    const mes = hoy.slice(0, 7);
    if (usuario.rol === 'cliente') {
      const contratos = contratosConAvance(db, usuario.cliente_id);
      const recientes = db.todos(`SELECT r.id, r.numero, r.fecha, r.entregada_en, r.receptor_nombre, co.codigo AS contrato_codigo,
        (SELECT SUM(cantidad) FROM remision_items WHERE remision_id = r.id) AS unidades
        FROM remisiones r LEFT JOIN contratos co ON co.id = r.contrato_id
        WHERE r.cliente_id = ? AND r.estado = 'entregada' ORDER BY r.entregada_en DESC LIMIT 10`, usuario.cliente_id);
      const cliente = db.uno('SELECT nombre FROM clientes WHERE id = ?', usuario.cliente_id);
      return { rol: 'cliente', cliente: cliente ? cliente.nombre : '', contratos, recientes };
    }
    if (usuario.rol === 'repartidor') {
      const filtro = '(r.repartidor_id = ? OR r.creado_por = ?)';
      const pendientes = db.todos(`SELECT r.id, r.numero, r.fecha, r.municipio, r.direccion_entrega, cl.nombre AS cliente_nombre, co.codigo AS contrato_codigo,
        (SELECT SUM(cantidad) FROM remision_items WHERE remision_id = r.id) AS unidades
        FROM remisiones r JOIN clientes cl ON cl.id = r.cliente_id LEFT JOIN contratos co ON co.id = r.contrato_id
        WHERE ${filtro} AND r.estado = 'pendiente' ORDER BY r.fecha, r.numero`, usuario.id, usuario.id);
      const entregadasHoy = db.uno(`SELECT COUNT(*) AS n FROM remisiones r WHERE ${filtro} AND r.estado = 'entregada' AND substr(r.entregada_en,1,10) >= ?`, usuario.id, usuario.id, hoy).n;
      const entregadasMes = db.uno(`SELECT COUNT(*) AS n FROM remisiones r WHERE ${filtro} AND r.estado = 'entregada' AND substr(r.entregada_en,1,7) = ?`, usuario.id, usuario.id, mes).n;
      const ids = new Set(db.todos(`SELECT DISTINCT contrato_id FROM remisiones r WHERE ${filtro} AND contrato_id IS NOT NULL`, usuario.id, usuario.id).map((x) => x.contrato_id));
      const contratos = contratosConAvance(db, null, ids).filter((c) => c.estado === 'activo');
      return { rol: 'repartidor', kpis: { pendientes: pendientes.length, entregadas_hoy: entregadasHoy, entregadas_mes: entregadasMes }, pendientes, contratos };
    }
    // oficina: admin, gerente, secretario
    const kpis = {
      remisiones_hoy: db.uno('SELECT COUNT(*) AS n FROM remisiones WHERE fecha = ? AND estado <> \'anulada\'', hoy).n,
      pendientes: db.uno(`SELECT COUNT(*) AS n FROM remisiones WHERE estado = 'pendiente'`).n,
      entregadas_mes: db.uno(`SELECT COUNT(*) AS n FROM remisiones WHERE estado = 'entregada' AND substr(entregada_en,1,7) = ?`, mes).n,
      valor_entregado_mes: db.uno(`SELECT COALESCE(SUM(ri.cantidad * ri.precio_unitario),0) AS v FROM remision_items ri JOIN remisiones r ON r.id = ri.remision_id
        WHERE r.estado = 'entregada' AND substr(r.entregada_en,1,7) = ?`, mes).v,
      editadas: db.uno('SELECT COUNT(*) AS n FROM remisiones WHERE editada = 1').n,
      contratos_activos: db.uno(`SELECT COUNT(*) AS n FROM contratos WHERE estado = 'activo'`).n,
    };
    const contratos = contratosConAvance(db).filter((c) => c.estado === 'activo');
    const pendientesPorRepartidor = db.todos(`SELECT COALESCE(u.nombre, 'Sin asignar') AS repartidor, COUNT(*) AS n FROM remisiones r
      LEFT JOIN usuarios u ON u.id = r.repartidor_id WHERE r.estado = 'pendiente' GROUP BY u.nombre ORDER BY n DESC`);
    const recientes = db.todos(`SELECT r.id, r.numero, r.fecha, r.estado, r.editada, cl.nombre AS cliente_nombre, u.nombre AS repartidor_nombre,
      (SELECT SUM(cantidad * precio_unitario) FROM remision_items WHERE remision_id = r.id) AS total
      FROM remisiones r JOIN clientes cl ON cl.id = r.cliente_id LEFT JOIN usuarios u ON u.id = r.repartidor_id
      ORDER BY r.actualizado_en DESC LIMIT 8`);
    const ultimos = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const fila = db.uno(`SELECT COUNT(DISTINCT r.id) AS n, COALESCE(SUM(ri.cantidad * ri.precio_unitario),0) AS v FROM remisiones r
        LEFT JOIN remision_items ri ON ri.remision_id = r.id WHERE r.estado = 'entregada' AND substr(r.entregada_en,1,7) = ?`, m);
      ultimos.push({ mes: m, remisiones: fila.n, valor: fila.v });
    }
    return { rol: usuario.rol, kpis, contratos, pendientes_por_repartidor: pendientesPorRepartidor, recientes, por_mes: ultimos };
  });

  // ------------------------------------------------ auditoría
  R('GET', '/api/auditoria', ['admin', 'gerente'], ({ query }) => {
    const p = [];
    let w = '';
    if (query.q) { w = 'WHERE usuario LIKE ? OR accion LIKE ? OR detalle LIKE ?'; const q = `%${query.q}%`; p.push(q, q, q); }
    return db.todos(`SELECT * FROM auditoria ${w} ORDER BY id DESC LIMIT 500`, ...p);
  });

  // ------------------------------------------------ respaldos
  const dirRespaldos = path.join(dirDatos, 'respaldos');
  const nombreValido = (n) => /^respaldo-[\w-]+\.db$/.test(n);

  function crearRespaldo(etiqueta = 'manual') {
    const d = new Date();
    const sello = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    const nombre = `respaldo-${sello}-${etiqueta}.db`;
    const destino = path.join(dirRespaldos, nombre);
    if (fs.existsSync(destino)) fs.unlinkSync(destino);
    db.respaldarEn(destino);
    db.setConfig('ultimo_respaldo', ahora());
    // conserva los 30 más recientes
    const lista = fs.readdirSync(dirRespaldos).filter(nombreValido).sort();
    while (lista.length > 30) fs.unlinkSync(path.join(dirRespaldos, lista.shift()));
    return nombre;
  }
  ctxGlobal.crearRespaldo = crearRespaldo;

  function verificarArchivo(archivo) {
    const tmp = new DatabaseSync(archivo, { readOnly: true });
    try {
      const integ = tmp.prepare('PRAGMA integrity_check').get();
      const cuenta = (t) => { try { return tmp.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch (_) { return null; } };
      return {
        integridad: Object.values(integ)[0],
        remisiones: cuenta('remisiones'), clientes: cuenta('clientes'), contratos: cuenta('contratos'),
        evidencias: cuenta('evidencias'), usuarios: cuenta('usuarios'),
      };
    } finally {
      tmp.close();
    }
  }

  R('GET', '/api/respaldos', ['admin'], () => {
    fs.mkdirSync(dirRespaldos, { recursive: true });
    return {
      carpeta: dirRespaldos,
      ultimo: db.config('ultimo_respaldo'),
      archivos: fs.readdirSync(dirRespaldos).filter(nombreValido).sort().reverse().map((n) => {
        const st = fs.statSync(path.join(dirRespaldos, n));
        return { nombre: n, bytes: st.size, fecha: st.mtime.toISOString() };
      }),
    };
  });

  R('POST', '/api/respaldos', ['admin'], ({ usuario }) => {
    const nombre = crearRespaldo('manual');
    db.auditar(usuario.usuario, 'respaldo_creado', nombre);
    return { nombre, verificacion: verificarArchivo(path.join(dirRespaldos, nombre)) };
  });

  R('POST', '/api/respaldos/:nombre/verificar', ['admin'], ({ params, usuario }) => {
    if (!nombreValido(params.nombre)) throw err(400, 'Nombre de respaldo no válido.');
    const archivo = path.join(dirRespaldos, params.nombre);
    if (!fs.existsSync(archivo)) throw err(404, 'Respaldo no encontrado.');
    const v = verificarArchivo(archivo);
    db.auditar(usuario.usuario, 'respaldo_verificado', `${params.nombre}: ${v.integridad}`);
    return v;
  });

  R('GET', '/api/respaldos/:nombre', ['admin'], ({ params }) => {
    if (!nombreValido(params.nombre)) throw err(400, 'Nombre de respaldo no válido.');
    const archivo = path.join(dirRespaldos, params.nombre);
    if (!fs.existsSync(archivo)) throw err(404, 'Respaldo no encontrado.');
    return { __binario: true, tipo: 'application/octet-stream', datos: fs.readFileSync(archivo), cabeceras: { 'Content-Disposition': `attachment; filename="${params.nombre}"` } };
  });

  function restaurarDesde(archivo, usuario) {
    const v = verificarArchivo(archivo);
    if (v.integridad !== 'ok' || v.remisiones === null || v.usuarios === null) throw err(400, 'El archivo no es un respaldo válido del sistema.');
    const seguridad = crearRespaldo('antes-de-restaurar');
    db.cerrar();
    try {
      for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(db.archivo + ext); } catch (_) { /* no existe */ } }
      fs.copyFileSync(archivo, db.archivo);
    } finally {
      db.abrir();
    }
    db.auditar(usuario.usuario, 'respaldo_restaurado', `${path.basename(archivo)} (copia previa: ${seguridad})`);
    return { ok: true, copia_previa: seguridad, verificacion: v };
  }

  R('POST', '/api/respaldos/:nombre/restaurar', ['admin'], ({ params, usuario }) => {
    if (!nombreValido(params.nombre)) throw err(400, 'Nombre de respaldo no válido.');
    const archivo = path.join(dirRespaldos, params.nombre);
    if (!fs.existsSync(archivo)) throw err(404, 'Respaldo no encontrado.');
    const tmp = path.join(dirDatos, `restaurar-${Date.now()}.db`);
    fs.copyFileSync(archivo, tmp);
    try { return restaurarDesde(tmp, usuario); } finally { try { fs.unlinkSync(tmp); } catch (_) { /* nada */ } }
  });

  R('POST', '/api/respaldos-subir', ['admin'], ({ crudo, usuario }) => {
    if (!crudo || crudo.length < 100 || crudo.subarray(0, 15).toString('latin1') !== 'SQLite format 3') throw err(400, 'El archivo no es una base de datos SQLite.');
    const tmp = path.join(dirDatos, `restaurar-${Date.now()}.db`);
    fs.writeFileSync(tmp, crudo);
    try { return restaurarDesde(tmp, usuario); } finally { try { fs.unlinkSync(tmp); } catch (_) { /* nada */ } }
  }, { crudo: true });

  // ------------------------------------------------ ajustes de empresa
  R('GET', '/api/ajustes', OFICINA, () => ({
    empresa_nombre: db.config('empresa_nombre', 'DISTRIMOS S.A.S'),
    empresa_nit: db.config('empresa_nit', ''),
    empresa_direccion: db.config('empresa_direccion', 'Maicao, La Guajira'),
    empresa_telefono: db.config('empresa_telefono', ''),
    empresa_representante: db.config('empresa_representante', ''),
    prefijo_remision: db.config('prefijo_remision', 'R'),
  }));

  R('PUT', '/api/ajustes', ['admin'], ({ body, usuario }) => {
    for (const k of ['empresa_nombre', 'empresa_nit', 'empresa_direccion', 'empresa_telefono', 'empresa_representante']) {
      if (body[k] !== undefined) db.setConfig(k, txt(body[k], 200) || '');
    }
    if (body.prefijo_remision !== undefined) {
      const p = String(body.prefijo_remision).trim().toUpperCase();
      if (!/^[A-Z0-9]{1,6}$/.test(p)) throw err(400, 'El prefijo debe tener de 1 a 6 letras o números.');
      db.setConfig('prefijo_remision', p);
    }
    db.auditar(usuario.usuario, 'ajustes_editados', null);
    return { ok: true };
  });

  R('GET', '/api/ajustes-publicos', null, () => ({
    empresa_nombre: db.config('empresa_nombre', 'DISTRIMOS S.A.S'),
    empresa_nit: db.config('empresa_nit', ''),
    empresa_direccion: db.config('empresa_direccion', 'Maicao, La Guajira'),
    empresa_telefono: db.config('empresa_telefono', ''),
    empresa_representante: db.config('empresa_representante', ''),
  }));

  // ------------------------------------------------ datos de demostración
  R('POST', '/api/demo', ['admin'], ({ usuario }) => {
    if (db.uno('SELECT COUNT(*) AS n FROM clientes').n > 0) throw err(400, 'Ya hay clientes registrados; los datos de ejemplo solo se cargan en un sistema vacío.');
    require('./demo').cargarDemo(db, usuario);
    db.auditar(usuario.usuario, 'datos_demo', 'Datos de demostración cargados');
    return { ok: true };
  });

  // ------------------------------------------------ sincronización (lado central)
  require('./sync').registrarRutasSync(R, ctxGlobal);

  return api;
}

module.exports = { crearApi, avanceContrato, cargarRemision };
