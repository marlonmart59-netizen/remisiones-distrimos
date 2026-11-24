// App Android del Sistema de Remisiones DISTRIMOS.
// Al abrirse levanta su propio servidor HTTP interno (puerto 8765) con base de datos
// SQLite en el celular y muestra la interfaz en un WebView. Así funciona sin internet
// y sincroniza con el servidor PC de la oficina cuando hay conexión.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import 'servidor/db.dart';
import 'servidor/servidor.dart';

const int puertoLocal = 8765;
ServidorMovil? _servidor;

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(statusBarColor: Color(0xFF16324F), statusBarIconBrightness: Brightness.light));
  runApp(const AppRemisiones());
}

Future<void> iniciarServidor() async {
  if (_servidor != null) return;
  final dir = await getApplicationSupportDirectory();
  final db = BaseDatos('${dir.path}/remisiones-movil.db');
  final s = ServidorMovil(
    db: db,
    puerto: puertoLocal,
    lectorEstatico: (ruta) async {
      try {
        final d = await rootBundle.load('assets/web/$ruta');
        return d.buffer.asUint8List(d.offsetInBytes, d.lengthInBytes);
      } catch (_) {
        return null;
      }
    },
  );
  await s.iniciar();
  _servidor = s;
}

class AppRemisiones extends StatelessWidget {
  const AppRemisiones({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Remisiones DISTRIMOS',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: const Color(0xFF16324F), useMaterial3: true),
      home: const Pantalla(),
    );
  }
}

class Pantalla extends StatefulWidget {
  const Pantalla({super.key});
  @override
  State<Pantalla> createState() => _PantallaState();
}

class _PantallaState extends State<Pantalla> with WidgetsBindingObserver {
  WebViewController? _web;
  String? _error;
  bool _cargando = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _arrancar();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  Future<void> _arrancar() async {
    try {
      await iniciarServidor();
      final c = WebViewController()
        ..setJavaScriptMode(JavaScriptMode.unrestricted)
        ..setBackgroundColor(const Color(0xFFF3F5F8))
        ..setNavigationDelegate(NavigationDelegate(
          onPageFinished: (_) => setState(() => _cargando = false),
          onNavigationRequest: (r) =>
              r.url.startsWith('http://127.0.0.1:$puertoLocal') || r.url.startsWith('data:') || r.url.startsWith('blob:')
                  ? NavigationDecision.navigate
                  : NavigationDecision.prevent,
        ));
      final plataforma = c.platform;
      if (plataforma is AndroidWebViewController) {
        // Botón "Tomar foto" del formulario de entrega -> cámara del celular.
        await plataforma.setOnShowFileSelector(_seleccionarArchivo);
        await plataforma.setMediaPlaybackRequiresUserGesture(true);
      }
      await c.loadRequest(Uri.parse('http://127.0.0.1:$puertoLocal/'));
      setState(() => _web = c);
    } catch (e) {
      setState(() => _error = '$e');
    }
  }

  Future<List<String>> _seleccionarArchivo(FileSelectorParams p) async {
    final picker = ImagePicker();
    ImageSource fuente = ImageSource.camera;
    if (p.mode != FileSelectorMode.open || !p.acceptTypes.any((t) => t.startsWith('image'))) {
      fuente = ImageSource.gallery;
    } else if (!p.isCaptureEnabled && mounted) {
      final elegido = await showModalBottomSheet<ImageSource>(
        context: context,
        builder: (_) => SafeArea(
            child: Wrap(children: [
          ListTile(leading: const Icon(Icons.photo_camera), title: const Text('Tomar foto'), onTap: () => Navigator.pop(context, ImageSource.camera)),
          ListTile(leading: const Icon(Icons.photo_library), title: const Text('Elegir de la galería'), onTap: () => Navigator.pop(context, ImageSource.gallery)),
        ])),
      );
      if (elegido == null) return [];
      fuente = elegido;
    }
    final foto = await picker.pickImage(source: fuente, maxWidth: 1600, maxHeight: 1600, imageQuality: 85);
    if (foto == null) return [];
    return [Uri.file(foto.path).toString()];
  }

  Future<bool> _atras() async {
    final c = _web;
    if (c != null && await c.canGoBack()) {
      await c.goBack();
      return false;
    }
    return true;
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        if (await _atras()) SystemNavigator.pop();
      },
      child: Scaffold(
        backgroundColor: const Color(0xFF16324F),
        body: SafeArea(
          child: _error != null
              ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text('No se pudo iniciar el servidor interno:\n$_error', style: const TextStyle(color: Colors.white))))
              : Stack(children: [
                  if (_web != null) WebViewWidget(controller: _web!),
                  if (_cargando)
                    const ColoredBox(
                      color: Color(0xFF16324F),
                      child: Center(
                          child: Column(mainAxisSize: MainAxisSize.min, children: [
                        CircularProgressIndicator(color: Colors.white),
                        SizedBox(height: 16),
                        Text('Iniciando servidor interno…', style: TextStyle(color: Colors.white)),
                      ])),
                    ),
                ]),
        ),
      ),
    );
  }
}
