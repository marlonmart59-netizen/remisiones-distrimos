'use strict';
/**
 * Capa de datos del servidor PC.
 * Usa SQLite integrado en Node.js (node:sqlite), sin dependencias nativas externas.
 * El mismo esquema se replica en el servidor de la app móvil (Dart) para que la
 * sincronización intercambie registros idénticos.
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS config (
  clave TEXT PRIMARY KEY,
  valor TEXT
);

CREATE TABLE IF NOT EXISTS usuarios (
  id TEXT PRIMARY KEY,
  usuario TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nombre TEXT NOT NULL,
  rol TEXT NOT NULL CHECK (rol IN ('admin','gerente','secretario','repartidor','cliente')),
  cliente_id TEXT,
  clave_hash TEXT NOT NULL,
  activo INTEGER NOT NULL DEFAULT 1,
  debe_cambiar_clave INTEGER NOT NULL DEFAULT 0,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clientes (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  nit TEXT,
  tipo TEXT NOT NULL DEFAULT 'privado',
  representante TEXT,
  telefono TEXT,
  email TEXT,
  direccion TEXT,
  municipio TEXT,
  autoriza_datos INTEGER NOT NULL DEFAULT 0,
  activo INTEGER NOT NULL DEFAULT 1,
  actualizado_en TEXT NOT NULL,
  pendiente_sync INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS productos (
  id TEXT PRIMARY KEY,
  codigo TEXT,
  nombre TEXT NOT NULL,
  unidad TEXT NOT NULL DEFAULT 'unidad',
  precio REAL NOT NULL DEFAULT 0,
  activo INTEGER NOT NULL DEFAULT 1,
  actualizado_en TEXT NOT NULL,
  pendiente_sync INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contratos (
  id TEXT PRIMARY KEY,
  codigo TEXT NOT NULL,
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  objeto TEXT,
  fecha_inicio TEXT,
  fecha_fin TEXT,
  estado TEXT NOT NULL DEFAULT 'activo',
  actualizado_en TEXT NOT NULL,
  pendiente_sync INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contrato_items (
  id TEXT PRIMARY KEY,
  contrato_id TEXT NOT NULL REFERENCES contratos(id) ON DELETE CASCADE,
  producto_id TEXT NOT NULL REFERENCES productos(id),
  cantidad REAL NOT NULL,
  precio_unitario REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS remisiones (
  id TEXT PRIMARY KEY,
  numero TEXT NOT NULL UNIQUE,
  contrato_id TEXT REFERENCES contratos(id),
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  repartidor_id TEXT REFERENCES usuarios(id),
  fecha TEXT NOT NULL,
  municipio TEXT,
  direccion_entrega TEXT,
  observaciones TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','entregada','anulada')),
  editada INTEGER NOT NULL DEFAULT 0,
  creado_por TEXT,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  entregada_en TEXT,
  receptor_nombre TEXT,
  receptor_documento TEXT,
  observaciones_entrega TEXT,
  motivo_anulacion TEXT,
  origen TEXT NOT NULL DEFAULT 'pc',
  pendiente_sync INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS remision_items (
  id TEXT PRIMARY KEY,
  remision_id TEXT NOT NULL REFERENCES remisiones(id) ON DELETE CASCADE,
  producto_id TEXT REFERENCES productos(id),
  descripcion TEXT NOT NULL,
  cantidad REAL NOT NULL,
  precio_unitario REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS evidencias (
  id TEXT PRIMARY KEY,
  remision_id TEXT NOT NULL REFERENCES remisiones(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('firma','foto')),
  mime TEXT NOT NULL,
  datos BLOB NOT NULL,
  tomada_en TEXT NOT NULL,
  rol TEXT NOT NULL DEFAULT 'receptor'
);

CREATE TABLE IF NOT EXISTS remision_historial (
  id TEXT PRIMARY KEY,
  remision_id TEXT NOT NULL REFERENCES remisiones(id) ON DELETE CASCADE,
  fecha TEXT NOT NULL,
  usuario_id TEXT,
  usuario_nombre TEXT,
  accion TEXT NOT NULL,
  motivo TEXT,
  version_anterior TEXT
);

CREATE TABLE IF NOT EXISTS insumos (
  id TEXT PRIMARY KEY,
  codigo TEXT,
  nombre TEXT NOT NULL,
  unidad TEXT NOT NULL DEFAULT 'unidad',
  stock REAL NOT NULL DEFAULT 0,
  stock_minimo REAL NOT NULL DEFAULT 0,
  costo_promedio REAL NOT NULL DEFAULT 0,
  activo INTEGER NOT NULL DEFAULT 1,
  actualizado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS insumo_movimientos (
  id TEXT PRIMARY KEY,
  insumo_id TEXT NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('entrada','salida','ajuste')),
  cantidad REAL NOT NULL,
  costo_unitario REAL NOT NULL DEFAULT 0,
  contrato_id TEXT,
  motivo TEXT,
  usuario_id TEXT,
  usuario_nombre TEXT,
  fecha TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,
  usuario TEXT,
  accion TEXT NOT NULL,
  detalle TEXT
);

CREATE INDEX IF NOT EXISTS ix_remisiones_fecha ON remisiones(fecha);
CREATE INDEX IF NOT EXISTS ix_remisiones_cliente ON remisiones(cliente_id);
CREATE INDEX IF NOT EXISTS ix_remisiones_contrato ON remisiones(contrato_id);
CREATE INDEX IF NOT EXISTS ix_remisiones_act ON remisiones(actualizado_en);
CREATE INDEX IF NOT EXISTS ix_items_remision ON remision_items(remision_id);
CREATE INDEX IF NOT EXISTS ix_evid_remision ON evidencias(remision_id);
CREATE INDEX IF NOT EXISTS ix_hist_remision ON remision_historial(remision_id);
CREATE INDEX IF NOT EXISTS ix_mov_insumo ON insumo_movimientos(insumo_id);
`;

function ahora() {
  return new Date().toISOString();
}

function uuid() {
  return crypto.randomUUID();
}

class BaseDatos {
  constructor(archivo) {
    this.archivo = archivo;
    this.abrir();
  }

  abrir() {
    fs.mkdirSync(path.dirname(this.archivo), { recursive: true });
    this.db = new DatabaseSync(this.archivo);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(ESQUEMA);
    // Migración: quién firmó ('receptor' = quien recibe, 'repartidor' = quien entrega).
    if (!this.db.prepare('PRAGMA table_info(evidencias)').all().some((c) => c.name === 'rol')) {
      this.db.exec("ALTER TABLE evidencias ADD COLUMN rol TEXT NOT NULL DEFAULT 'receptor'");
    }
    this._stmts = new Map();
  }

  cerrar() {
    try { this.db.close(); } catch (_) { /* ya cerrada */ }
    this._stmts = new Map();
  }

  prep(sql) {
    let s = this._stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this._stmts.set(sql, s);
    }
    return s;
  }

  todos(sql, ...p) { return this.prep(sql).all(...p).map(limpiar); }
  uno(sql, ...p) { const r = this.prep(sql).get(...p); return r ? limpiar(r) : null; }
  ejecutar(sql, ...p) { return this.prep(sql).run(...p); }

  transaccion(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch (_) { /* nada */ }
      throw e;
    }
  }

  config(clave, porDefecto = null) {
    const r = this.uno('SELECT valor FROM config WHERE clave = ?', clave);
    return r ? r.valor : porDefecto;
  }

  setConfig(clave, valor) {
    this.ejecutar('INSERT INTO config(clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor', clave, String(valor));
  }

  /** Inserta o actualiza un registro a partir de un objeto, usando solo las columnas permitidas. */
  upsert(tabla, columnas, obj) {
    const cols = columnas.filter((c) => obj[c] !== undefined);
    const valores = cols.map((c) => normalizarValor(obj[c]));
    const sql = `INSERT INTO ${tabla} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})
      ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}`;
    this.ejecutar(sql, ...valores);
  }

  auditar(usuario, accion, detalle) {
    this.ejecutar('INSERT INTO auditoria(fecha, usuario, accion, detalle) VALUES (?, ?, ?, ?)',
      ahora(), usuario || 'sistema', accion, detalle ? String(detalle).slice(0, 1000) : null);
  }

  /** Copia consistente de la base de datos (respaldo en caliente). */
  respaldarEn(destino) {
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    this.db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  }
}

function normalizarValor(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function limpiar(fila) {
  // node:sqlite devuelve objetos con prototipo nulo; los convertimos a objetos normales.
  return Object.assign({}, fila);
}

module.exports = { BaseDatos, ahora, uuid };
