// Servidor HTTP propio de la app Android.
// Expone la misma API REST que el servidor PC (subconjunto para el trabajo de campo)
// y sirve la interfaz web empaquetada en la APK. Todo funciona sin internet;
// la sincronización con la oficina está en sync_cliente.dart.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'db.dart';
import 'seguridad.dart';
import 'sync_cliente.dart';

typedef LectorEstatico = Future<List<int>?> Function(String ruta);

class ErrorHttp implements Exception {
  ErrorHttp(this.estado, this.mensaje);
  final int estado;
  final String mensaje;
  @override
  String toString() => mensaje;
}

class Binario {
  Binario(this.tipo, this.datos, [this.cabeceras = const {}]);
  final String tipo;
  final List<int> datos;
  final Map<String, String> cabeceras;
}

class Ctx {
  Ctx(this.req, this.params, this.query, this.body, this.usuario);
  final HttpRequest req;
  final Map<String, String> params;
  final Map<String, String> query;
  final Map<String, dynamic> body;
  final Fila? usuario;
  Fila get u => usuario!;
  String get uid => usuario!['id'] as String;
  String get rol => usuario!['rol'] as String;
}

typedef Manejador = FutureOr<Object?> Function(Ctx c);

class _Ruta {
  _Ruta(this.metodo, this.regex, this.nombres, this.roles, this.fn);
  final String metodo;
  final RegExp regex;
  final List<String> nombres;
  final Object? roles; // null = público, '*' = autenticado, List<String> = roles
  final Manejador fn;
}

const _internos = ['admin', 'gerente', 'secretario', 'repartidor'];
const _oficina = ['admin', 'gerente', 'secretario'];
const _editores = ['secretario'];

// ------------------------------------------------------------------ utilidades
String? txt(Object? v, [int max = 300]) {
  if (v == null) return null;
  final s = '$v'.trim();
  if (s.isEmpty) return null;
  return s.length > max ? s.substring(0, max) : s;
}

double numero(Object? v, [double def = 0]) {
  if (v is num) return v.toDouble();
  if (v is String) return double.tryParse(v.trim()) ?? def;
  return def;
}

T req<T>(T? v, String nombre) {
  if (v == null || (v is String && v.isEmpty)) throw ErrorHttp(400, 'El campo "$nombre" es obligatorio.');
  return v;
}

bool verdad(Object? v) => v == true || v == 1 || v == '1' || v == 'true' || v == 'on';

double _d(Object? v) => v is num ? v.toDouble() : 0;

class ServidorMovil {
  ServidorMovil({required this.db, required this.lectorEstatico, this.puerto = 8765, this.version = '1.0.0'}) {
    if (db.config('secreto') == null) db.setConfig('secreto', secretoAleatorio());
    if (db.config('dispositivo_id') == null) db.setConfig('dispositivo_id', uuid());
    if (db.config('prefijo_remision') == null) {
      db.setConfig('prefijo_remision', 'M${db.config('dispositivo_id')!.substring(0, 3).toUpperCase()}');
    }
    secreto = db.config('secreto')!;
    sync = SyncCliente(db, this);
    _registrarRutas();
  }

  final BaseDatos db;
  final LectorEstatico lectorEstatico;
  final int puerto;
  final String version;
  late final String secreto;
  late final SyncCliente sync;
  HttpServer? _http;
  final List<_Ruta> _rutas = [];
  final Map<String, (int, int)> _fallidos = {};

  /// Crea el usuario administrador local si el celular no tiene usuarios.
  Future<void> prepararUsuarios() async {
    if (db.uno('SELECT id FROM usuarios LIMIT 1') == null) {
      final t = ahora();
      db.ejecutar(
          "INSERT INTO usuarios(id, usuario, nombre, rol, clave_hash, activo, debe_cambiar_clave, creado_en, actualizado_en) VALUES (?, 'admin', 'Administrador del celular', 'admin', ?, 1, 0, ?, ?)",
          [uuid(), await hashClave('admin123'), t, t]);
      db.auditar('sistema', 'instalacion', 'Usuario local admin creado');
    }
  }

  Future<void> iniciar({bool soloLocal = false}) async {
    await prepararUsuarios();
    _http = await HttpServer.bind(soloLocal ? InternetAddress.loopbackIPv4 : InternetAddress.anyIPv4, puerto, shared: true);
    _http!.listen((r) => _manejar(r).catchError((Object e) {
          try {
            r.response.close();
          } catch (_) {}
        }));
    sync.iniciarAutomatica();
  }

  Future<void> detener() async {
    sync.detener();
    await _http?.close(force: true);
  }

