'use strict';
/**
 * Punto de entrada del servidor PC portable.
 * - Sirve la aplicación web (carpeta web/) y la API REST (/api).
 * - Guarda todo en una carpeta fija del usuario (%APPDATA%\RemisionesDISTRIMOS\datos), para que no se
 *   pierdan usuarios ni remisiones al reemplazar o extraer de nuevo el programa. Si existe una carpeta
 *   ./datos junto al ejecutable y aún no hay datos en la carpeta fija, se copia allí (migración única).
 * - Crea un respaldo automático diario.
 */
// Silencia el aviso "ExperimentalWarning" de node:sqlite para no confundir al usuario.
const emitirOriginal = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  const texto = typeof w === 'string' ? w : (w && w.message) || '';
  if (/SQLite|experimental/i.test(texto)) return;
  return emitirOriginal.call(process, w, ...rest);
};

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { execFile } = require('node:child_process');
const { BaseDatos, ahora, uuid } = require('./db');
const { hashClave, verificarClave, leerToken, secretoAleatorio } = require('./seguridad');
const { ErrorHttp, leerCuerpo, enviarJson, enviarBinario, TIPOS, CABECERAS_SEGURIDAD } = require('./http');
const { crearApi } = require('./api');

const VERSION = '1.0.0';

// ------------------------------------------------------------------ entorno
let sea = null;
try { sea = require('node:sea'); if (!sea.isSea()) sea = null; } catch (_) { sea = null; }

const dirBase = sea ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
const dirDatosLocal = path.join(dirBase, 'datos');
// En Railway: REMISIONES_DATOS (o RAILWAY_VOLUME_MOUNT_PATH) apunta al volumen persistente.
const dirDatos = process.env.REMISIONES_DATOS
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'datos') : null)
  || (sea ? dirDatosFija() : dirDatosLocal);

/** Carpeta fija de datos (independiente de dónde esté el .exe). */
function dirDatosFija() {
  const raiz = process.env.APPDATA || path.join(require('node:os').homedir(), 'AppData', 'Roaming');
  const fija = path.join(raiz, 'RemisionesDISTRIMOS', 'datos');
  try {
    if (!fs.existsSync(path.join(fija, 'remisiones.db')) && fs.existsSync(path.join(dirDatosLocal, 'remisiones.db'))) {
      fs.cpSync(dirDatosLocal, fija, { recursive: true }); // migración única: se conserva la carpeta original
    }
  } catch (e) { console.error('No se pudo migrar la carpeta de datos:', e.message); }
  return fija;
}
const dirWebDisco = path.resolve(__dirname, '..', '..', 'web');

function leerConfig() {
  const archivo = path.join(dirBase, 'config.json');
  const base = { puerto: 3580, abrir_navegador: true };
  try {
    if (!fs.existsSync(archivo)) fs.writeFileSync(archivo, JSON.stringify(base, null, 2));
    return { ...base, ...JSON.parse(fs.readFileSync(archivo, 'utf8')) };
  } catch (_) {
    return base;
  }
}
const config = leerConfig();
// En Railway (u otra nube) el puerto llega en PORT; en el PC se usa PUERTO o config.json.
const puerto = Number(process.env.PORT || process.env.PUERTO || config.puerto) || 3580;
const enNube = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.PORT);

/** Lee un archivo de la web: del ejecutable (modo portable) o del disco (modo desarrollo). */
function leerEstatico(ruta) {
  const limpia = path.posix.normalize(ruta).replace(/^(\.\.(\/|$))+/, '').replace(/^\/+/, '');
  if (sea) {
    try { return Buffer.from(sea.getAsset('web/' + limpia)); } catch (_) { return null; }
  }
  const archivo = path.join(dirWebDisco, limpia);
  if (!archivo.startsWith(dirWebDisco)) return null;
  try { return fs.statSync(archivo).isFile() ? fs.readFileSync(archivo) : null; } catch (_) { return null; }
}

// ------------------------------------------------------------------ base de datos
const db = new BaseDatos(path.join(dirDatos, 'remisiones.db'));
if (!db.config('secreto')) db.setConfig('secreto', secretoAleatorio());
if (!db.config('dispositivo_id')) db.setConfig('dispositivo_id', uuid());
if (!db.uno('SELECT id FROM usuarios LIMIT 1')) {
  const t = ahora();
  db.ejecutar(`INSERT INTO usuarios(id, usuario, nombre, rol, clave_hash, activo, debe_cambiar_clave, creado_en, actualizado_en)
    VALUES (?, 'admin', 'Administrador del sistema', 'admin', ?, 1, 0, ?, ?)`, uuid(), hashClave('admin123'), t, t);
  db.auditar('sistema', 'instalacion', 'Usuario inicial admin creado');
}
// El administrador inicial ya no está obligado a cambiar la contraseña al entrar (puede hacerlo en Mi cuenta).
const adminInicial = db.uno("SELECT id, clave_hash FROM usuarios WHERE usuario = 'admin' AND debe_cambiar_clave = 1");
if (adminInicial && verificarClave('admin123', adminInicial.clave_hash)) db.ejecutar('UPDATE usuarios SET debe_cambiar_clave = 0 WHERE id = ?', adminInicial.id);

const ctx = { db, dirDatos, version: VERSION, puerto, secreto: db.config('secreto') };
const api = crearApi(ctx);

