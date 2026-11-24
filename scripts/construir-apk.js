// Construye la APK de Android: copia la interfaz web dentro de la app y compila con Flutter.
// Uso: node scripts/construir-apk.js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const raiz = path.resolve(__dirname, '..');
const app = path.join(raiz, 'app-movil');
const destinoWeb = path.join(app, 'assets', 'web');
const dist = path.join(raiz, 'dist', 'Android');

console.log('1/3 Copiando interfaz web a la app…');
fs.rmSync(destinoWeb, { recursive: true, force: true });
fs.cpSync(path.join(raiz, 'web'), destinoWeb, { recursive: true });

console.log('2/3 Compilando APK de producción (flutter build apk --release)…');
execSync('flutter build apk --release', { cwd: app, stdio: 'inherit', shell: true });

console.log('3/3 Copiando resultado a dist/Android…');
fs.mkdirSync(dist, { recursive: true });
const version = /^version:\s*([\d.]+)/m.exec(fs.readFileSync(path.join(app, 'pubspec.yaml'), 'utf8'))[1];
const salida = path.join(dist, `Remisiones-DISTRIMOS-v${version}.apk`);
fs.copyFileSync(path.join(app, 'build', 'app', 'outputs', 'flutter-apk', 'app-release.apk'), salida);
console.log('Listo:', salida, `(${(fs.statSync(salida).size / 1048576).toFixed(1)} MB)`);
