// Construye la versión PORTABLE para Windows: un único ejecutable con Node.js, el servidor
// y la interfaz web incrustados (Node.js Single Executable Application, SEA).
// Uso: node scripts/construir-pc.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const raiz = path.resolve(__dirname, '..');
const srv = path.join(raiz, 'servidor-pc');
const build = path.join(srv, 'build');
const dist = path.join(raiz, 'dist', 'PC-Portable', 'Remisiones-DISTRIMOS');
const exe = path.join(dist, 'RemisionesDISTRIMOS.exe');

fs.rmSync(build, { recursive: true, force: true });
fs.mkdirSync(build, { recursive: true });

console.log('1/5 Empaquetando el servidor en un solo archivo (esbuild)…');
require(path.join(srv, 'node_modules', 'esbuild')).buildSync({
  entryPoints: [path.join(srv, 'src', 'main.js')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: path.join(build, 'servidor.cjs'),
  minify: false,
  legalComments: 'none',
});

console.log('2/5 Preparando la interfaz web como recursos incrustados…');
const assets = {};
(function recorrer(dir, rel) {
  for (const n of fs.readdirSync(dir)) {
    const abs = path.join(dir, n);
    const r = rel ? `${rel}/${n}` : n;
    if (fs.statSync(abs).isDirectory()) recorrer(abs, r);
    else assets[`web/${r}`] = abs;
  }
})(path.join(raiz, 'web'), '');
fs.writeFileSync(path.join(build, 'sea-config.json'), JSON.stringify({
  main: path.join(build, 'servidor.cjs'),
  output: path.join(build, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
  assets,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(build, 'sea-config.json')], { stdio: 'inherit' });

console.log('3/5 Creando el ejecutable a partir de Node.js', process.version, '…');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.copyFileSync(process.execPath, exe);

console.log('4/5 Inyectando el programa en el ejecutable (postject)…');
execFileSync(process.execPath, [path.join(srv, 'node_modules', 'postject', 'dist', 'cli.js'), exe, 'NODE_SEA_BLOB', path.join(build, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { stdio: 'inherit' });

console.log('5/5 Agregando archivos de apoyo…');
fs.writeFileSync(path.join(dist, 'config.json'), JSON.stringify({ puerto: 3580, abrir_navegador: true }, null, 2));
fs.writeFileSync(path.join(dist, 'LEEME.txt'), [
  'SISTEMA DE REMISIONES DISTRIMOS - VERSION PORTABLE PARA PC',
  '==========================================================',
  '',
  '1. Haga doble clic en RemisionesDISTRIMOS.exe.',
  '   Se abre una ventana negra (el servidor) y el navegador con el sistema.',
  '   NO cierre la ventana negra mientras use el sistema.',
  '2. Primer ingreso: usuario "admin", contraseña "admin123". Cámbiela en Mi cuenta.',
  '3. Los datos se guardan en %APPDATA%\\RemisionesDISTRIMOS\\datos (carpeta fija): NO se pierden al',
  '   reemplazar o volver a extraer el programa. Los respaldos diarios quedan en "datos\\respaldos".',
  '4. Para usar desde otro equipo o celular de la misma red Wi-Fi, use la dirección',
  '   "En la red local" que muestra la ventana del servidor (ej.: http://192.168.1.10:3580).',
  '   Si Windows pregunta por el Firewall, permita el acceso en "Redes privadas".',
  '5. Para cambiar el puerto, edite config.json.',
  '',
  'Se puede copiar toda esta carpeta a una memoria USB o a otro computador: no requiere instalación.',
].join('\r\n'));
const mb = (fs.statSync(exe).size / 1048576).toFixed(1);
console.log(`Listo: ${exe} (${mb} MB)`);