  // ------------------------------------------------------------------ enrutador
  void R(String metodo, String patron, Object? roles, Manejador fn) {
    final nombres = <String>[];
    final re = RegExp('^${patron.replaceAllMapped(RegExp(r'/:([a-zA-Z_]+)'), (m) {
      nombres.add(m[1]!);
      return '/([^/]+)';
    })}/?\$');
    _rutas.add(_Ruta(metodo, re, nombres, roles, fn));
  }

  Future<void> _manejar(HttpRequest req) async {
    final res = req.response;
    final ruta = req.uri.path;
    res.headers.set('X-Content-Type-Options', 'nosniff');
    res.headers.set('Access-Control-Allow-Origin', '*');
    if (req.method == 'OPTIONS') {
      res.statusCode = 204;
      res.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      await res.close();
      return;
    }
    if (ruta.startsWith('/api/')) {
      try {
        _Ruta? r;
        var params = <String, String>{};
        var existe = false;
        for (final x in _rutas) {
          final m = x.regex.firstMatch(ruta);
          if (m == null) continue;
          existe = true;
          if (x.metodo != req.method) continue;
          r = x;
          for (var i = 0; i < x.nombres.length; i++) {
            params[x.nombres[i]] = Uri.decodeComponent(m.group(i + 1)!);
          }
          break;
        }
        if (r == null) throw ErrorHttp(existe ? 405 : 404, existe ? 'Método no permitido.' : 'Ruta no encontrada.');

        Fila? usuario;
        if (r.roles != null) {
          final auth = req.headers.value('authorization') ?? '';
          final token = auth.startsWith('Bearer ') ? auth.substring(7) : req.uri.queryParameters['t'];
          final datos = leerToken(token, secreto);
          if (datos == null) throw ErrorHttp(401, 'Su sesión expiró. Inicie sesión de nuevo.');
          usuario = db.uno('SELECT * FROM usuarios WHERE id = ?', [datos['uid']]);
          if (usuario == null || usuario['activo'] != 1) throw ErrorHttp(401, 'Usuario inactivo o inexistente.');
          if (r.roles != '*' && !(r.roles as List).contains(usuario['rol'])) throw ErrorHttp(403, 'Su rol no tiene permiso para esta acción.');
        }

        var body = <String, dynamic>{};
        if (req.method == 'POST' || req.method == 'PUT') {
          final bb = BytesBuilder(copy: false);
          await for (final c in req) {
            bb.add(c);
            if (bb.length > 60 * 1024 * 1024) throw ErrorHttp(413, 'La información enviada es demasiado grande.');
          }
          if (bb.length > 0) {
            try {
              final d = jsonDecode(utf8.decode(bb.takeBytes()));
              if (d is Map<String, dynamic>) body = d;
            } catch (_) {
              throw ErrorHttp(400, 'JSON no válido.');
            }
          }
        }
        final resultado = await r.fn(Ctx(req, params, req.uri.queryParameters, body, usuario));
        if (resultado is Binario) {
          res.headers.contentType = ContentType.parse(resultado.tipo);
          resultado.cabeceras.forEach(res.headers.set);
          res.add(resultado.datos);
        } else {
          _json(res, 200, resultado ?? {'ok': true});
        }
      } on ErrorHttp catch (e) {
        _json(res, e.estado, {'error': e.mensaje});
      } catch (e, st) {
        final s = '$e';
        stderr.writeln('ERROR ${req.method} $ruta: $e\n$st');
        _json(res, 500, {
          'error': s.contains('UNIQUE')
              ? 'Ya existe un registro con esos datos (valor repetido).'
              : s.contains('FOREIGN KEY')
                  ? 'El registro está relacionado con otros datos y no se puede guardar así.'
                  : 'Error interno del servidor.'
        });
      }
      await res.close();
      return;
    }

    // archivos estáticos (aplicación de una sola página)
    var archivo = ruta == '/' ? 'index.html' : ruta.substring(1);
    if (archivo.contains('..')) archivo = 'index.html';
    var datos = await lectorEstatico(archivo);
    if (datos == null) {
      archivo = 'index.html';
      datos = await lectorEstatico(archivo);
    }
    if (datos == null) {
      res.statusCode = 404;
      await res.close();
      return;
    }
    final ext = archivo.contains('.') ? archivo.substring(archivo.lastIndexOf('.')) : '';
    const tipos = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.webmanifest': 'application/manifest+json',
      '.png': 'image/png',
      '.json': 'application/json',
    };
    res.headers.contentType = ContentType.parse(tipos[ext] ?? 'application/octet-stream');
    res.headers.set('Cache-Control', 'no-cache');
    res.add(datos);
    await res.close();
  }

  void _json(HttpResponse res, int estado, Object datos) {
    res.statusCode = estado;
    res.headers.contentType = ContentType.json;
    res.headers.set('Cache-Control', 'no-store');
    res.add(utf8.encode(jsonEncode(datos)));
  }

  Future<List<String>> direcciones() async {
    final lista = <String>['http://127.0.0.1:$puerto'];
    try {
      for (final i in await NetworkInterface.list(type: InternetAddressType.IPv4)) {
        for (final a in i.addresses) {
          if (!a.isLoopback) lista.add('http://${a.address}:$puerto');
        }
      }
    } catch (_) {}
    return lista;
  }

  // ------------------------------------------------------------------ consultas compartidas
  Map<String, Object?> usuarioPublico(Fila u) => {
        'id': u['id'],
        'usuario': u['usuario'],
        'nombre': u['nombre'],
        'rol': u['rol'],
        'cliente_id': u['cliente_id'],
        'activo': u['activo'] == 1,
        // En el celular la contraseña se administra desde la oficina.
        'debe_cambiar_clave': false,
      };

  Map<String, Object?> avanceContrato(String contratoId) {
    final items = db.todos('''
      SELECT ci.producto_id, p.nombre AS producto, p.unidad, ci.cantidad AS contratado, ci.precio_unitario,
        COALESCE((SELECT SUM(ri.cantidad) FROM remision_items ri JOIN remisiones r ON r.id = ri.remision_id
          WHERE r.contrato_id = ci.contrato_id AND ri.producto_id = ci.producto_id AND r.estado = 'entregada'), 0) AS entregado,
        COALESCE((SELECT SUM(ri.cantidad) FROM remision_items ri JOIN remisiones r ON r.id = ri.remision_id
          WHERE r.contrato_id = ci.contrato_id AND ri.producto_id = ci.producto_id AND r.estado = 'pendiente'), 0) AS en_transito
      FROM contrato_items ci JOIN productos p ON p.id = ci.producto_id WHERE ci.contrato_id = ? ORDER BY p.nombre''', [contratoId]);
    var contratado = 0.0, entregado = 0.0, transito = 0.0, vc = 0.0, ve = 0.0;
    for (final i in items) {
      final c = _d(i['contratado']), e = _d(i['entregado']), pu = _d(i['precio_unitario']);
      i['pendiente'] = max(0.0, c - e);
      i['valor_contratado'] = c * pu;
      i['valor_entregado'] = min(e, c) * pu;
      i['porcentaje'] = c > 0 ? min(100.0, e / c * 100) : 0.0;
      contratado += c;
      entregado += min(e, c);
      transito += _d(i['en_transito']);
      vc += c * pu;
      ve += min(e, c) * pu;
    }
    return {
      'items': items,
      'totales': {
        'contratado': contratado,
        'entregado': entregado,
        'en_transito': transito,
        'valor_contratado': vc,
        'valor_entregado': ve,
        'pendiente': max(0.0, contratado - entregado),
        'saldo_valor': max(0.0, vc - ve),
        'porcentaje': contratado > 0 ? entregado / contratado * 100 : 0.0,
        'porcentaje_valor': vc > 0 ? ve / vc * 100 : 0.0,
      }
    };
  }

  List<Fila> contratosConAvance({String? clienteId, Set<String>? soloIds}) {
    var lista = db.todos(
        'SELECT c.*, cl.nombre AS cliente_nombre FROM contratos c JOIN clientes cl ON cl.id = c.cliente_id ${clienteId != null ? 'WHERE c.cliente_id = ?' : ''} ORDER BY c.estado, c.fecha_inicio DESC, c.codigo',
        clienteId != null ? [clienteId] : []);
    if (soloIds != null) lista = lista.where((c) => soloIds.contains(c['id'])).toList();
    for (final c in lista) {
      c['avance'] = avanceContrato(c['id'] as String)['totales'];
    }
    return lista;
  }

  Fila? cargarRemision(String id, {bool conEvidencias = true}) {
    final r = db.uno('''SELECT r.*, cl.nombre AS cliente_nombre, cl.nit AS cliente_nit, cl.representante AS cliente_representante,
        cl.direccion AS cliente_direccion, cl.telefono AS cliente_telefono, co.codigo AS contrato_codigo,
        u.nombre AS repartidor_nombre, uc.nombre AS creado_por_nombre
      FROM remisiones r JOIN clientes cl ON cl.id = r.cliente_id LEFT JOIN contratos co ON co.id = r.contrato_id
      LEFT JOIN usuarios u ON u.id = r.repartidor_id LEFT JOIN usuarios uc ON uc.id = r.creado_por WHERE r.id = ?''', [id]);
    if (r == null) return null;
    final items = db.todos(
        'SELECT ri.*, p.unidad, p.codigo AS producto_codigo FROM remision_items ri LEFT JOIN productos p ON p.id = ri.producto_id WHERE ri.remision_id = ? ORDER BY ri.rowid',
        [id]);
    r['items'] = items;
    r['total'] = items.fold<double>(0, (s, i) => s + _d(i['cantidad']) * _d(i['precio_unitario']));
    r['unidades'] = items.fold<double>(0, (s, i) => s + _d(i['cantidad']));
    if (conEvidencias) {
      r['evidencias'] = db.todos('SELECT id, tipo, rol, mime, tomada_en, length(datos) AS bytes FROM evidencias WHERE remision_id = ? ORDER BY tomada_en', [id]);
      r['historial'] = db
          .todos('SELECT id, fecha, usuario_nombre, accion, motivo, version_anterior FROM remision_historial WHERE remision_id = ? ORDER BY fecha', [id])
          .map((h) => {...h, 'version_anterior': h['version_anterior'] == null ? null : jsonDecode(h['version_anterior'] as String)})
          .toList();
    }
    return r;
  }

  bool puedeVer(Fila u, Fila r) {
    final rol = u['rol'];
    if (_oficina.contains(rol)) return true;
    if (rol == 'repartidor') return r['repartidor_id'] == u['id'] || r['creado_por'] == u['id'];
    if (rol == 'cliente') return r['cliente_id'] == u['cliente_id'] && r['estado'] == 'entregada';
    return false;
  }

  String siguienteNumero() {
    final prefijo = db.config('prefijo_remision', 'M')!;
    var n = int.tryParse(db.config('consecutivo_remision', '0')!) ?? 0;
    String num;
    do {
      n++;
      num = '$prefijo-${n.toString().padLeft(5, '0')}';
    } while (db.uno('SELECT 1 AS x FROM remisiones WHERE numero = ?', [num]) != null);
    db.setConfig('consecutivo_remision', n);
    return num;
  }

  void registrarHistorial(String remisionId, Fila? u, String accion, [String? motivo]) {
    db.ejecutar(
        'INSERT INTO remision_historial(id, remision_id, fecha, usuario_id, usuario_nombre, accion, motivo) VALUES (?,?,?,?,?,?,?)',
        [uuid(), remisionId, ahora(), u?['id'], u?['nombre'] ?? 'sistema', accion, motivo]);
  }

  (String, Uint8List) decodificarImagen(Object? dataUrl, String campo) {
    final m = RegExp(r'^data:(image/(png|jpeg|webp));base64,(.+)$', dotAll: true).firstMatch('${dataUrl ?? ''}');
    if (m == null) throw ErrorHttp(400, 'La $campo no tiene un formato de imagen válido.');
    final datos = base64.decode(m.group(3)!);
    if (datos.length < 100) throw ErrorHttp(400, 'La $campo está vacía.');
    if (datos.length > 8 * 1024 * 1024) throw ErrorHttp(413, 'La $campo es demasiado grande.');
    return (m.group(1)!, datos);
  }

  Map<String, String?> empresa() => {
        'empresa_nombre': db.config('empresa_nombre', 'DISTRIMOS S.A.S'),
        'empresa_nit': db.config('empresa_nit', ''),
        'empresa_direccion': db.config('empresa_direccion', 'Maicao, La Guajira'),
        'empresa_telefono': db.config('empresa_telefono', ''),
        'empresa_representante': db.config('empresa_representante', ''),
      };

  // ------------------------------------------------------------------ rutas
  void _registrarRutas() {
    R('GET', '/api/info', null, (c) async => {
          'sistema': 'Sistema de Remisiones DISTRIMOS',
          'empresa': db.config('empresa_nombre', 'DISTRIMOS S.A.S'),
          'modo': 'movil',
          'version': version,
          'servidor_ahora': ahora(),
          'puerto': puerto,
          'direcciones': await direcciones(),
          'capacidades': {
            'inventario': false,
            'respaldos': false,
            'usuarios': false,
            'sync_central': false,
            'sync_movil': true,
            'datos_demo': false,
            'edicion_remisiones': false,
          },
        });

    R('GET', '/api/ajustes-publicos', null, (c) => empresa());
    R('GET', '/api/ajustes', _oficina, (c) => {...empresa(), 'prefijo_remision': db.config('prefijo_remision', 'M')});
    R('PUT', '/api/ajustes', ['admin'], (c) {
      for (final k in ['empresa_nombre', 'empresa_nit', 'empresa_direccion', 'empresa_telefono', 'empresa_representante']) {
        if (c.body.containsKey(k)) db.setConfig(k, txt(c.body[k], 200) ?? '');
      }
      if (c.body['prefijo_remision'] != null) {
        final p = '${c.body['prefijo_remision']}'.trim().toUpperCase();
        if (!RegExp(r'^[A-Z0-9]{1,6}$').hasMatch(p)) throw ErrorHttp(400, 'El prefijo debe tener de 1 a 6 letras o números.');
        db.setConfig('prefijo_remision', p);
      }
      return {'ok': true};
    });

    // ---------------- sesión
    R('POST', '/api/auth/login', null, (c) async {
      final usuario = req(txt(c.body['usuario'], 60), 'usuario');
      final clave = '${c.body['clave'] ?? ''}';
      req(clave, 'contraseña');
      final k = usuario.toLowerCase();
      final reg = _fallidos[k];
      if (reg != null && reg.$2 > DateTime.now().millisecondsSinceEpoch) throw ErrorHttp(429, 'Demasiados intentos fallidos. Espere un minuto.');
      final u = db.uno('SELECT * FROM usuarios WHERE usuario = ?', [usuario]);
      if (u == null || u['activo'] != 1 || !await verificarClave(clave, u['clave_hash'] as String)) {
        final n = (reg?.$1 ?? 0) + 1;
        _fallidos[k] = (n, n >= 5 ? DateTime.now().millisecondsSinceEpoch + 60000 : 0);
        db.auditar(usuario, 'login_fallido');
        throw ErrorHttp(401, 'Usuario o contraseña incorrectos.');
      }
      _fallidos.remove(k);
      db.auditar(u['usuario'] as String, 'login');
      return {'token': tokenPara(u), 'usuario': usuarioPublico(u)};
    });

    R('GET', '/api/auth/yo', '*', (c) => {'usuario': usuarioPublico(c.u)});

    R('POST', '/api/auth/clave', '*', (c) async {
      if (!await verificarClave('${c.body['actual'] ?? ''}', c.u['clave_hash'] as String)) throw ErrorHttp(400, 'La contraseña actual no es correcta.');
      final nueva = '${c.body['nueva'] ?? ''}';
      if (nueva.length < 6) throw ErrorHttp(400, 'La nueva contraseña debe tener al menos 6 caracteres.');
      db.ejecutar('UPDATE usuarios SET clave_hash = ?, debe_cambiar_clave = 0, actualizado_en = ? WHERE id = ?', [await hashClave(nueva), ahora(), c.uid]);
      return {'ok': true};
    });

    R('GET', '/api/repartidores', _internos, (c) => db.todos("SELECT id, nombre, usuario FROM usuarios WHERE rol = 'repartidor' AND activo = 1 ORDER BY nombre"));

    // ---------------- clientes y productos
    R('GET', '/api/clientes', '*', (c) {
      if (c.rol == 'cliente') return db.todos('SELECT * FROM clientes WHERE id = ?', [c.u['cliente_id']]);
      return db.todos('SELECT * FROM clientes ORDER BY activo DESC, nombre');
    });
    Object? guardarCliente(Ctx c) {
      final id = c.params['id'] ?? uuid();
      if (c.params['id'] != null && db.uno('SELECT id FROM clientes WHERE id = ?', [id]) == null) throw ErrorHttp(404, 'Cliente no encontrado.');
      final tipo = txt(c.body['tipo'], 20) ?? 'privado';
      if (!['publico', 'privado', 'fundacion', 'colegio'].contains(tipo)) throw ErrorHttp(400, 'Tipo de cliente no válido.');
      final o = <String, Object?>{
        'id': id,
        'nombre': req(txt(c.body['nombre'], 150), 'nombre'),
        'nit': txt(c.body['nit'], 30),
        'tipo': tipo,
        'representante': txt(c.body['representante'], 120),
        'telefono': txt(c.body['telefono'], 40),
        'email': txt(c.body['email'], 120),
        'direccion': txt(c.body['direccion'], 200),
        'municipio': txt(c.body['municipio'], 80),
        'autoriza_datos': verdad(c.body['autoriza_datos']) ? 1 : 0,
        'activo': c.body.containsKey('activo') ? (verdad(c.body['activo']) ? 1 : 0) : 1,
        'actualizado_en': ahora(),
        'pendiente_sync': 1,
      };
      db.upsert('clientes', o.keys.toList(), o);
      db.auditar(c.u['usuario'] as String, c.params['id'] != null ? 'cliente_editado' : 'cliente_creado', o['nombre'] as String);
      return db.uno('SELECT * FROM clientes WHERE id = ?', [id]);
    }

    R('POST', '/api/clientes', _editores, guardarCliente);
    R('PUT', '/api/clientes/:id', _editores, guardarCliente);

    R('GET', '/api/productos', '*', (c) => db.todos('SELECT * FROM productos ORDER BY activo DESC, nombre'));
    Object? guardarProducto(Ctx c) {
      final id = c.params['id'] ?? uuid();
      if (c.params['id'] != null && db.uno('SELECT id FROM productos WHERE id = ?', [id]) == null) throw ErrorHttp(404, 'Producto no encontrado.');
      final o = <String, Object?>{
        'id': id,
        'codigo': txt(c.body['codigo'], 40),
        'nombre': req(txt(c.body['nombre'], 150), 'nombre'),
        'unidad': txt(c.body['unidad'], 30) ?? 'unidad',
        'precio': c.body.containsKey('precio') ? max(0.0, numero(c.body['precio'])) : (c.params['id'] != null ? _d(db.uno('SELECT precio FROM productos WHERE id = ?', [id])?['precio']) : 0.0),
        'activo': c.body.containsKey('activo') ? (verdad(c.body['activo']) ? 1 : 0) : 1,
        'actualizado_en': ahora(),
        'pendiente_sync': 1,
      };
      db.upsert('productos', o.keys.toList(), o);
      return db.uno('SELECT * FROM productos WHERE id = ?', [id]);
    }

    R('POST', '/api/productos', ['secretario'], guardarProducto);
    R('PUT', '/api/productos/:id', _editores, guardarProducto);

    // ---------------- contratos
    R('GET', '/api/contratos', '*', (c) => c.rol == 'cliente' ? contratosConAvance(clienteId: c.u['cliente_id'] as String?) : contratosConAvance());

    R('GET', '/api/contratos/:id', '*', (c) {
      final co = db.uno('SELECT c.*, cl.nombre AS cliente_nombre FROM contratos c JOIN clientes cl ON cl.id = c.cliente_id WHERE c.id = ?', [c.params['id']]);
      if (co == null || (c.rol == 'cliente' && co['cliente_id'] != c.u['cliente_id'])) throw ErrorHttp(404, 'Contrato no encontrado.');
      co['items'] = db.todos('SELECT ci.*, p.nombre AS producto_nombre, p.unidad FROM contrato_items ci JOIN productos p ON p.id = ci.producto_id WHERE ci.contrato_id = ?', [co['id']]);
      co['avance'] = avanceContrato(co['id'] as String);
      var sql = '''SELECT r.id, r.numero, r.fecha, r.estado, r.municipio, r.entregada_en, r.editada, r.pendiente_sync, u.nombre AS repartidor_nombre,
          (SELECT SUM(cantidad) FROM remision_items WHERE remision_id = r.id) AS unidades,
          (SELECT SUM(cantidad * precio_unitario) FROM remision_items WHERE remision_id = r.id) AS total
        FROM remisiones r LEFT JOIN usuarios u ON u.id = r.repartidor_id WHERE r.contrato_id = ?''';
      final p = <Object?>[co['id']];
      if (c.rol == 'cliente') sql += " AND r.estado = 'entregada'";
      if (c.rol == 'repartidor') {
        sql += ' AND (r.repartidor_id = ? OR r.creado_por = ?)';
        p.addAll([c.uid, c.uid]);
      }
      co['remisiones'] = db.todos('$sql ORDER BY r.fecha DESC, r.numero DESC', p);
      return co;
    });

    Object? guardarContrato(Ctx c) {
      final id = c.params['id'] ?? uuid();
      final o = <String, Object?>{
        'id': id,
        'codigo': req(txt(c.body['codigo'], 60), 'código'),
        'cliente_id': req(txt(c.body['cliente_id'], 64), 'cliente'),
        'objeto': txt(c.body['objeto'], 500),
        'fecha_inicio': txt(c.body['fecha_inicio'], 10),
        'fecha_fin': txt(c.body['fecha_fin'], 10),
        'estado': ['activo', 'finalizado', 'suspendido'].contains(c.body['estado']) ? c.body['estado'] : 'activo',
        'actualizado_en': ahora(),
        'pendiente_sync': 1,
      };
      final items = (c.body['items'] as List?) ?? [];
      // Si el cliente no envía precio (p. ej. la secretaria), se conserva el del contrato o el de referencia del producto.
      final preciosPrevios = <String, double>{
        for (final x in db.todos('SELECT producto_id, precio_unitario FROM contrato_items WHERE contrato_id = ?', [id])) x['producto_id'] as String: _d(x['precio_unitario'])
      };
      double precioDeItem(Map i) {
        final p = i['precio_unitario'];
        if (p != null && p != '') return max(0.0, numero(p));
        final pid = i['producto_id'] as String?;
        if (pid != null && preciosPrevios.containsKey(pid)) return preciosPrevios[pid]!;
        return _d(db.uno('SELECT precio FROM productos WHERE id = ?', [pid])?['precio']);
      }
      db.transaccion(() {
        db.upsert('contratos', o.keys.toList(), o);
        db.ejecutar('DELETE FROM contrato_items WHERE contrato_id = ?', [id]);
        for (final i in items) {
          if (numero(i['cantidad']) <= 0) throw ErrorHttp(400, 'Las cantidades del contrato deben ser mayores que cero.');
          db.ejecutar('INSERT INTO contrato_items(id, contrato_id, producto_id, cantidad, precio_unitario) VALUES (?,?,?,?,?)',
              [uuid(), id, i['producto_id'], numero(i['cantidad']), precioDeItem(i as Map)]);
        }
      });
      return db.uno('SELECT * FROM contratos WHERE id = ?', [id]);
    }

    R('POST', '/api/contratos', ['secretario'], guardarContrato);
    R('PUT', '/api/contratos/:id', _editores, guardarContrato);

    // ---------------- remisiones
    R('GET', '/api/remisiones', '*', (c) {
      final w = <String>[];
      final p = <Object?>[];
      final q = c.query;
      if (c.rol == 'repartidor') {
        w.add('(r.repartidor_id = ? OR r.creado_por = ?)');
        p.addAll([c.uid, c.uid]);
      }
      if (c.rol == 'cliente') {
        w.add("r.cliente_id = ? AND r.estado = 'entregada'");
        p.add(c.u['cliente_id']);
      }
      for (final (k, col, op) in [
        ('estado', 'r.estado', '='),
        ('cliente_id', 'r.cliente_id', '='),
        ('contrato_id', 'r.contrato_id', '='),
        ('repartidor_id', 'r.repartidor_id', '='),
        ('desde', 'r.fecha', '>='),
        ('hasta', 'r.fecha', '<=')
      ]) {
        if ((q[k] ?? '').isNotEmpty) {
          w.add('$col $op ?');
          p.add(q[k]);
        }
      }
      if ((q['q'] ?? '').isNotEmpty) {
        w.add('(r.numero LIKE ? OR cl.nombre LIKE ? OR r.municipio LIKE ? OR r.receptor_nombre LIKE ? OR co.codigo LIKE ?)');
        p.addAll(List.filled(5, '%${q['q']}%'));
      }
      return db.todos('''SELECT r.id, r.numero, r.fecha, r.estado, r.editada, r.municipio, r.entregada_en, r.receptor_nombre, r.origen, r.pendiente_sync,
          r.cliente_id, cl.nombre AS cliente_nombre, r.contrato_id, co.codigo AS contrato_codigo, r.repartidor_id, u.nombre AS repartidor_nombre,
          (SELECT SUM(cantidad) FROM remision_items WHERE remision_id = r.id) AS unidades,
          (SELECT SUM(cantidad * precio_unitario) FROM remision_items WHERE remision_id = r.id) AS total,
          (SELECT COUNT(*) FROM evidencias WHERE remision_id = r.id) AS evidencias
        FROM remisiones r JOIN clientes cl ON cl.id = r.cliente_id LEFT JOIN contratos co ON co.id = r.contrato_id
        LEFT JOIN usuarios u ON u.id = r.repartidor_id ${w.isEmpty ? '' : 'WHERE ${w.join(' AND ')}'}
        ORDER BY r.fecha DESC, r.creado_en DESC LIMIT 300''', p);
    });

    R('GET', '/api/remisiones/:id', '*', (c) {
      final r = cargarRemision(c.params['id']!);
      if (r == null || !puedeVer(c.u, r)) throw ErrorHttp(404, 'Remisión no encontrada.');
      return r;
    });

    R('POST', '/api/remisiones', ['secretario'], (c) {
      final contratoId = txt(c.body['contrato_id'], 64);
      var clienteId = txt(c.body['cliente_id'], 64);
      Map<String, double> preciosContrato = {};
      if (contratoId != null) {
        final co = db.uno('SELECT * FROM contratos WHERE id = ?', [contratoId]);
        if (co == null) throw ErrorHttp(400, 'El contrato no existe.');
        if (co['estado'] != 'activo') throw ErrorHttp(400, 'El contrato no está activo.');
        clienteId = co['cliente_id'] as String;
        for (final x in db.todos('SELECT producto_id, precio_unitario FROM contrato_items WHERE contrato_id = ?', [contratoId])) {
          preciosContrato[x['producto_id'] as String] = _d(x['precio_unitario']);
        }
      }
      req(clienteId, 'cliente');
      final cliente = db.uno('SELECT * FROM clientes WHERE id = ?', [clienteId]);
      if (cliente == null) throw ErrorHttp(400, 'El cliente no existe.');
      var repartidorId = txt(c.body['repartidor_id'], 64);
      if (c.rol == 'repartidor') repartidorId = c.uid;
      final itemsIn = (c.body['items'] as List?) ?? [];
      if (itemsIn.isEmpty) throw ErrorHttp(400, 'La remisión debe tener al menos un producto.');
      final items = <Map<String, Object?>>[];
      for (var k = 0; k < itemsIn.length; k++) {
        final i = itemsIn[k] as Map;
        final cant = numero(i['cantidad']);
        if (cant <= 0) throw ErrorHttp(400, 'La cantidad del producto ${k + 1} debe ser mayor que cero.');
        final pid = txt(i['producto_id'], 64);
        final prod = pid == null ? null : db.uno('SELECT * FROM productos WHERE id = ?', [pid]);
        if (pid != null && prod == null) throw ErrorHttp(400, 'El producto ${k + 1} no existe.');
        final desc = txt(i['descripcion'], 200) ?? prod?['nombre'] as String?;
        if (desc == null) throw ErrorHttp(400, 'Falta la descripción del producto ${k + 1}.');
        items.add({'producto_id': pid, 'descripcion': desc, 'cantidad': cant, 'precio_unitario': preciosContrato[pid] ?? _d(prod?['precio'])});
      }
      final id = uuid();
      final t = ahora();
      db.transaccion(() {
        db.ejecutar('''INSERT INTO remisiones(id, numero, contrato_id, cliente_id, repartidor_id, fecha, municipio, direccion_entrega, observaciones,
            estado, creado_por, creado_en, actualizado_en, origen, pendiente_sync) VALUES (?,?,?,?,?,?,?,?,?, 'pendiente', ?, ?, ?, ?, 1)''', [
          id,
          siguienteNumero(),
          contratoId,
          clienteId,
          repartidorId,
          txt(c.body['fecha'], 10) ?? hoyLocal(),
          txt(c.body['municipio'], 80) ?? cliente['municipio'],
          txt(c.body['direccion_entrega'], 200) ?? cliente['direccion'],
          txt(c.body['observaciones'], 1000),
          c.uid,
          t,
          t,
          'movil-${db.config('prefijo_remision')}'
        ]);
        for (final i in items) {
          db.ejecutar('INSERT INTO remision_items(id, remision_id, producto_id, descripcion, cantidad, precio_unitario) VALUES (?,?,?,?,?,?)',
              [uuid(), id, i['producto_id'], i['descripcion'], i['cantidad'], i['precio_unitario']]);
        }
        registrarHistorial(id, c.u, 'creada');
      });
      final r = cargarRemision(id)!;
      db.auditar(c.u['usuario'] as String, 'remision_creada', r['numero'] as String);
      return {...r, 'advertencias': <String>[]};
    });

    R('PUT', '/api/remisiones/:id', _editores,
        (c) => throw ErrorHttp(403, 'Las ediciones de remisiones se hacen en el sistema de la oficina, para conservar una sola versión oficial.'));
    R('POST', '/api/remisiones/:id/anular', _editores, (c) => throw ErrorHttp(403, 'Las anulaciones se hacen en el sistema de la oficina.'));

    R('POST', '/api/remisiones/:id/entrega', ['secretario', 'repartidor'], (c) {
      final r = cargarRemision(c.params['id']!, conEvidencias: false);
      if (r == null) throw ErrorHttp(404, 'Remisión no encontrada.');
      if (c.rol == 'repartidor' && r['repartidor_id'] != null && r['repartidor_id'] != c.uid) throw ErrorHttp(403, 'Esta remisión está asignada a otro repartidor.');
      if (r['estado'] != 'pendiente') throw ErrorHttp(400, 'La remisión ya está ${r['estado']}.');
      final receptor = req(txt(c.body['receptor_nombre'], 120), 'nombre de quien recibe');
      final firma = decodificarImagen(req(c.body['firma'], 'firma'), 'firma');
      final firmaRep = c.body['firma_repartidor'] == null ? null : decodificarImagen(c.body['firma_repartidor'], 'firma del repartidor');
      final foto = c.body['foto'] == null ? null : decodificarImagen(c.body['foto'], 'foto');
      if (foto == null && txt(c.body['sin_foto_motivo']) == null) throw ErrorHttp(400, 'Debe tomar la foto de la entrega o indicar por qué no fue posible.');
      final t = ahora();
      db.transaccion(() {
        db.ejecutar('''UPDATE remisiones SET estado = 'entregada', entregada_en = ?, receptor_nombre = ?, receptor_documento = ?, observaciones_entrega = ?,
            repartidor_id = COALESCE(repartidor_id, ?), actualizado_en = ?, pendiente_sync = 1 WHERE id = ?''', [
          t,
          receptor,
          txt(c.body['receptor_documento'], 30),
          txt(c.body['observaciones_entrega'] ?? c.body['sin_foto_motivo'], 1000),
          c.rol == 'repartidor' ? c.uid : null,
          t,
          r['id']
        ]);
        db.ejecutar('INSERT INTO evidencias(id, remision_id, tipo, mime, datos, tomada_en) VALUES (?,?,?,?,?,?)', [uuid(), r['id'], 'firma', firma.$1, firma.$2, t]);
        if (firmaRep != null) db.ejecutar('INSERT INTO evidencias(id, remision_id, tipo, mime, datos, tomada_en, rol) VALUES (?,?,?,?,?,?,?)', [uuid(), r['id'], 'firma', firmaRep.$1, firmaRep.$2, t, 'repartidor']);
        if (foto != null) db.ejecutar('INSERT INTO evidencias(id, remision_id, tipo, mime, datos, tomada_en) VALUES (?,?,?,?,?,?)', [uuid(), r['id'], 'foto', foto.$1, foto.$2, t]);
        registrarHistorial(r['id'] as String, c.u, 'entregada', foto == null ? 'Sin foto: ${txt(c.body['sin_foto_motivo'], 300)}' : null);
      });
      db.auditar(c.u['usuario'] as String, 'remision_entregada', r['numero'] as String);
      return cargarRemision(r['id'] as String);
    });

    R('GET', '/api/evidencias/:id', '*', (c) {
      final e = db.uno('SELECT * FROM evidencias WHERE id = ?', [c.params['id']]);
      if (e == null) throw ErrorHttp(404, 'Evidencia no encontrada.');
      final r = db.uno('SELECT * FROM remisiones WHERE id = ?', [e['remision_id']]);
      if (r == null || !puedeVer(c.u, r)) throw ErrorHttp(404, 'Evidencia no encontrada.');
      return Binario(e['mime'] as String, e['datos'] as List<int>, {'Cache-Control': 'private, max-age=86400'});
    });

    // ---------------- panel
    R('GET', '/api/panel', '*', (c) {
      final hoy = hoyLocal();
      final mes = hoy.substring(0, 7);
      if (c.rol == 'cliente') {
        final cid = c.u['cliente_id'];
        return {
          'rol': 'cliente',
          'cliente': db.uno('SELECT nombre FROM clientes WHERE id = ?', [cid])?['nombre'] ?? '',
          'contratos': contratosConAvance(clienteId: cid as String?),
          'recientes': db.todos('''SELECT r.id, r.numero, r.fecha, r.entregada_en, r.receptor_nombre, co.codigo AS contrato_codigo,
              (SELECT SUM(cantidad) FROM remision_items WHERE remision_id = r.id) AS unidades FROM remisiones r
              LEFT JOIN contratos co ON co.id = r.contrato_id WHERE r.cliente_id = ? AND r.estado = 'entregada' ORDER BY r.entregada_en DESC LIMIT 10''', [cid]),
        };
      }
      if (c.rol == 'repartidor') {
        const f = '(r.repartidor_id = ? OR r.creado_por = ?)';
        final pendientes = db.todos('''SELECT r.id, r.numero, r.fecha, r.municipio, r.direccion_entrega, cl.nombre AS cliente_nombre, co.codigo AS contrato_codigo,
            (SELECT SUM(cantidad) FROM remision_items WHERE remision_id = r.id) AS unidades
          FROM remisiones r JOIN clientes cl ON cl.id = r.cliente_id LEFT JOIN contratos co ON co.id = r.contrato_id
          WHERE $f AND r.estado = 'pendiente' ORDER BY r.fecha, r.numero''', [c.uid, c.uid]);
        final ids = db
            .todos('SELECT DISTINCT contrato_id FROM remisiones r WHERE $f AND contrato_id IS NOT NULL', [c.uid, c.uid])
            .map((x) => x['contrato_id'] as String)
            .toSet();
        return {
          'rol': 'repartidor',
          'kpis': {
            'pendientes': pendientes.length,
            'entregadas_hoy': db.uno("SELECT COUNT(*) AS n FROM remisiones r WHERE $f AND r.estado = 'entregada' AND substr(r.entregada_en,1,10) >= ?", [c.uid, c.uid, hoy])!['n'],
            'entregadas_mes': db.uno("SELECT COUNT(*) AS n FROM remisiones r WHERE $f AND r.estado = 'entregada' AND substr(r.entregada_en,1,7) = ?", [c.uid, c.uid, mes])!['n'],
          },
          'pendientes': pendientes,
          'contratos': contratosConAvance(soloIds: ids).where((x) => x['estado'] == 'activo').toList(),
        };
      }
      final porMes = <Map<String, Object?>>[];
      final ahoraL = DateTime.now();
      for (var i = 5; i >= 0; i--) {
        final d = DateTime(ahoraL.year, ahoraL.month - i, 1);
        final m = '${d.year}-${d.month.toString().padLeft(2, '0')}';
        final fila = db.uno('''SELECT COUNT(DISTINCT r.id) AS n, COALESCE(SUM(ri.cantidad * ri.precio_unitario),0) AS v FROM remisiones r
            LEFT JOIN remision_items ri ON ri.remision_id = r.id WHERE r.estado = 'entregada' AND substr(r.entregada_en,1,7) = ?''', [m])!;
        porMes.add({'mes': m, 'remisiones': fila['n'], 'valor': fila['v']});
      }
      return {
        'rol': c.rol,
        'kpis': {
          'remisiones_hoy': db.uno("SELECT COUNT(*) AS n FROM remisiones WHERE fecha = ? AND estado <> 'anulada'", [hoy])!['n'],
          'pendientes': db.uno("SELECT COUNT(*) AS n FROM remisiones WHERE estado = 'pendiente'")!['n'],
          'entregadas_mes': db.uno("SELECT COUNT(*) AS n FROM remisiones WHERE estado = 'entregada' AND substr(entregada_en,1,7) = ?", [mes])!['n'],
          'valor_entregado_mes': db.uno('''SELECT COALESCE(SUM(ri.cantidad * ri.precio_unitario),0) AS v FROM remision_items ri JOIN remisiones r ON r.id = ri.remision_id
              WHERE r.estado = 'entregada' AND substr(r.entregada_en,1,7) = ?''', [mes])!['v'],
          'editadas': db.uno('SELECT COUNT(*) AS n FROM remisiones WHERE editada = 1')!['n'],
          'contratos_activos': db.uno("SELECT COUNT(*) AS n FROM contratos WHERE estado = 'activo'")!['n'],
          'alertas_insumos': 0,
        },
        'contratos': contratosConAvance().where((x) => x['estado'] == 'activo').toList(),
        'pendientes_por_repartidor': db.todos('''SELECT COALESCE(u.nombre, 'Sin asignar') AS repartidor, COUNT(*) AS n FROM remisiones r
            LEFT JOIN usuarios u ON u.id = r.repartidor_id WHERE r.estado = 'pendiente' GROUP BY u.nombre ORDER BY n DESC'''),
        'recientes': db.todos('''SELECT r.id, r.numero, r.fecha, r.estado, r.editada, r.pendiente_sync, cl.nombre AS cliente_nombre, u.nombre AS repartidor_nombre,
            (SELECT SUM(cantidad * precio_unitario) FROM remision_items WHERE remision_id = r.id) AS total
            FROM remisiones r JOIN clientes cl ON cl.id = r.cliente_id LEFT JOIN usuarios u ON u.id = r.repartidor_id ORDER BY r.actualizado_en DESC LIMIT 8'''),
        'por_mes': porMes,
      };
    });

    R('GET', '/api/auditoria', ['admin', 'gerente'], (c) {
      final q = c.query['q'];
      if (q != null && q.isNotEmpty) {
        return db.todos('SELECT * FROM auditoria WHERE usuario LIKE ? OR accion LIKE ? OR detalle LIKE ? ORDER BY id DESC LIMIT 500', ['%$q%', '%$q%', '%$q%']);
      }
      return db.todos('SELECT * FROM auditoria ORDER BY id DESC LIMIT 500');
    });

    // ---------------- sincronización con la oficina
    R('GET', '/api/sync/estado', null, (c) => sync.estado());
    R('POST', '/api/sync/vincular', null, (c) async {
      final r = await sync.vincular(
        servidor: req(txt(c.body['servidor'], 200), 'dirección del servidor'),
        usuario: req(txt(c.body['usuario'], 60), 'usuario'),
        clave: req(txt(c.body['clave'], 200), 'contraseña'),
        prefijo: txt(c.body['prefijo'], 6),
      );
      return r;
    });
    R('POST', '/api/sync/ejecutar', _internos, (c) => sync.ejecutar());
  }

  String tokenPara(Fila u) => crearToken({'uid': u['id'], 'rol': u['rol']}, secreto);
}
