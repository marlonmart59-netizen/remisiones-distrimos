/* Service worker del Sistema de Remisiones DISTRIMOS.
 * - Guarda la aplicación para poder abrirla sin internet.
 * - Guarda las últimas respuestas de consulta (remisiones, clientes, productos...) para verlas sin conexión.
 * Las entregas hechas sin internet las guarda la propia aplicación (js/sin-conexion.js) y las envía al volver la señal.
 */
'use strict';
const SHELL = 'shell-v1';
const DATOS = 'datos-v1';
const PRECARGA = ['/', '/index.html', '/css/app.css', '/js/firma.js', '/js/escenas.js', '/js/sin-conexion.js', '/js/app.js', '/icono.svg', '/icono-512.png', '/manifest.webmanifest'];
// Solo se guardan consultas de datos operativos; nunca respaldos, auditoría, usuarios ni sincronización.
const CONSULTAS = /^\/api\/(info|ajustes-publicos|auth\/yo|remisiones(\/[^/]+)?|clientes|productos|contratos(\/[^/]+)?|panel|repartidores)$/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL)
    .then((c) => Promise.all(PRECARGA.map((u) => c.add(u).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== SHELL && k !== DATOS).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function conLimite(req, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(req, { signal: ctl.signal }).finally(() => clearTimeout(t));
}

async function consulta(req) {
  const cache = await caches.open(DATOS);
  try {
    const r = await conLimite(req, 12000);
    if (r.ok) cache.put(req.url, r.clone());
    return r;
  } catch (_) {
    const guardada = await cache.match(req.url);
    if (!guardada) return Response.error();
    const cab = new Headers(guardada.headers);
    cab.set('X-Desde-Cache', '1');
    return new Response(guardada.body, { status: 200, headers: cab });
  }
}

async function estatico(req) {
  const cache = await caches.open(SHELL);
  try {
    const r = await conLimite(req, 8000);
    if (r.ok) cache.put(req, r.clone());
    return r;
  } catch (_) {
    const g = await cache.match(req, { ignoreSearch: true });
    if (g) return g;
    if (req.mode === 'navigate') {
      const inicio = (await cache.match('/')) || (await cache.match('/index.html'));
      if (inicio) return inicio;
    }
    return Response.error();
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) {
    if (CONSULTAS.test(url.pathname)) e.respondWith(consulta(req));
    return;
  }
  e.respondWith(estatico(req));
});
