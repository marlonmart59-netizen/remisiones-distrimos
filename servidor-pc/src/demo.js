'use strict';
/**
 * Datos de demostración para capacitación y pruebas (nombres ficticios).
 * Se cargan solo en un sistema vacío, desde Ajustes > Datos de ejemplo.
 */
const zlib = require('node:zlib');
const { ahora, uuid } = require('./db');
const { hashClave } = require('./seguridad');

/** Genera un PNG con un trazo tipo firma (sin librerías). */
function firmaPng(semilla) {
  const w = 320; const h = 120;
  const px = Buffer.alloc(w * h, 255);
  const punto = (x, y) => {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const xx = Math.round(x) + dx; const yy = Math.round(y) + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) px[yy * w + xx] = 20;
    }
  };
  for (let t = 0; t < 1; t += 0.0008) {
    const x = 20 + t * 280;
    const y = 60 + Math.sin(t * (9 + semilla)) * 28 * Math.cos(t * 3 + semilla) + Math.sin(t * 40) * 6;
    punto(x, y);
  }
  const filas = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) { filas[y * (w + 1)] = 0; px.copy(filas, y * (w + 1) + 1, y * w, (y + 1) * w); }
  const crcTabla = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTabla[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const bloque = (tipo, datos) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(datos.length);
    const td = Buffer.concat([Buffer.from(tipo), datos]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([l, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), bloque('IHDR', ihdr), bloque('IDAT', zlib.deflateSync(filas)), bloque('IEND', Buffer.alloc(0))]);
}

