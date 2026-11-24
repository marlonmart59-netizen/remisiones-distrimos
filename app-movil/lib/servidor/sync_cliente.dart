// Sincronización del celular con el servidor PC (servidor central).
//  1. PUSH: envía remisiones creadas/entregadas en el celular (con firma, foto e historial)
//     y los catálogos modificados aquí.
//  2. PULL: descarga usuarios, clientes, productos, contratos y remisiones asignadas.
// Se ejecuta automáticamente cada 3 minutos y después de cada entrega; si no hay señal,
// los datos esperan en el celular sin perderse.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'db.dart';
import 'servidor.dart';

const _colsCliente = ['id', 'nombre', 'nit', 'tipo', 'representante', 'telefono', 'email', 'direccion', 'municipio', 'autoriza_datos', 'activo', 'actualizado_en'];
const _colsProducto = ['id', 'codigo', 'nombre', 'unidad', 'precio', 'activo', 'actualizado_en'];
const _colsContrato = ['id', 'codigo', 'cliente_id', 'objeto', 'fecha_inicio', 'fecha_fin', 'estado', 'actualizado_en'];
const _colsUsuario = ['id', 'usuario', 'nombre', 'rol', 'cliente_id', 'clave_hash', 'activo', 'debe_cambiar_clave', 'creado_en', 'actualizado_en'];
const _colsRemision = [
  'id', 'numero', 'contrato_id', 'cliente_id', 'repartidor_id', 'fecha', 'municipio', 'direccion_entrega', 'observaciones', 'estado', 'editada',
  'creado_por', 'creado_en', 'actualizado_en', 'entregada_en', 'receptor_nombre', 'receptor_documento', 'observaciones_entrega', 'motivo_anulacion', 'origen'
];

Map<String, Object?> _pick(Map m, List<String> cols) => {for (final c in cols) if (m.containsKey(c)) c: m[c]};

class SyncCliente {
  SyncCliente(this.db, this.servidor);
  final BaseDatos db;
  final ServidorMovil servidor;
  Timer? _timer;
  Future<Map<String, Object?>>? _enCurso;

  bool get vinculado => db.config('sync_servidor') != null && db.config('sync_token') != null;

