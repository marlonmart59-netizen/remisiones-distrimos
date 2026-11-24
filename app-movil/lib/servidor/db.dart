// Base de datos local del celular (SQLite). Esquema idéntico al del servidor PC
// para que la sincronización intercambie registros sin conversiones.
import 'dart:io';
import 'dart:math';

import 'package:sqlite3/sqlite3.dart';

const String esquema = '''
CREATE TABLE IF NOT EXISTS config (clave TEXT PRIMARY KEY, valor TEXT);
CREATE TABLE IF NOT EXISTS usuarios (
  id TEXT PRIMARY KEY, usuario TEXT NOT NULL UNIQUE COLLATE NOCASE, nombre TEXT NOT NULL,
  rol TEXT NOT NULL CHECK (rol IN ('admin','gerente','secretario','repartidor','cliente')),
  cliente_id TEXT, clave_hash TEXT NOT NULL, activo INTEGER NOT NULL DEFAULT 1,
  debe_cambiar_clave INTEGER NOT NULL DEFAULT 0, creado_en TEXT NOT NULL, actualizado_en TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS clientes (
  id TEXT PRIMARY KEY, nombre TEXT NOT NULL, nit TEXT, tipo TEXT NOT NULL DEFAULT 'privado', representante TEXT,
  telefono TEXT, email TEXT, direccion TEXT, municipio TEXT, autoriza_datos INTEGER NOT NULL DEFAULT 0,
  activo INTEGER NOT NULL DEFAULT 1, actualizado_en TEXT NOT NULL, pendiente_sync INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS productos (
  id TEXT PRIMARY KEY, codigo TEXT, nombre TEXT NOT NULL, unidad TEXT NOT NULL DEFAULT 'unidad',
  precio REAL NOT NULL DEFAULT 0, activo INTEGER NOT NULL DEFAULT 1, actualizado_en TEXT NOT NULL,
  pendiente_sync INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS contratos (
  id TEXT PRIMARY KEY, codigo TEXT NOT NULL, cliente_id TEXT NOT NULL, objeto TEXT, fecha_inicio TEXT,
  fecha_fin TEXT, estado TEXT NOT NULL DEFAULT 'activo', actualizado_en TEXT NOT NULL,
  pendiente_sync INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS contrato_items (
  id TEXT PRIMARY KEY, contrato_id TEXT NOT NULL REFERENCES contratos(id) ON DELETE CASCADE,
  producto_id TEXT NOT NULL, cantidad REAL NOT NULL, precio_unitario REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS remisiones (
  id TEXT PRIMARY KEY, numero TEXT NOT NULL UNIQUE, contrato_id TEXT, cliente_id TEXT NOT NULL,
  repartidor_id TEXT, fecha TEXT NOT NULL, municipio TEXT, direccion_entrega TEXT, observaciones TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','entregada','anulada')),
  editada INTEGER NOT NULL DEFAULT 0, creado_por TEXT, creado_en TEXT NOT NULL, actualizado_en TEXT NOT NULL,
  entregada_en TEXT, receptor_nombre TEXT, receptor_documento TEXT, observaciones_entrega TEXT,
  motivo_anulacion TEXT, origen TEXT NOT NULL DEFAULT 'pc', pendiente_sync INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS remision_items (
  id TEXT PRIMARY KEY, remision_id TEXT NOT NULL REFERENCES remisiones(id) ON DELETE CASCADE,
  producto_id TEXT, descripcion TEXT NOT NULL, cantidad REAL NOT NULL, precio_unitario REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS evidencias (
  id TEXT PRIMARY KEY, remision_id TEXT NOT NULL REFERENCES remisiones(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('firma','foto')), mime TEXT NOT NULL, datos BLOB NOT NULL, tomada_en TEXT NOT NULL,
  rol TEXT NOT NULL DEFAULT 'receptor');
CREATE TABLE IF NOT EXISTS remision_historial (
  id TEXT PRIMARY KEY, remision_id TEXT NOT NULL REFERENCES remisiones(id) ON DELETE CASCADE, fecha TEXT NOT NULL,
  usuario_id TEXT, usuario_nombre TEXT, accion TEXT NOT NULL, motivo TEXT, version_anterior TEXT);
CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT NOT NULL, usuario TEXT, accion TEXT NOT NULL, detalle TEXT);
CREATE INDEX IF NOT EXISTS ix_remisiones_fecha ON remisiones(fecha);
CREATE INDEX IF NOT EXISTS ix_items_remision ON remision_items(remision_id);
CREATE INDEX IF NOT EXISTS ix_evid_remision ON evidencias(remision_id);
CREATE INDEX IF NOT EXISTS ix_hist_remision ON remision_historial(remision_id);
''';

