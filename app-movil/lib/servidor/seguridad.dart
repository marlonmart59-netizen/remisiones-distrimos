// Hash de contraseñas (PBKDF2-HMAC-SHA256) y tokens firmados (HMAC-SHA256).
// Formatos idénticos a los del servidor PC (Node.js):
//   hash  = "pbkdf2$<iteraciones>$<sal base64>$<derivada base64>"
//   token = "<payload base64url>.<firma base64url>"
import 'dart:convert';
import 'dart:isolate';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

const int iteraciones = 60000;

Uint8List pbkdf2(List<int> clave, List<int> sal, int iter, int largo) {
  final hmac = Hmac(sha256, clave);
  final salida = BytesBuilder();
  var bloque = 1;
  while (salida.length < largo) {
    final s = Uint8List(sal.length + 4)
      ..setAll(0, sal)
      ..[sal.length] = (bloque >> 24) & 0xff
      ..[sal.length + 1] = (bloque >> 16) & 0xff
      ..[sal.length + 2] = (bloque >> 8) & 0xff
      ..[sal.length + 3] = bloque & 0xff;
    var u = hmac.convert(s).bytes;
    final t = Uint8List.fromList(u);
    for (var i = 1; i < iter; i++) {
      u = hmac.convert(u).bytes;
      for (var j = 0; j < t.length; j++) {
        t[j] ^= u[j];
      }
    }
    salida.add(t);
    bloque++;
  }
  return Uint8List.fromList(salida.takeBytes().sublist(0, largo));
}

bool _iguales(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  var r = 0;
  for (var i = 0; i < a.length; i++) {
    r |= a[i] ^ b[i];
  }
  return r == 0;
}

/// Se ejecuta en otro isolate para no congelar la interfaz del celular.
Future<String> hashClave(String clave) => Isolate.run(() {
      final rnd = Random.secure();
      final sal = List<int>.generate(16, (_) => rnd.nextInt(256));
      final der = pbkdf2(utf8.encode(clave), sal, iteraciones, 32);
      return 'pbkdf2\$$iteraciones\$${base64.encode(sal)}\$${base64.encode(der)}';
    });

Future<bool> verificarClave(String clave, String hash) => Isolate.run(() {
      try {
        final p = hash.split(r'$');
        if (p.length != 4 || p[0] != 'pbkdf2') return false;
        final esperado = base64.decode(p[3]);
        final der = pbkdf2(utf8.encode(clave), base64.decode(p[2]), int.parse(p[1]), esperado.length);
        return _iguales(der, esperado);
      } catch (_) {
        return false;
      }
    });

String _b64url(List<int> b) => base64Url.encode(b).replaceAll('=', '');

String crearToken(Map<String, Object?> datos, String secreto, {int horas = 12}) {
  final payload = {...datos, 'exp': DateTime.now().millisecondsSinceEpoch + horas * 3600 * 1000};
  final p = _b64url(utf8.encode(jsonEncode(payload)));
  final firma = _b64url(Hmac(sha256, utf8.encode(secreto)).convert(utf8.encode(p)).bytes);
  return '$p.$firma';
}

Map<String, dynamic>? leerToken(String? token, String secreto) {
  if (token == null || !token.contains('.')) return null;
  final partes = token.split('.');
  if (partes.length != 2) return null;
  final esperada = _b64url(Hmac(sha256, utf8.encode(secreto)).convert(utf8.encode(partes[0])).bytes);
  if (!_iguales(utf8.encode(partes[1]), utf8.encode(esperada))) return null;
  try {
    final datos = jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(partes[0])))) as Map<String, dynamic>;
    final exp = datos['exp'];
    if (exp is! num || exp < DateTime.now().millisecondsSinceEpoch) return null;
    return datos;
  } catch (_) {
    return null;
  }
}

String secretoAleatorio() {
  final rnd = Random.secure();
  return List<int>.generate(32, (_) => rnd.nextInt(256)).map((x) => x.toRadixString(16).padLeft(2, '0')).join();
}
