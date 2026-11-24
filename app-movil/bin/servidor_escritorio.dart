// Ejecuta el servidor de la app móvil en el computador, para pruebas automatizadas
// sin necesidad de un celular:  dart run bin/servidor_escritorio.dart <carpeta_datos> <puerto>
import 'dart:io';

import 'package:remisiones_distrimos/servidor/db.dart';
import 'package:remisiones_distrimos/servidor/servidor.dart';

Future<void> main(List<String> args) async {
  final datos = args.isNotEmpty ? args[0] : '${Directory.systemTemp.path}/remisiones-movil';
  final puerto = args.length > 1 ? int.parse(args[1]) : 8765;
  final web = Directory('${File(Platform.script.toFilePath()).parent.parent.parent.path}/web').path;
  final db = BaseDatos('$datos/remisiones-movil.db');
  final s = ServidorMovil(
    db: db,
    puerto: puerto,
    lectorEstatico: (ruta) async {
      final f = File('$web/$ruta');
      return await f.exists() ? f.readAsBytes() : null;
    },
  );
  await s.iniciar();
  stdout.writeln('Servidor movil (prueba) en http://localhost:$puerto  datos: $datos  web: $web');
}