/// Fecha-hora UTC en ISO 8601 con milisegundos (mismo formato que Node.js).
String ahora() => DateTime.fromMillisecondsSinceEpoch(DateTime.now().millisecondsSinceEpoch, isUtc: true).toIso8601String();

String hoyLocal() {
  final d = DateTime.now();
  return '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
}

final Random _rnd = Random.secure();

String uuid() {
  final b = List<int>.generate(16, (_) => _rnd.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}

typedef Fila = Map<String, Object?>;

class BaseDatos {
  BaseDatos(this.archivo) {
    Directory(File(archivo).parent.path).createSync(recursive: true);
    db = sqlite3.open(archivo);
    db.execute('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    db.execute(esquema);
    // Migración: quién firmó ('receptor' = quien recibe, 'repartidor' = quien entrega).
    if (!db.select('PRAGMA table_info(evidencias)').any((c) => c['name'] == 'rol')) {
      db.execute("ALTER TABLE evidencias ADD COLUMN rol TEXT NOT NULL DEFAULT 'receptor'");
    }
  }

  final String archivo;
  late final Database db;

  List<Object?> _p(List<Object?> p) => p.map((v) => v is bool ? (v ? 1 : 0) : v).toList();

  List<Fila> todos(String sql, [List<Object?> p = const []]) =>
      db.select(sql, _p(p)).map((r) => Map<String, Object?>.from(r)).toList();

  Fila? uno(String sql, [List<Object?> p = const []]) {
    final r = db.select(sql, _p(p));
    return r.isEmpty ? null : Map<String, Object?>.from(r.first);
  }

  void ejecutar(String sql, [List<Object?> p = const []]) => db.execute(sql, _p(p));

  T transaccion<T>(T Function() fn) {
    db.execute('BEGIN');
    try {
      final r = fn();
      db.execute('COMMIT');
      return r;
    } catch (_) {
      try {
        db.execute('ROLLBACK');
      } catch (_) {}
      rethrow;
    }
  }

  String? config(String clave, [String? porDefecto]) {
    final r = uno('SELECT valor FROM config WHERE clave = ?', [clave]);
    return r == null ? porDefecto : r['valor'] as String?;
  }

  void setConfig(String clave, Object? valor) {
    if (valor == null) {
      ejecutar('DELETE FROM config WHERE clave = ?', [clave]);
      return;
    }
    ejecutar('INSERT INTO config(clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor', [clave, '$valor']);
  }

  void upsert(String tabla, List<String> columnas, Map<String, Object?> obj) {
    final cols = columnas.where((c) => obj.containsKey(c)).toList();
    final sets = cols.where((c) => c != 'id').map((c) => '$c = excluded.$c').join(', ');
    ejecutar('INSERT INTO $tabla (${cols.join(',')}) VALUES (${cols.map((_) => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET $sets',
        cols.map((c) => obj[c]).toList());
  }

  void auditar(String? usuario, String accion, [String? detalle]) {
    ejecutar('INSERT INTO auditoria(fecha, usuario, accion, detalle) VALUES (?, ?, ?, ?)', [
      ahora(),
      usuario ?? 'sistema',
      accion,
      detalle == null ? null : (detalle.length > 1000 ? detalle.substring(0, 1000) : detalle),
    ]);
  }

  void cerrar() => db.close();
}