  void iniciarAutomatica() {
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(minutes: 3), (_) {
      if (vinculado) ejecutar().catchError((_) => <String, Object?>{});
    });
    if (vinculado) Future.delayed(const Duration(seconds: 5), () => ejecutar().catchError((_) => <String, Object?>{}));
  }

  void detener() => _timer?.cancel();

  int pendientes() =>
      (db.uno('SELECT COUNT(*) AS n FROM remisiones WHERE pendiente_sync = 1')!['n'] as int) +
      (db.uno('SELECT (SELECT COUNT(*) FROM clientes WHERE pendiente_sync = 1) + (SELECT COUNT(*) FROM productos WHERE pendiente_sync = 1) + (SELECT COUNT(*) FROM contratos WHERE pendiente_sync = 1) AS n')!['n'] as int);

  Map<String, Object?> estado() => {
        'vinculado': vinculado,
        'servidor': db.config('sync_servidor'),
        'usuario_central': db.config('sync_usuario'),
        'ultima_sync': db.config('sync_ultima'),
        'ultimo_error': db.config('sync_error'),
        'pendientes': pendientes(),
        'prefijo': db.config('prefijo_remision'),
        'dispositivo': db.config('dispositivo_id'),
      };

  // ------------------------------------------------------------------ HTTP hacia el servidor central
  Future<Map<String, dynamic>> _http(String metodo, String url, {Object? cuerpo, String? token, Duration limite = const Duration(seconds: 25)}) async {
    final cliente = HttpClient()..connectionTimeout = const Duration(seconds: 8);
    try {
      final req = await cliente.openUrl(metodo, Uri.parse(url)).timeout(limite);
      req.headers.contentType = ContentType.json;
      if (token != null) req.headers.set('Authorization', 'Bearer $token');
      if (cuerpo != null) req.add(utf8.encode(jsonEncode(cuerpo)));
      final res = await req.close().timeout(limite);
      final texto = await res.transform(utf8.decoder).join().timeout(const Duration(seconds: 120));
      Map<String, dynamic> datos = {};
      try {
        final d = jsonDecode(texto);
        if (d is Map<String, dynamic>) datos = d;
      } catch (_) {}
      if (res.statusCode == 401) throw ErrorHttp(401, 'La oficina rechazó la sesión de este celular. Vuelva a vincularlo.');
      if (res.statusCode >= 400) throw ErrorHttp(502, 'Servidor de la oficina: ${datos['error'] ?? 'error ${res.statusCode}'}');
      return datos;
    } on SocketException {
      throw ErrorHttp(503, 'No hay conexión con el servidor de la oficina. Los datos quedan guardados en el celular.');
    } on TimeoutException {
      throw ErrorHttp(504, 'El servidor de la oficina no respondió a tiempo. Se reintentará luego.');
    } on HandshakeException {
      throw ErrorHttp(502, 'No se pudo establecer una conexión segura con el servidor.');
    } finally {
      cliente.close(force: true);
    }
  }

  String _normalizar(String url) {
    var u = url.trim();
    if (!u.startsWith('http://') && !u.startsWith('https://')) u = 'http://$u';
    while (u.endsWith('/')) {
      u = u.substring(0, u.length - 1);
    }
    final uri = Uri.tryParse(u);
    if (uri == null || uri.host.isEmpty) throw ErrorHttp(400, 'La dirección del servidor no es válida.');
    if (!uri.hasPort || uri.port == 0) return u;
    return u;
  }

  // ------------------------------------------------------------------ vinculación
  Future<Map<String, Object?>> vincular({required String servidor, required String usuario, required String clave, String? prefijo}) async {
    final url = _normalizar(servidor);
    final info = await _http('GET', '$url/api/info', limite: const Duration(seconds: 10));
    if (info['modo'] != 'pc' || (info['capacidades'] as Map?)?['sync_central'] != true) {
      throw ErrorHttp(400, 'La dirección no corresponde a un servidor de oficina del Sistema de Remisiones.');
    }
    final login = await _http('POST', '$url/api/auth/login', cuerpo: {'usuario': usuario, 'clave': clave, 'dispositivo': 'Celular ${prefijo ?? db.config('prefijo_remision')}'});
    final u = login['usuario'] as Map<String, dynamic>;
    if (u['rol'] == 'cliente') throw ErrorHttp(403, 'Los usuarios con rol cliente consultan desde el navegador, no vinculan celulares.');
    final cambioServidor = db.config('sync_servidor') != url;
    if (prefijo != null && prefijo.trim().isNotEmpty) {
      final p = prefijo.trim().toUpperCase();
      if (!RegExp(r'^[A-Z0-9]{1,6}$').hasMatch(p)) throw ErrorHttp(400, 'El prefijo debe tener de 1 a 6 letras o números.');
      db.setConfig('prefijo_remision', p);
    }
    db.setConfig('sync_servidor', url);
    db.setConfig('sync_token', login['token']);
    db.setConfig('sync_usuario', u['usuario']);
    db.setConfig('sync_error', null);
    if (cambioServidor) db.setConfig('sync_desde', null);
    db.auditar(usuario, 'celular_vinculado', url);
    final resultado = await ejecutar();
    final local = db.uno('SELECT * FROM usuarios WHERE id = ?', [u['id']]);
    if (local == null) return {'ok': true, 'mensaje': 'Celular vinculado. Inicie sesión con su usuario.'};
    return {
      'ok': true,
      'mensaje': 'Celular vinculado. ${resultado['mensaje']}',
      'token': this.servidor.tokenPara(local),
      'usuario': this.servidor.usuarioPublico(local),
    };
  }

  // ------------------------------------------------------------------ sincronizar
  Future<Map<String, Object?>> ejecutar() {
    if (!vinculado) return Future.error(ErrorHttp(400, 'El celular no está vinculado con la oficina.'));
    return _enCurso ??= _ejecutar().whenComplete(() => _enCurso = null);
  }

  Future<Map<String, Object?>> _ejecutar() async {
    final url = db.config('sync_servidor')!;
    final token = db.config('sync_token')!;
    try {
      // ---------- PUSH
      final remisiones = db.todos('SELECT * FROM remisiones WHERE pendiente_sync = 1');
      final paquete = <String, Object?>{
        'dispositivo': 'Celular ${db.config('prefijo_remision')}',
        'clientes': db.todos('SELECT * FROM clientes WHERE pendiente_sync = 1').map((x) => _pick(x, _colsCliente)).toList(),
        'productos': db.todos('SELECT * FROM productos WHERE pendiente_sync = 1').map((x) => _pick(x, _colsProducto)).toList(),
        'contratos': db.todos('SELECT * FROM contratos WHERE pendiente_sync = 1').map((x) => {
              ..._pick(x, _colsContrato),
              'items': db.todos('SELECT id, contrato_id, producto_id, cantidad, precio_unitario FROM contrato_items WHERE contrato_id = ?', [x['id']]),
            }).toList(),
        'remisiones': remisiones.map((r) => {
              ..._pick(r, _colsRemision),
              'items': db.todos('SELECT id, remision_id, producto_id, descripcion, cantidad, precio_unitario FROM remision_items WHERE remision_id = ?', [r['id']]),
              'evidencias': db.todos('SELECT id, remision_id, tipo, mime, datos, tomada_en, rol FROM evidencias WHERE remision_id = ?', [r['id']]).map((e) => {
                    'id': e['id'], 'remision_id': e['remision_id'], 'tipo': e['tipo'], 'rol': e['rol'], 'mime': e['mime'], 'tomada_en': e['tomada_en'],
                    'datos_b64': base64.encode(e['datos'] as List<int>),
                  }).toList(),
              'historial': db.todos('SELECT * FROM remision_historial WHERE remision_id = ?', [r['id']]),
            }).toList(),
      };
      var enviadas = 0;
      var rechazadas = <dynamic>[];
      final hayPush = remisiones.isNotEmpty || (paquete['clientes'] as List).isNotEmpty || (paquete['productos'] as List).isNotEmpty || (paquete['contratos'] as List).isNotEmpty;
      if (hayPush) {
        final r = await _http('POST', '$url/api/sync/push', cuerpo: paquete, token: token, limite: const Duration(seconds: 90));
        final aceptadas = ((r['aceptadas'] as List?) ?? []).cast<String>();
        rechazadas = (r['rechazadas'] as List?) ?? [];
        db.transaccion(() {
          for (final id in aceptadas) {
            db.ejecutar('UPDATE remisiones SET pendiente_sync = 0 WHERE id = ?', [id]);
          }
          db.ejecutar('UPDATE clientes SET pendiente_sync = 0 WHERE pendiente_sync = 1');
          db.ejecutar('UPDATE productos SET pendiente_sync = 0 WHERE pendiente_sync = 1');
          db.ejecutar('UPDATE contratos SET pendiente_sync = 0 WHERE pendiente_sync = 1');
        });
        enviadas = aceptadas.length;
      }

      // ---------- PULL
      final desde = db.config('sync_desde');
      final p = await _http('GET', '$url/api/sync/pull${desde == null ? '' : '?desde=${Uri.encodeQueryComponent(desde)}'}', token: token, limite: const Duration(seconds: 120));
      var recibidas = 0;
      db.transaccion(() {
        for (final u in (p['usuarios'] as List? ?? []).cast<Map>()) {
          // si existe un usuario local con el mismo nombre pero otro id (p. ej. el admin inicial), se reemplaza
          db.ejecutar('DELETE FROM usuarios WHERE usuario = ? COLLATE NOCASE AND id <> ?', [u['usuario'], u['id']]);
          db.upsert('usuarios', _colsUsuario, _pick(u, _colsUsuario));
        }
        for (final c in (p['clientes'] as List? ?? []).cast<Map>()) {
          db.upsert('clientes', _colsCliente, {..._pick(c, _colsCliente)});
        }
        for (final x in (p['productos'] as List? ?? []).cast<Map>()) {
          db.upsert('productos', _colsProducto, _pick(x, _colsProducto));
        }
        for (final c in (p['contratos'] as List? ?? []).cast<Map>()) {
          db.upsert('contratos', _colsContrato, _pick(c, _colsContrato));
          db.ejecutar('DELETE FROM contrato_items WHERE contrato_id = ?', [c['id']]);
          for (final i in (c['items'] as List? ?? []).cast<Map>()) {
            db.ejecutar('INSERT OR REPLACE INTO contrato_items(id, contrato_id, producto_id, cantidad, precio_unitario) VALUES (?,?,?,?,?)',
                [i['id'], c['id'], i['producto_id'], i['cantidad'], i['precio_unitario']]);
          }
        }
        for (final r in (p['remisiones'] as List? ?? []).cast<Map>()) {
          final local = db.uno('SELECT pendiente_sync, estado FROM remisiones WHERE id = ?', [r['id']]);
          if (local != null && local['pendiente_sync'] == 1) {
            // Cambio local aún sin enviar: se toma el encabezado de la oficina pero se conserva la entrega local.
            db.ejecutar('UPDATE remisiones SET contrato_id = ?, cliente_id = ?, fecha = ?, municipio = ?, direccion_entrega = ?, observaciones = ?, editada = ? WHERE id = ?',
                [r['contrato_id'], r['cliente_id'], r['fecha'], r['municipio'], r['direccion_entrega'], r['observaciones'], r['editada'], r['id']]);
          } else {
            db.ejecutar('DELETE FROM remision_items WHERE remision_id = ?', [r['id']]);
            db.upsert('remisiones', _colsRemision, {..._pick(r, _colsRemision)});
            db.ejecutar('UPDATE remisiones SET pendiente_sync = 0 WHERE id = ?', [r['id']]);
            for (final i in (r['items'] as List? ?? []).cast<Map>()) {
              db.ejecutar('INSERT OR REPLACE INTO remision_items(id, remision_id, producto_id, descripcion, cantidad, precio_unitario) VALUES (?,?,?,?,?,?)',
                  [i['id'], r['id'], i['producto_id'], i['descripcion'], i['cantidad'], i['precio_unitario']]);
            }
          }
          for (final e in (r['evidencias'] as List? ?? []).cast<Map>()) {
            db.ejecutar('INSERT OR IGNORE INTO evidencias(id, remision_id, tipo, mime, datos, tomada_en, rol) VALUES (?,?,?,?,?,?,?)',
                [e['id'], r['id'], e['tipo'], e['mime'], Uint8List.fromList(base64.decode(e['datos_b64'] as String)), e['tomada_en'], e['rol'] == 'repartidor' ? 'repartidor' : 'receptor']);
          }
          for (final h in (r['historial'] as List? ?? []).cast<Map>()) {
            db.ejecutar('INSERT OR IGNORE INTO remision_historial(id, remision_id, fecha, usuario_id, usuario_nombre, accion, motivo, version_anterior) VALUES (?,?,?,?,?,?,?,?)',
                [h['id'], r['id'], h['fecha'], h['usuario_id'], h['usuario_nombre'], h['accion'], h['motivo'], h['version_anterior']]);
          }
          recibidas++;
        }
        for (final id in (p['retiradas'] as List? ?? []).cast<String>()) {
          db.ejecutar('DELETE FROM remisiones WHERE id = ? AND pendiente_sync = 0', [id]);
        }
        final emp = p['empresa'] as Map?;
        if (emp != null) emp.forEach((k, v) => db.setConfig(k as String, v ?? ''));
        db.setConfig('sync_desde', p['servidor_ahora']);
      });

      db.setConfig('sync_ultima', ahora());
      db.setConfig('sync_error', rechazadas.isEmpty ? null : 'La oficina rechazó ${rechazadas.length} remisión(es): ${rechazadas.map((x) => '${x['numero']} (${x['motivo']})').join('; ')}');
      final mensaje = 'Enviadas $enviadas remisión(es); recibidos $recibidas cambio(s) de remisiones.';
      db.auditar(db.config('sync_usuario'), 'sincronizacion', mensaje);
      return {'ok': true, 'enviadas': enviadas, 'recibidas': recibidas, 'rechazadas': rechazadas, 'mensaje': mensaje};
    } on ErrorHttp catch (e) {
      db.setConfig('sync_error', e.mensaje);
      rethrow;
    } catch (e) {
      db.setConfig('sync_error', 'Error al sincronizar: $e');
      throw ErrorHttp(500, 'Error al sincronizar: $e');
    }
  }
}