function cargarDemo(db, admin) {
  const t = ahora();
  const fecha = (diasAtras) => { const d = new Date(Date.now() - diasAtras * 864e5); return d.toISOString().slice(0, 10); };
  db.transaccion(() => {
    db.setConfig('empresa_nit', '900.000.000-0');
    db.setConfig('empresa_direccion', 'Calle 12 # 10-00, Maicao, La Guajira');

    const clientes = [
      { id: uuid(), nombre: 'Fundación Semillas del Desierto', nit: '901.111.222-3', tipo: 'fundacion', representante: 'Ana Pushaina', telefono: '300 000 0001', municipio: 'Uribia', direccion: 'Barrio Centro, Uribia' },
      { id: uuid(), nombre: 'Fundación Niñez Wayuu', nit: '901.333.444-5', tipo: 'fundacion', representante: 'Carlos Epieyú', telefono: '300 000 0002', municipio: 'Riohacha', direccion: 'Av. La Marina, Riohacha' },
      { id: uuid(), nombre: 'Institución Educativa Ejemplo', nit: '800.555.666-7', tipo: 'colegio', representante: 'Luz Uriana', telefono: '300 000 0003', municipio: 'Maicao', direccion: 'Calle 15, Maicao' },
    ];
    for (const c of clientes) db.upsert('clientes', Object.keys({ ...c, autoriza_datos: 1, actualizado_en: t }), { ...c, autoriza_datos: 1, actualizado_en: t });

    const productos = [
      { id: uuid(), codigo: 'MOR-01', nombre: 'Morral escolar básico', unidad: 'unidad', precio: 38000 },
      { id: uuid(), codigo: 'KIT-PRI', nombre: 'Kit escolar primaria', unidad: 'kit', precio: 52000 },
      { id: uuid(), codigo: 'KIT-BAC', nombre: 'Kit escolar bachillerato', unidad: 'kit', precio: 61000 },
      { id: uuid(), codigo: 'BOL-01', nombre: 'Bolso de tela estampado', unidad: 'unidad', precio: 18000 },
    ];
    for (const p of productos) db.upsert('productos', [...Object.keys(p), 'actualizado_en'], { ...p, actualizado_en: t });

    const contratos = [
      { id: uuid(), codigo: 'CT-2026-001', cliente_id: clientes[0].id, objeto: 'Suministro de kits escolares y morrales para la vigencia 2026', fecha_inicio: fecha(60), fecha_fin: fecha(-120), items: [[1, 5000], [0, 2000]] },
      { id: uuid(), codigo: 'CT-2026-002', cliente_id: clientes[1].id, objeto: 'Kits de bachillerato y bolsos para programa de nutrición escolar', fecha_inicio: fecha(40), fecha_fin: fecha(-90), items: [[2, 3000], [3, 6000]] },
      { id: uuid(), codigo: 'CT-2026-003', cliente_id: clientes[2].id, objeto: 'Morrales para estudiantes de primaria', fecha_inicio: fecha(20), fecha_fin: fecha(-60), items: [[0, 800]] },
    ];
    for (const c of contratos) {
      db.ejecutar('INSERT INTO contratos(id, codigo, cliente_id, objeto, fecha_inicio, fecha_fin, estado, actualizado_en) VALUES (?,?,?,?,?,?,?,?)',
        c.id, c.codigo, c.cliente_id, c.objeto, c.fecha_inicio, c.fecha_fin, 'activo', t);
      for (const [pi, cant] of c.items) {
        db.ejecutar('INSERT INTO contrato_items(id, contrato_id, producto_id, cantidad, precio_unitario) VALUES (?,?,?,?,?)', uuid(), c.id, productos[pi].id, cant, productos[pi].precio);
      }
    }

    const usuarios = [
      { usuario: 'gerente', nombre: 'Gerente General', rol: 'gerente' },
      { usuario: 'secretaria', nombre: 'Secretaría Administrativa', rol: 'secretario' },
      { usuario: 'repartidor1', nombre: 'Repartidor Ruta Uribia', rol: 'repartidor' },
      { usuario: 'repartidor2', nombre: 'Repartidor Ruta Riohacha', rol: 'repartidor' },
      { usuario: 'cliente1', nombre: 'Fundación Semillas (consulta)', rol: 'cliente', cliente_id: clientes[0].id },
    ].map((u) => ({ id: uuid(), cliente_id: null, ...u }));
    const hash = hashClave('demo123');
    for (const u of usuarios) {
      db.ejecutar(`INSERT INTO usuarios(id, usuario, nombre, rol, cliente_id, clave_hash, activo, debe_cambiar_clave, creado_en, actualizado_en)
        VALUES (?,?,?,?,?,?,1,0,?,?)`, u.id, u.usuario, u.nombre, u.rol, u.cliente_id, hash, t, t);
    }
    const [, secre, rep1, rep2] = usuarios;

    const prefijo = db.config('prefijo_remision', 'R');
    let n = Number(db.config('consecutivo_remision', '0'));
    const remisiones = [
      { c: 0, rep: rep1, dias: 18, items: [[1, 1200], [0, 400]], entregada: true },
      { c: 0, rep: rep1, dias: 11, items: [[1, 900]], entregada: true },
      { c: 1, rep: rep2, dias: 9, items: [[2, 700], [3, 1500]], entregada: true },
      { c: 2, rep: rep1, dias: 4, items: [[0, 300]], entregada: true },
      { c: 1, rep: rep2, dias: 1, items: [[3, 1000]], entregada: false },
      { c: 0, rep: rep1, dias: 0, items: [[1, 600], [0, 300]], entregada: false },
    ];
    remisiones.forEach((r, k) => {
      const id = uuid();
      const c = contratos[r.c];
      const cl = clientes.find((x) => x.id === c.cliente_id);
      n += 1;
      const creado = new Date(Date.now() - r.dias * 864e5).toISOString();
      const entregada = r.entregada ? new Date(Date.now() - r.dias * 864e5 + 5 * 3600e3).toISOString() : null;
      db.ejecutar(`INSERT INTO remisiones(id, numero, contrato_id, cliente_id, repartidor_id, fecha, municipio, direccion_entrega, observaciones, estado,
        creado_por, creado_en, actualizado_en, entregada_en, receptor_nombre, receptor_documento, origen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pc')`,
      id, `${prefijo}-${String(n).padStart(5, '0')}`, c.id, cl.id, r.rep.id, fecha(r.dias), cl.municipio, cl.direccion, 'Entrega parcial del contrato',
      r.entregada ? 'entregada' : 'pendiente', secre.id, creado, t, entregada, r.entregada ? cl.representante : null, r.entregada ? '1.000.000' : null);
      for (const [pi, cant] of r.items) {
        db.ejecutar('INSERT INTO remision_items(id, remision_id, producto_id, descripcion, cantidad, precio_unitario) VALUES (?,?,?,?,?,?)',
          uuid(), id, productos[pi].id, productos[pi].nombre, cant, productos[pi].precio);
      }
      db.ejecutar('INSERT INTO remision_historial(id, remision_id, fecha, usuario_id, usuario_nombre, accion) VALUES (?,?,?,?,?,?)', uuid(), id, creado, secre.id, secre.nombre, 'creada');
      if (r.entregada) {
        db.ejecutar('INSERT INTO evidencias(id, remision_id, tipo, mime, datos, tomada_en) VALUES (?,?,?,?,?,?)', uuid(), id, 'firma', 'image/png', firmaPng(k + 1), entregada);
        db.ejecutar('INSERT INTO remision_historial(id, remision_id, fecha, usuario_id, usuario_nombre, accion) VALUES (?,?,?,?,?,?)', uuid(), id, entregada, r.rep.id, r.rep.nombre, 'entregada');
      }
    });
    db.setConfig('consecutivo_remision', n);

  });
}

module.exports = { cargarDemo, firmaPng };