// ------------------------------------------------------------------ servidor HTTP
async function manejar(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const ruta = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  if (ruta.startsWith('/api/')) {
    try {
      const encontrada = api.buscar(req.method, ruta);
      if (!encontrada) throw new ErrorHttp(404, 'Ruta no encontrada.');
      if (encontrada.metodoInvalido) throw new ErrorHttp(405, 'Método no permitido.');
      const { r, params } = encontrada;

      let usuario = null;
      if (r.roles !== null) {
        const auth = req.headers.authorization || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('t');
        const datos = leerToken(token, ctx.secreto);
        if (!datos) throw new ErrorHttp(401, 'Su sesión expiró. Inicie sesión de nuevo.');
        usuario = db.uno('SELECT * FROM usuarios WHERE id = ?', datos.uid);
        if (!usuario || !usuario.activo) throw new ErrorHttp(401, 'Usuario inactivo o inexistente.');
        if (r.roles !== '*' && !r.roles.includes(usuario.rol)) throw new ErrorHttp(403, 'Su rol no tiene permiso para esta acción.');
      }

      let body = {};
      let crudo = null;
      if (req.method === 'POST' || req.method === 'PUT') {
        const buf = await leerCuerpo(req, 80 * 1024 * 1024);
        if (r.opciones.crudo) crudo = buf;
        else if (buf.length) {
          try { body = JSON.parse(buf.toString('utf8')); } catch (_) { throw new ErrorHttp(400, 'JSON no válido.'); }
        }
      }
      const query = Object.fromEntries(url.searchParams.entries());
      const resultado = await r.manejador({ req, res, params, query, body, crudo, usuario });
      if (resultado && resultado.__binario) return enviarBinario(res, resultado.tipo, resultado.datos, resultado.cabeceras);
      return enviarJson(res, 200, resultado === undefined ? { ok: true } : resultado);
    } catch (e) {
      if (e instanceof ErrorHttp) return enviarJson(res, e.estado, { error: e.message, ...(e.extra || {}) });
      const mensaje = /UNIQUE/.test(e.message) ? 'Ya existe un registro con esos datos (valor repetido).'
        : /FOREIGN KEY/.test(e.message) ? 'El registro está relacionado con otros datos y no se puede guardar así.' : 'Error interno del servidor.';
      console.error(`[${new Date().toLocaleString()}] ${req.method} ${ruta}:`, e);
      return enviarJson(res, 500, { error: mensaje });
    }
  }

  // Archivos estáticos con respaldo a index.html (aplicación de una sola página)
  let archivo = ruta === '/' ? 'index.html' : ruta.slice(1);
  let datos = leerEstatico(archivo);
  if (!datos) { archivo = 'index.html'; datos = leerEstatico(archivo); }
  if (!datos) { res.writeHead(404); return res.end('No encontrado'); }
  const ext = path.extname(archivo).toLowerCase();
  res.writeHead(200, {
    ...CABECERAS_SEGURIDAD,
    'Content-Type': TIPOS[ext] || 'application/octet-stream',
    'Content-Length': datos.length,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'no-cache',
  });
  res.end(datos);
}

const servidor = http.createServer((req, res) => { manejar(req, res).catch((e) => { console.error(e); try { res.end(); } catch (_) { /* nada */ } }); });

servidor.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  El puerto ${puerto} ya está en uso. Probablemente el sistema ya está abierto.`);
    console.error(`  Abra http://localhost:${puerto} en el navegador, o cambie "puerto" en config.json.\n`);
    abrirNavegador(`http://localhost:${puerto}`);
    setTimeout(() => process.exit(1), 8000);
  } else {
    console.error(e);
  }
});

function abrirNavegador(url) {
  if (enNube || !config.abrir_navegador || process.env.NO_ABRIR) return;
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
  else if (process.platform === 'darwin') execFile('open', [url], () => {});
  else execFile('xdg-open', [url], () => {});
}

servidor.listen(puerto, '0.0.0.0', () => {
  const ips = require('node:os').networkInterfaces();
  const lan = [];
  for (const l of Object.values(ips)) for (const i of l || []) if (i.family === 'IPv4' && !i.internal) lan.push(i.address);
  console.log('');
  console.log('  ===============================================================');
  console.log('   SISTEMA DE REMISIONES DISTRIMOS  -  Servidor PC  v' + VERSION);
  console.log('  ===============================================================');
  console.log(`   En este computador:   http://localhost:${puerto}`);
  for (const ip of lan) console.log(`   En la red local:      http://${ip}:${puerto}`);
  console.log(`   Datos guardados en:   ${dirDatos}`);
  console.log('');
  console.log('   Primer ingreso: usuario "admin", contraseña "admin123"');
  console.log('   (el sistema le pedirá cambiarla).');
  console.log('');
  console.log('   NO cierre esta ventana mientras use el sistema.');
  console.log('  ===============================================================');
  console.log('');
  abrirNavegador(`http://localhost:${puerto}`);
});

// Respaldo automático: al iniciar si el último tiene más de 20 horas, y luego cada 24 horas.
function respaldoAutomatico() {
  try {
    const ultimo = db.config('ultimo_respaldo');
    if (!ultimo || Date.now() - Date.parse(ultimo) > 20 * 3600e3) {
      const nombre = ctx.crearRespaldo('auto');
      db.auditar('sistema', 'respaldo_automatico', nombre);
      console.log(`   Respaldo automático creado: ${nombre}`);
    }
  } catch (e) {
    console.error('   No se pudo crear el respaldo automático:', e.message);
  }
}
setTimeout(respaldoAutomatico, 3000);
setInterval(respaldoAutomatico, 3600e3).unref();

function cerrar() {
  console.log('\n  Cerrando el servidor...');
  servidor.close();
  db.cerrar();
  process.exit(0);
}
process.on('SIGINT', cerrar);
process.on('SIGTERM', cerrar);
