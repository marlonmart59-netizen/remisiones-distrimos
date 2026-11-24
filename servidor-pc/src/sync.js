'use strict';
/**
 * Sincronización: el servidor PC actúa como servidor central.
 * Los celulares (cada uno con su propio servidor local) envían lo que registraron
 * sin conexión (push) y descargan los cambios del central (pull).
 *
 * Reglas de fusión en el central:
 *  - Clientes, productos y contratos: gana la versión más reciente (actualizado_en).
 *    Solo usuarios admin/secretario pueden enviar cambios de catálogo.
 *  - Remisiones nuevas: se insertan completas (encabezado, ítems, evidencias, historial).
 *  - Remisiones existentes: el celular solo aporta la ENTREGA (estado, receptor, firma, foto).
 *    Las ediciones de encabezado/ítems solo las hace el secretario en el central.
 */
const { ahora } = require('./db');
const { err } = require('./http');

const COLS_CLIENTE = ['id', 'nombre', 'nit', 'tipo', 'representante', 'telefono', 'email', 'direccion', 'municipio', 'autoriza_datos', 'activo', 'actualizado_en'];
const COLS_PRODUCTO = ['id', 'codigo', 'nombre', 'unidad', 'precio', 'activo', 'actualizado_en'];
const COLS_CONTRATO = ['id', 'codigo', 'cliente_id', 'objeto', 'fecha_inicio', 'fecha_fin', 'estado', 'actualizado_en'];
const COLS_REMISION = ['id', 'numero', 'contrato_id', 'cliente_id', 'repartidor_id', 'fecha', 'municipio', 'direccion_entrega', 'observaciones', 'estado',
  'editada', 'creado_por', 'creado_en', 'actualizado_en', 'entregada_en', 'receptor_nombre', 'receptor_documento', 'observaciones_entrega', 'motivo_anulacion', 'origen'];

function pick(obj, cols) {
  const o = {};
  for (const c of cols) if (obj[c] !== undefined) o[c] = obj[c];
  return o;
}

function registrarRutasSync(R, ctx) {
  const { db } = ctx;

  /** Descarga de cambios desde `desde` (marca de tiempo del servidor central). */
  R('GET', '/api/sync/pull', ['admin', 'gerente', 'secretario', 'repartidor'], ({ usuario, query }) => {
    const desde = query.desde || '1970-01-01T00:00:00.000Z';
    const servidor_ahora = ahora();
    const usuarios = db.todos('SELECT id, usuario, nombre, rol, cliente_id, clave_hash, activo, debe_cambiar_clave, creado_en, actualizado_en FROM usuarios WHERE actualizado_en >= ?', desde)
      .filter((u) => u.rol !== 'cliente');
    const clientes = db.todos('SELECT * FROM clientes WHERE actualizado_en >= ?', desde);
    const productos = db.todos('SELECT * FROM productos WHERE actualizado_en >= ?', desde);
    const contratos = db.todos('SELECT * FROM contratos WHERE actualizado_en >= ?', desde).map((c) => ({
      ...c, items: db.todos('SELECT id, contrato_id, producto_id, cantidad, precio_unitario FROM contrato_items WHERE contrato_id = ?', c.id),
    }));
    let sqlR = 'SELECT * FROM remisiones WHERE actualizado_en >= ?';
    const pR = [desde];
    if (usuario.rol === 'repartidor') { sqlR += ' AND (repartidor_id = ? OR creado_por = ?)'; pR.push(usuario.id, usuario.id); }
    const remisiones = db.todos(sqlR, ...pR).map((r) => ({
      ...r,
      items: db.todos('SELECT id, remision_id, producto_id, descripcion, cantidad, precio_unitario FROM remision_items WHERE remision_id = ?', r.id),
      evidencias: db.todos('SELECT id, remision_id, tipo, mime, datos, tomada_en, rol FROM evidencias WHERE remision_id = ?', r.id)
        .map((e) => ({ id: e.id, remision_id: e.remision_id, tipo: e.tipo, rol: e.rol, mime: e.mime, tomada_en: e.tomada_en, datos_b64: Buffer.from(e.datos).toString('base64') })),
      historial: db.todos('SELECT * FROM remision_historial WHERE remision_id = ?', r.id),
    }));
    // Si al repartidor le quitaron una remisión, se le informa para que la retire de su celular.
    let retiradas = [];
    if (usuario.rol === 'repartidor') {
      retiradas = db.todos('SELECT id FROM remisiones WHERE actualizado_en >= ? AND repartidor_id IS NOT NULL AND repartidor_id <> ? AND creado_por <> ?', desde, usuario.id, usuario.id).map((x) => x.id);
    }
    return { servidor_ahora, usuarios, clientes, productos, contratos, remisiones, retiradas, empresa: {
      empresa_nombre: db.config('empresa_nombre', 'DISTRIMOS S.A.S'), empresa_nit: db.config('empresa_nit', ''),
      empresa_direccion: db.config('empresa_direccion', 'Maicao, La Guajira'), empresa_telefono: db.config('empresa_telefono', ''),
      empresa_representante: db.config('empresa_representante', ''),
    } };
  });

  /** Recepción de lo registrado en el celular. */
  R('POST', '/api/sync/push', ['admin', 'gerente', 'secretario', 'repartidor'], ({ usuario, body }) => {
    const dispositivo = String(body.dispositivo || 'movil').slice(0, 60);
    const t = ahora();
    const res = { clientes: 0, productos: 0, contratos: 0, remisiones_nuevas: 0, entregas: 0, aceptadas: [], rechazadas: [] };
    const puedeCatalogo = ['admin', 'secretario'].includes(usuario.rol);

    db.transaccion(() => {
      if (puedeCatalogo) {
        for (const c of body.clientes || []) {
          const ex = db.uno('SELECT actualizado_en FROM clientes WHERE id = ?', c.id);
          if (!ex || String(c.actualizado_en) > ex.actualizado_en) {
            db.upsert('clientes', COLS_CLIENTE, { ...pick(c, COLS_CLIENTE), actualizado_en: t });
            res.clientes++;
          }
        }
        for (const p of body.productos || []) {
          const ex = db.uno('SELECT actualizado_en FROM productos WHERE id = ?', p.id);
          if (!ex || String(p.actualizado_en) > ex.actualizado_en) {
            db.upsert('productos', COLS_PRODUCTO, { ...pick(p, COLS_PRODUCTO), actualizado_en: t });
            res.productos++;
          }
        }
        for (const c of body.contratos || []) {
          const ex = db.uno('SELECT actualizado_en FROM contratos WHERE id = ?', c.id);
          if (!ex || String(c.actualizado_en) > ex.actualizado_en) {
            db.upsert('contratos', COLS_CONTRATO, { ...pick(c, COLS_CONTRATO), actualizado_en: t });
            db.ejecutar('DELETE FROM contrato_items WHERE contrato_id = ?', c.id);
            for (const i of c.items || []) {
              db.ejecutar('INSERT INTO contrato_items(id, contrato_id, producto_id, cantidad, precio_unitario) VALUES (?,?,?,?,?)', i.id, c.id, i.producto_id, i.cantidad, i.precio_unitario);
            }
            res.contratos++;
          }
        }
      }

      for (const r of body.remisiones || []) {
        try {
          db.ejecutar('SAVEPOINT rem');
          if (usuario.rol === 'repartidor' && r.repartidor_id !== usuario.id && r.creado_por !== usuario.id) throw err(403, 'Remisión de otro repartidor');
          const ex = db.uno('SELECT * FROM remisiones WHERE id = ?', r.id);
          if (!ex) {
            if (!db.uno('SELECT id FROM clientes WHERE id = ?', r.cliente_id)) throw err(400, 'Cliente desconocido en el servidor central');
            let numero = r.numero;
            let k = 1;
            while (db.uno('SELECT 1 AS x FROM remisiones WHERE numero = ?', numero)) { numero = `${r.numero}-${++k}`; }
            db.upsert('remisiones', COLS_REMISION, { ...pick(r, COLS_REMISION), numero, origen: r.origen || dispositivo, actualizado_en: t });
            for (const i of r.items || []) {
              db.ejecutar('INSERT OR IGNORE INTO remision_items(id, remision_id, producto_id, descripcion, cantidad, precio_unitario) VALUES (?,?,?,?,?,?)',
                i.id, r.id, i.producto_id, i.descripcion, i.cantidad, i.precio_unitario);
            }
            res.remisiones_nuevas++;
          } else if (r.estado === 'entregada' && ex.estado === 'pendiente') {
            db.ejecutar(`UPDATE remisiones SET estado = 'entregada', entregada_en = ?, receptor_nombre = ?, receptor_documento = ?, observaciones_entrega = ?,
              repartidor_id = COALESCE(repartidor_id, ?), actualizado_en = ? WHERE id = ?`,
            r.entregada_en, r.receptor_nombre, r.receptor_documento, r.observaciones_entrega, r.repartidor_id || null, t, r.id);
            res.entregas++;
          } else if (r.estado === 'entregada' && ex.estado === 'anulada') {
            // Se entregó en ruta algo que la oficina anuló mientras tanto: se conserva la evidencia y se deja constancia.
            db.ejecutar(`INSERT INTO remision_historial(id, remision_id, fecha, usuario_id, usuario_nombre, accion, motivo)
              VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, 'conflicto', ?)`, r.id, t, usuario.id, usuario.nombre,
            `El repartidor registró la entrega el ${r.entregada_en} a ${r.receptor_nombre}, pero la remisión estaba anulada en la oficina.`);
            db.ejecutar('UPDATE remisiones SET actualizado_en = ? WHERE id = ?', t, r.id);
          }
          for (const e of r.evidencias || []) {
            if (!e.datos_b64) continue;
            db.ejecutar('INSERT OR IGNORE INTO evidencias(id, remision_id, tipo, mime, datos, tomada_en, rol) VALUES (?,?,?,?,?,?,?)',
              e.id, r.id, e.tipo, e.mime, Buffer.from(e.datos_b64, 'base64'), e.tomada_en, e.rol === 'repartidor' ? 'repartidor' : 'receptor');
          }
          for (const h of r.historial || []) {
            db.ejecutar(`INSERT OR IGNORE INTO remision_historial(id, remision_id, fecha, usuario_id, usuario_nombre, accion, motivo, version_anterior)
              VALUES (?,?,?,?,?,?,?,?)`, h.id, r.id, h.fecha, h.usuario_id, h.usuario_nombre, h.accion, h.motivo, h.version_anterior);
          }
          db.ejecutar('RELEASE rem');
          res.aceptadas.push(r.id);
        } catch (e) {
          db.ejecutar('ROLLBACK TO rem');
          db.ejecutar('RELEASE rem');
          res.rechazadas.push({ id: r.id, numero: r.numero, motivo: e.message });
        }
      }
    });

    db.auditar(usuario.usuario, 'sincronizacion', `${dispositivo}: ${res.remisiones_nuevas} nuevas, ${res.entregas} entregas, ${res.rechazadas.length} rechazadas`);
    return { ...res, servidor_ahora: t };
  });
}

module.exports = { registrarRutasSync };
