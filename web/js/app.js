/* Sistema de Remisiones DISTRIMOS — aplicación web (una sola página).
 * La misma interfaz funciona contra el servidor PC y contra el servidor interno de la app Android.
 * Las diferencias se leen de /api/info -> capacidades.
 */
(function () {
  'use strict';

  // ================================================================ estado y utilidades
  const S = {
    token: leer('rem_token'),
    usuario: null,
    info: null,
    empresa: null,
    syncTimer: null,
  };

  function leer(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function guardar(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { /* sin almacenamiento */ } }

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const esc = (v) => (v === null || v === undefined ? '' : String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const fmtNum = (n, dec = 0) => Number(n || 0).toLocaleString('es-CO', { maximumFractionDigits: dec, minimumFractionDigits: 0 });
  const fmtPeso = (n) => '$ ' + Number(n || 0).toLocaleString('es-CO', { maximumFractionDigits: 0 });
  const fmtPct = (n) => `${fmtNum(n, 1)} %`;
  function fmtFecha(f) {
    if (!f) return '';
    const s = String(f);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const [a, m, d] = s.split('-'); return `${d}/${m}/${a}`; }
    const d = new Date(s);
    return isNaN(d) ? s : d.toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function fmtFechaHora(f) {
    if (!f) return '';
    const d = new Date(f);
    return isNaN(d) ? String(f) : d.toLocaleString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  const hoy = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const rol = () => (S.usuario ? S.usuario.rol : null);
  const es = (...roles) => roles.includes(rol());
  const cap = (k) => !!(S.info && S.info.capacidades && S.info.capacidades[k]);
  const esMovil = () => S.info && S.info.modo === 'movil';
  const NOMBRE_ROL = { admin: 'Administrador', gerente: 'Gerente', secretario: 'Secretario(a)', repartidor: 'Repartidor', cliente: 'Cliente' };
  const NOMBRE_TIPO = { publico: 'Entidad pública', privado: 'Privado', fundacion: 'Fundación', colegio: 'Colegio' };

  // ================================================================ API
  async function api(metodo, ruta, cuerpo, opciones = {}) {
    const cab = {};
    if (S.token) cab.Authorization = 'Bearer ' + S.token;
    let body;
    if (cuerpo instanceof Blob || cuerpo instanceof ArrayBuffer) { body = cuerpo; cab['Content-Type'] = 'application/octet-stream'; }
    else if (cuerpo !== undefined) { body = JSON.stringify(cuerpo); cab['Content-Type'] = 'application/json'; }
    let r;
    try {
      r = await fetch(ruta, { method: metodo, headers: cab, body });
    } catch (e) {
      marcarSinConexion(true);
      const m = metodo === 'POST' && RE_ENTREGA.exec(ruta);
      if (m && modoWeb() && S.usuario) return encolarEntrega(m[1], cuerpo);
      throw new Error('No hay conexión con el servidor. Verifique que el programa del servidor esté abierto.');
    }
    marcarSinConexion(!!r.headers.get('X-Desde-Cache'));
    if (opciones.binario) {
      if (!r.ok) throw new Error('No se pudo descargar el archivo.');
      return r.blob();
    }
    let datos = {};
    try { datos = await r.json(); } catch (_) { datos = {}; }
    if (r.status === 401 && ruta !== '/api/auth/login' && !ruta.startsWith('/api/sync/vincular')) {
      cerrarSesion(false);
      throw new Error(datos.error || 'Su sesión expiró.');
    }
    if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);
    return metodo === 'GET' && modoWeb() ? superponerPendientes(ruta, datos) : datos;
  }

  // ================================================================ modo sin internet (versión web / nube)
  // Las consultas se guardan en el navegador (service worker) y las entregas hechas sin señal se guardan
  // en una cola local (IndexedDB) que se envía sola cuando vuelve la conexión.
  const RE_ENTREGA = /^\/api\/remisiones\/([^/?]+)\/entrega$/;
  const modoWeb = () => !!(S.info && S.info.modo === 'pc');
  S.sinConexion = false;
  let vaciando = false;

  function marcarSinConexion(v) {
    if (S.sinConexion !== v) { S.sinConexion = v; actualizarBanner(); }
  }

  function actualizarBanner() {
    const el = document.getElementById('banner-conexion');
    if (!el) return;
    const n = window.SinConexion ? window.SinConexion.cantidad() : 0;
    const sin = S.sinConexion || !navigator.onLine;
    const txt = n === 1 ? '1 entrega guardada' : `${n} entregas guardadas`;
    if (!modoWeb() || (!sin && !n)) { el.className = 'oculto'; el.textContent = ''; return; }
    el.className = sin ? 'sin-conexion' : 'enviando';
    el.textContent = sin
      ? `Sin conexión: trabajando sin internet${n ? ` · ${txt} en este equipo, se enviarán al volver la señal` : ''}`
      : `Enviando ${txt}…`;
  }

  async function encolarEntrega(remisionId, datos) {
    const cache = await caches.open('datos-v1').catch(() => null);
    let numero = '';
    if (cache) {
      const g = await cache.match(`${location.origin}/api/remisiones/${remisionId}`);
      if (g) { try { numero = (await g.json()).numero || ''; } catch (_) { /* sin número */ } }
    }
    try {
      await window.SinConexion.encolar({ remisionId, numero, usuarioId: S.usuario.id, datos, recibida: new Date().toISOString() });
    } catch (e) {
      throw new Error('No hay conexión y no se pudo guardar la entrega en este equipo: ' + e.message);
    }
    actualizarBanner();
    toast('Sin internet: la entrega quedó guardada en este equipo y se enviará sola al volver la conexión.', 'ok');
    return { ok: true, encolada: true, numero };
  }

  /** Muestra como "entregada · sin enviar" lo que está en la cola, para que el repartidor lo vea reflejado. */
  function superponerPendientes(ruta, datos) {
    if (!window.SinConexion || !window.SinConexion.cantidad()) return datos;
    const marcar = (r) => {
      const p = r && window.SinConexion.de(r.id);
      return p ? { ...r, estado: 'entregada', pendiente_sync: 1, entregada_en: p.recibida, receptor_nombre: p.datos.receptor_nombre, evidencias: r.evidencias ? [] : r.evidencias } : r;
    };
    const [base, qs = ''] = ruta.split('?');
    if (base === '/api/remisiones' && Array.isArray(datos)) {
      const soloPendientes = /(^|&)estado=pendiente(&|$)/.test(qs);
      return soloPendientes ? datos.filter((r) => !window.SinConexion.de(r.id)) : datos.map(marcar);
    }
    if (/^\/api\/remisiones\/[^/]+$/.test(base) && datos && datos.id) return marcar(datos);
    return datos;
  }

  /** Envía al servidor las entregas guardadas sin conexión (en orden). */
  async function vaciarCola() {
    if (vaciando || !modoWeb() || !S.usuario || !S.token || !window.SinConexion) return;
    const mias = window.SinConexion.items().filter((i) => i.usuarioId === S.usuario.id);
    if (!mias.length || !navigator.onLine) { actualizarBanner(); return; }
    vaciando = true;
    let enviadas = 0;
    try {
      for (const it of mias) {
        let r;
        try {
          r = await fetch(`/api/remisiones/${encodeURIComponent(it.remisionId)}/entrega`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.token }, body: JSON.stringify(it.datos),
          });
        } catch (_) { marcarSinConexion(true); break; }
        let d = {};
        try { d = await r.json(); } catch (_) { d = {}; }
        if (r.status === 401) { toast('Su sesión expiró. Inicie sesión de nuevo para enviar las entregas guardadas.', 'error'); cerrarSesion(false); break; }
        if (r.ok || (r.status === 400 && /ya está entregada/.test(d.error || ''))) { await window.SinConexion.quitar(it.id); enviadas++; continue; }
        if (r.status >= 500) break; // se reintenta luego
        await window.SinConexion.quitar(it.id);
        toast(`La entrega ${it.numero || ''} no se pudo registrar: ${d.error || 'error ' + r.status}`, 'error');
      }
    } finally { vaciando = false; }
    actualizarBanner();
    if (enviadas) {
      toast(`${enviadas} entrega${enviadas === 1 ? '' : 's'} enviada${enviadas === 1 ? '' : 's'} al servidor.`, 'ok');
      precargar();
      if (S.usuario) enrutar();
    }
  }

  /** Con internet, deja guardado lo que el usuario necesitará si luego se queda sin señal. */
  async function precargar() {
    if (!modoWeb() || !S.usuario || !S.token || !navigator.onLine) return;
    const h = { Authorization: 'Bearer ' + S.token };
    const pedir = (u) => fetch(u, { headers: h }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const pendientes = await pedir('/api/remisiones?estado=pendiente');
    await Promise.all(['/api/panel', '/api/remisiones', '/api/clientes', '/api/productos', '/api/contratos', '/api/info', '/api/ajustes-publicos', '/api/auth/yo'].map(pedir));
    if (Array.isArray(pendientes)) for (const r of pendientes.slice(0, 60)) await pedir(`/api/remisiones/${encodeURIComponent(r.id)}`);
  }

  function iniciarModoSinConexion() {
    if (!modoWeb()) return;
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    window.addEventListener('online', () => { marcarSinConexion(false); vaciarCola().then(precargar); });
    window.addEventListener('offline', () => marcarSinConexion(true));
    setInterval(() => { if (window.SinConexion.cantidad()) vaciarCola(); }, 20000);
    setInterval(precargar, 5 * 60 * 1000);
    actualizarBanner();
    vaciarCola();
    precargar();
  }

  function limpiarDatosOffline() {
    try { if (window.caches) caches.delete('datos-v1'); } catch (_) { /* nada */ }
  }

  // ================================================================ notificaciones y diálogos
  function toast(msg, tipo = '') {
    const t = document.createElement('div');
    t.className = 'toast ' + tipo;
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), tipo === 'error' ? 6500 : 3500);
  }

  function modal(html, { ancho = false, alMontar } = {}) {
    const fondo = document.createElement('div');
    fondo.className = 'modal-fondo';
    fondo.innerHTML = `<div class="modal ${ancho ? 'ancho' : ''}" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(fondo);
    const cerrar = () => fondo.remove();
    fondo.addEventListener('click', (e) => { if (e.target === fondo) cerrar(); });
    $$('[data-cerrar]', fondo).forEach((b) => b.addEventListener('click', cerrar));
    const el = $('.modal', fondo);
    if (alMontar) alMontar(el, cerrar);
    const primero = $('input:not([type=hidden]), select, textarea', el);
    if (primero) setTimeout(() => primero.focus(), 50);
    return { el, cerrar };
  }

  function confirmar(titulo, texto, { boton = 'Confirmar', peligro = false } = {}) {
    return new Promise((resolve) => {
      modal(`<h2>${esc(titulo)}</h2><p>${esc(texto)}</p>
        <div class="pie"><button class="btn" data-cerrar>Cancelar</button><button class="btn ${peligro ? 'peligro' : 'primario'}" id="m-ok">${esc(boton)}</button></div>`, {
        alMontar: (el, cerrar) => {
          $('#m-ok', el).onclick = () => { cerrar(); resolve(true); };
          $$('[data-cerrar]', el).forEach((b) => b.addEventListener('click', () => resolve(false)));
        },
      });
    });
  }

  function pedirTexto(titulo, etiqueta, { minimo = 5, boton = 'Guardar', ayuda = '' } = {}) {
    return new Promise((resolve) => {
      modal(`<h2>${esc(titulo)}</h2>${ayuda ? `<div class="aviso info">${esc(ayuda)}</div>` : ''}
        <label class="campo"><span>${esc(etiqueta)}</span><textarea id="m-txt" maxlength="500"></textarea></label>
        <div class="pie"><button class="btn" data-cerrar>Cancelar</button><button class="btn primario" id="m-ok">${esc(boton)}</button></div>`, {
        alMontar: (el, cerrar) => {
          $('#m-ok', el).onclick = () => {
            const v = $('#m-txt', el).value.trim();
            if (v.length < minimo) { toast(`Escriba al menos ${minimo} caracteres.`, 'error'); return; }
            cerrar(); resolve(v);
          };
          $$('[data-cerrar]', el).forEach((b) => b.addEventListener('click', () => resolve(null)));
        },
      });
    });
  }

  function verImagen(src, titulo) {
    modal(`<h2>${esc(titulo)}</h2><img class="visor-img" src="${esc(src)}" alt="${esc(titulo)}"><div class="pie"><button class="btn" data-cerrar>Cerrar</button></div>`, { ancho: true });
  }

  function formDatos(form) {
    const d = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') d[el.name] = el.checked;
      else d[el.name] = el.value;
    }
    return d;
  }

  async function conBoton(boton, fn) {
    const txt = boton.innerHTML;
    boton.disabled = true;
    boton.innerHTML = 'Procesando…';
    try { return await fn(); } finally { boton.disabled = false; boton.innerHTML = txt; }
  }

  // ================================================================ iconos (SVG en línea)
  const I = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICONO = {
    inicio: I('<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
    remisiones: I('<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>'),
    contratos: I('<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/>'),
    clientes: I('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.8 3 2.6 3.5 5.2"/>'),
    productos: I('<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="m3 7.5 9 4.5 9-4.5M12 12v9"/>'),
    usuarios: I('<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4.5 4.3-7 8-7s7 2.5 8 7"/>'),
    respaldos: I('<path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>'),
    auditoria: I('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M8 11h6M11 8v6"/>'),
    ajustes: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    sync: I('<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>'),
    cuenta: I('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3"/><path d="M6.5 18.5c1.3-2 3.2-3 5.5-3s4.2 1 5.5 3"/>'),
    mas: I('<path d="M12 5v14M5 12h14"/>'),
    volver: I('<path d="M15 18l-6-6 6-6"/>'),
    imprimir: I('<path d="M6 9V3h12v6M6 18H4v-7h16v7h-2"/><path d="M6 14h12v7H6z"/>'),
    entrega: I('<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>'),
    editar: I('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
    descargar: I('<path d="M12 3v12m0 0-4-4m4 4 4-4M4 19h16"/>'),
    salir: I('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
    camara: I('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
    politica: I('<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>'),
    reloj: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    check: I('<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>'),
    dinero: I('<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6.5 9.5v5M17.5 9.5v5"/>'),
    caja: I('<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="m3 7.5 9 4.5 9-4.5M12 12v9"/>'),
    porcentaje: I('<path d="M19 5 5 19"/><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/>'),
  };

  // ================================================================ menú por rol
  function opcionesMenu() {
    const o = [{ r: 'inicio', t: 'Inicio', i: 'inicio' }];
    if (es('cliente')) {
      o.push({ r: 'remisiones', t: 'Entregas recibidas', i: 'remisiones', corto: 'Entregas' });
      o.push({ r: 'contratos', t: 'Mis contratos', i: 'contratos', corto: 'Contratos' });
    } else {
      o.push({ r: 'remisiones', t: 'Remisiones', i: 'remisiones' });
      o.push({ r: 'contratos', t: 'Contratos', i: 'contratos' });
    }
    if (es('admin', 'gerente', 'secretario')) o.push({ r: 'clientes', t: 'Clientes', i: 'clientes' });
    if (es('admin', 'secretario')) o.push({ r: 'productos', t: 'Productos', i: 'productos' });
    if (cap('sync_movil') && !es('cliente')) o.push({ r: 'sincronizacion', t: 'Sincronización', i: 'sync', corto: 'Sincronizar' });
    if (cap('usuarios') && es('admin')) o.push({ r: 'usuarios', t: 'Usuarios', i: 'usuarios' });
    if (cap('respaldos') && es('admin')) o.push({ r: 'respaldos', t: 'Respaldos', i: 'respaldos' });
    if (es('admin', 'gerente')) o.push({ r: 'auditoria', t: 'Auditoría', i: 'auditoria' });
    if (es('admin')) o.push({ r: 'ajustes', t: 'Ajustes', i: 'ajustes' });
    o.push({ r: 'cuenta', t: 'Mi cuenta', i: 'cuenta' });
    return o;
  }

  function opcionesMovil() {
    const todas = opcionesMenu();
    const prioridad = ['inicio', 'remisiones', 'contratos', 'sincronizacion', 'clientes'];
    const elegidas = prioridad.map((r) => todas.find((o) => o.r === r)).filter(Boolean).slice(0, 4);
    elegidas.push({ r: 'mas', t: 'Más', i: 'mas' });
    return elegidas;
  }

  // ================================================================ estructura
  function pintarEstructura(seccion, titulo, html, { volver = null, accionesBarra = '' } = {}) {
    const menu = opcionesMenu();
    $('#raiz').innerHTML = `
      <div class="app">
        <aside class="menu">
          <div class="marca">${Escenas.logo(40)}<div><b>${esc(S.empresa ? S.empresa.empresa_nombre : 'DISTRIMOS S.A.S')}</b><span>Sistema de remisiones${esMovil() ? ' · Móvil' : ''}</span></div></div>
          <div class="banda-wayuu" aria-hidden="true"></div>
          <nav>${menu.map((o) => `<a href="#/${o.r}" class="${seccion === o.r ? 'activo' : ''}">${ICONO[o.i]}${esc(o.t)}</a>`).join('')}
            <a href="#/politica" class="${seccion === 'politica' ? 'activo' : ''}">${ICONO.politica}Tratamiento de datos</a></nav>
          <div class="usuario"><div class="avatar">${esc((S.usuario.nombre || '?').trim().split(/\s+/).slice(0, 2).map((x) => x[0]).join('').toUpperCase())}</div>
            <div class="usuario-datos"><b>${esc(S.usuario.nombre)}</b><span>${esc(NOMBRE_ROL[S.usuario.rol])}</span></div>
            <button class="btn-salir" id="btn-salir" title="Cerrar sesión" aria-label="Cerrar sesión">${ICONO.salir}</button></div>
        </aside>
        <div class="contenido">
          <header class="barra">
            ${volver ? `<a class="btn chico texto volver" href="${esc(volver)}" aria-label="Volver">${ICONO.volver}</a>` : ''}
            <h1>${esc(titulo)}</h1>
            <span id="indicador-sync"></span>
            ${accionesBarra}
          </header>
          <main class="pagina">${html}</main>
        </div>
        <nav class="nav-movil">${opcionesMovil().map((o) => `<a href="#/${o.r}" class="${seccion === o.r || (o.r === 'mas' && !opcionesMovil().some((x) => x.r === seccion)) ? 'activo' : ''}">${ICONO[o.i]}<span>${esc(o.corto || o.t)}</span></a>`).join('')}</nav>
      </div>`;
    $('#btn-salir').onclick = () => cerrarSesion(true);
    actualizarIndicadorSync();
    window.scrollTo(0, 0);
  }

  // ================================================================ sesión
  function cerrarSesion(preguntar) {
    const hacer = () => {
      S.token = null; S.usuario = null;
      guardar('rem_token', null);
      if (preguntar) { guardar('rem_ultimo_uid', null); limpiarDatosOffline(); }
      if (S.syncTimer) { clearInterval(S.syncTimer); S.syncTimer = null; }
      location.hash = '#/login';
      enrutar();
    };
    if (!preguntar) return hacer();
    confirmar('Cerrar sesión', '¿Desea salir del sistema?', { boton: 'Salir' }).then((ok) => ok && hacer());
  }

  async function vistaLogin() {
    let estadoSync = null;
    if (cap('sync_movil')) { try { estadoSync = await api('GET', '/api/sync/estado'); } catch (_) { estadoSync = null; } }
    const sinVincular = cap('sync_movil') && estadoSync && !estadoSync.vinculado;
    $('#raiz').innerHTML = `
      <div class="login-pantalla">
        <section class="login-escena">
          <div class="login-marca">${Escenas.logo(44)}<div><b>${esc(S.empresa ? S.empresa.empresa_nombre : 'DISTRIMOS S.A.S')}</b><span>Morrales, kits escolares y confecciones</span></div></div>
          <div class="login-titular"><h2>Cada entrega, <em>respaldada</em>.</h2><p>Remisiones con firma, foto, fecha y hora, aunque no haya señal en la ruta.</p></div>
          <div class="escena-cont">${Escenas.ruta('grande')}</div>
          <ul class="login-puntos"><li>${ICONO.entrega}<span>Firma y foto en el momento de la entrega</span></li><li>${ICONO.sync}<span>Funciona sin internet y sincroniza solo</span></li><li>${ICONO.contratos}<span>Avance y balance de cada contrato</span></li></ul>
          <div class="banda-wayuu" aria-hidden="true"></div>
        </section>
        <section class="login-form-cont">
        <form class="login" id="f-login" autocomplete="on">
          <h1>Ingresar</h1>
          <p class="muted">Sistema de remisiones${esMovil() ? ' · aplicación del repartidor' : ''}</p>
          ${sinVincular ? `<div class="aviso info">Este celular aún no está vinculado con el servidor de la oficina. Vincúlelo para recibir sus remisiones y enviar las entregas.<br><a href="#/vincular"><b>Vincular con la oficina</b></a></div>` : ''}
          <label class="campo"><span>Usuario</span><input name="usuario" autocomplete="username" required autocapitalize="none"></label>
          <label class="campo"><span>Contraseña</span><input name="clave" type="password" autocomplete="current-password" required></label>
          <div id="login-error"></div>
          <button class="btn primario grande" type="submit">Ingresar</button>
          ${cap('sync_movil') && estadoSync && estadoSync.vinculado ? `<p class="small muted" style="margin-top:14px">Vinculado con: ${esc(estadoSync.servidor)}</p>` : ''}
          <p class="small muted" style="margin-top:14px"><a href="#/politica">Política de tratamiento de datos</a></p>
        </form>
        </section>
      </div>`;
    $('#f-login').onsubmit = async (e) => {
      e.preventDefault();
      const d = formDatos(e.target);
      const btn = $('button[type=submit]', e.target);
      try {
        await conBoton(btn, async () => {
          const r = await api('POST', '/api/auth/login', d);
          iniciarSesion(r);
        });
      } catch (er) {
        $('#login-error').innerHTML = `<div class="aviso error">${esc(er.message)}</div>`;
      }
    };
  }

  function iniciarSesion(r) {
    S.token = r.token; S.usuario = r.usuario;
    guardar('rem_token', r.token);
    if (leer('rem_ultimo_uid') !== r.usuario.id) limpiarDatosOffline(); // otro usuario en el mismo equipo: no mostrar datos del anterior
    guardar('rem_ultimo_uid', r.usuario.id);
    location.hash = '#/inicio';
    if (modoWeb()) { vaciarCola(); precargar(); }
    iniciarSyncAutomatica();
    enrutar();
  }

  // ================================================================ sincronización (solo app móvil)
  let ultimoEstadoSync = null;
  async function actualizarIndicadorSync(forzar) {
    const el = $('#indicador-sync');
    if (!cap('sync_movil') || !S.usuario) return;
    try {
      if (forzar || !ultimoEstadoSync) ultimoEstadoSync = await api('GET', '/api/sync/estado');
      const e = ultimoEstadoSync;
      const elActual = $('#indicador-sync');
      if (!elActual) return;
      if (!e.vinculado) elActual.innerHTML = `<a href="#/sincronizacion" class="estado-sync pend">Sin vincular</a>`;
      else if (e.pendientes > 0) elActual.innerHTML = `<a href="#/sincronizacion" class="estado-sync pend">${e.pendientes} por enviar</a>`;
      else elActual.innerHTML = `<a href="#/sincronizacion" class="estado-sync">Al día</a>`;
    } catch (_) { if (el) el.innerHTML = ''; }
  }

  function iniciarSyncAutomatica() {
    if (!cap('sync_movil') || S.syncTimer) return;
    S.syncTimer = setInterval(() => actualizarIndicadorSync(true), 30000);
  }

  function sincronizarEnSegundoPlano() {
    if (!cap('sync_movil')) return;
    api('POST', '/api/sync/ejecutar', {}).then(() => actualizarIndicadorSync(true)).catch(() => actualizarIndicadorSync(true));
  }

  // ================================================================ componentes de presentación
  function chipEstado(r) {
    let h = `<span class="chip ${esc(r.estado)}">${esc({ pendiente: 'Por entregar', entregada: 'Entregada', anulada: 'Anulada' }[r.estado] || r.estado)}</span>`;
    if (r.editada) h += ` <span class="chip editada" title="Esta remisión fue modificada después de creada">Editada</span>`;
    if (r.pendiente_sync) h += ` <span class="chip sync" title="Aún no se ha enviado al servidor de la oficina">Sin enviar</span>`;
    return h;
  }

  function barraAvance(pct, transitoPct = 0) {
    const p = Math.max(0, Math.min(100, pct || 0));
    const t = Math.max(0, Math.min(100 - p, transitoPct || 0));
    return `<div class="barra-doble" title="${fmtPct(p)} entregado"><div style="width:${p}%;background:var(--ok)"></div><div style="width:${t}%;background:#f0c48d"></div></div>`;
  }

  function kpi(valor, texto, clase = '', icono = '') {
    return `<div class="kpi ${clase}">${icono && ICONO[icono] ? `<div class="kpi-ico">${ICONO[icono]}</div>` : ''}<div class="kpi-txt"><div class="v">${valor}</div><div class="t">${esc(texto)}</div></div></div>`;
  }

  /** Encabezado ilustrado con el camión en ruta. */
  function hero(titulo, texto, acciones = '') {
    return `<div class="hero"><div class="hero-txt"><span class="hero-fecha">${esc(new Date().toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' }))}</span>
      <h2>${titulo}</h2><p>${texto}</p>${acciones ? `<div class="acciones">${acciones}</div>` : ''}</div>
      <div class="hero-escena" aria-hidden="true">${Escenas.ruta('banda')}</div></div>`;
  }
  const primerNombre = () => esc(String(S.usuario.nombre || '').split(/\s+/)[0]);

  function tablaContratos(lista, { economico = true } = {}) {
    if (!lista.length) return '<div class="vacio">No hay contratos activos.</div>';
    return `<div class="tabla-cont"><table class="tabla"><thead><tr>
      <th>Contrato</th><th>Cliente</th><th class="num">Contratado</th><th class="num">Entregado</th><th class="num">Falta</th>
      <th style="min-width:140px">Avance</th>${economico ? '<th class="num">Valor entregado</th><th class="num">Saldo por entregar</th>' : ''}</tr></thead><tbody>
      ${lista.map((c) => `<tr class="clic" data-ir="#/contratos/${esc(c.id)}">
        <td><b>${esc(c.codigo)}</b></td><td>${esc(c.cliente_nombre)}</td>
        <td class="num">${fmtNum(c.avance.contratado)}</td><td class="num">${fmtNum(c.avance.entregado)}</td><td class="num">${fmtNum(c.avance.pendiente)}</td>
        <td>${barraAvance(c.avance.porcentaje, c.avance.contratado ? (c.avance.en_transito / c.avance.contratado) * 100 : 0)}<div class="small muted">${fmtPct(c.avance.porcentaje)}</div></td>
        ${economico ? `<td class="num">${fmtPeso(c.avance.valor_entregado)}</td><td class="num">${fmtPeso(c.avance.saldo_valor)}</td>` : ''}
      </tr>`).join('')}</tbody></table></div>
      <p class="small muted" style="margin:8px 0 0">Verde: entregado con firma. Naranja: en camino (remisiones por entregar).</p>`;
  }

  function activarFilasClic(raiz = document) {
    $$('[data-ir]', raiz).forEach((el) => el.addEventListener('click', () => { location.hash = el.dataset.ir; }));
  }

  // ================================================================ vistas: inicio
  async function vistaInicio() {
    pintarEstructura('inicio', 'Inicio', '<div class="cargando">Cargando…</div>');
    const p = await api('GET', '/api/panel');
    let html = '';

    if (p.rol === 'cliente') {
      html += hero(`${Escenas.saludo()}, ${esc(p.cliente)}`, 'Aquí ve lo que ha recibido de cada contrato, lo que falta y el porcentaje de avance.');
      html += p.contratos.map((c) => `
        <div class="tarjeta"><div class="tarjeta-titulo"><h2>${esc(c.codigo)}</h2><span class="chip gris">${esc(c.estado)}</span></div>
          <p class="muted" style="margin-top:0">${esc(c.objeto || '')}</p>
          <div class="grid grid-3" style="margin-bottom:12px">${kpi(fmtNum(c.avance.entregado), 'Unidades recibidas', 'ok', 'check')}${kpi(fmtNum(c.avance.pendiente), 'Unidades que faltan', 'alerta', 'reloj')}${kpi(fmtPct(c.avance.porcentaje), 'Avance del contrato', '', 'porcentaje')}</div>
          ${barraAvance(c.avance.porcentaje)}
          <div class="acciones" style="margin-top:12px"><a class="btn" href="#/contratos/${esc(c.id)}">Ver detalle y entregas</a></div>
        </div>`).join('') || '<div class="tarjeta vacio">No tiene contratos registrados.</div>';
      if (p.recientes.length) {
        html += `<div class="tarjeta"><h2>Últimas entregas recibidas</h2><div class="tabla-cont"><table class="tabla"><thead><tr><th>Remisión</th><th>Contrato</th><th>Recibida</th><th>Recibió</th><th class="num">Unidades</th></tr></thead><tbody>
          ${p.recientes.map((r) => `<tr class="clic" data-ir="#/remisiones/${esc(r.id)}"><td><b>${esc(r.numero)}</b></td><td>${esc(r.contrato_codigo || '')}</td><td>${fmtFechaHora(r.entregada_en)}</td><td>${esc(r.receptor_nombre || '')}</td><td class="num">${fmtNum(r.unidades)}</td></tr>`).join('')}
          </tbody></table></div></div>`;
      }
    } else if (p.rol === 'repartidor') {
      const n = p.kpis.pendientes;
      html += hero(`¡Buen camino, ${primerNombre()}!`, n ? `Tiene <b>${n}</b> entrega${n === 1 ? '' : 's'} por hacer. Cada firma queda guardada aunque no haya señal.` : 'No tiene entregas pendientes. Todo está al día.');
      html += `<div class="grid grid-3" style="margin-bottom:16px">${kpi(n, 'Por entregar', n ? 'alerta' : '', 'reloj')}${kpi(p.kpis.entregadas_hoy, 'Entregadas hoy', 'ok', 'check')}${kpi(p.kpis.entregadas_mes, 'Entregadas este mes', '', 'entrega')}</div>`;
      html += `<div class="tarjeta"><h2>Remisiones por entregar</h2>`;
      html += p.pendientes.length ? `<div class="lista-tarjetas">${p.pendientes.map((r) => `
        <div class="item-tarjeta" data-ir="#/remisiones/${esc(r.id)}">
          <div class="cuerpo"><b>${esc(r.numero)} · ${esc(r.cliente_nombre)}</b>
            <div class="muted">${esc(r.municipio || '')} ${r.direccion_entrega ? '· ' + esc(r.direccion_entrega) : ''}</div>
            <div class="muted">${fmtNum(r.unidades)} unidades ${r.contrato_codigo ? '· ' + esc(r.contrato_codigo) : ''} · ${fmtFecha(r.fecha)}</div></div>
          <a class="btn primario" href="#/remisiones/${esc(r.id)}/entrega" onclick="event.stopPropagation()">${ICONO.entrega} Entregar</a>
        </div>`).join('')}</div>` : '<div class="vacio">No tiene remisiones pendientes. ¡Buen trabajo!</div>';
      html += `</div>`;
      html += `<div class="tarjeta"><h2>Avance de sus contratos</h2>${tablaContratos(p.contratos, { economico: false })}</div>`;
    } else {
      const k = p.kpis;
      html += hero(`${Escenas.saludo()}, ${primerNombre()}`,
        k.pendientes ? `Hay <b>${fmtNum(k.pendientes)}</b> remisión(es) en camino y <b>${fmtNum(k.contratos_activos)}</b> contrato(s) activo(s).` : `Todas las remisiones están entregadas. Hay <b>${fmtNum(k.contratos_activos)}</b> contrato(s) activo(s).`,
        es('secretario') ? `<a class="btn acento" href="#/remisiones/nueva">${ICONO.mas} Nueva remisión</a><a class="btn claro" href="#/remisiones?estado=pendiente">Ver pendientes</a>` : `<a class="btn claro" href="#/remisiones">Ver remisiones</a>`);
      html += `<div class="grid grid-4" style="margin-bottom:16px">
        ${kpi(fmtNum(k.remisiones_hoy), 'Remisiones de hoy', '', 'remisiones')}
        ${kpi(fmtNum(k.pendientes), 'Por entregar', k.pendientes ? 'alerta' : '', 'entrega')}
        ${kpi(fmtNum(k.entregadas_mes), 'Entregadas este mes', 'ok', 'check')}
        ${es('secretario') ? '' : kpi(fmtPeso(k.valor_entregado_mes), 'Valor entregado este mes', 'dinero', 'dinero')}
      </div>`;
      html += `<div class="tarjeta"><div class="tarjeta-titulo"><h2>Avance y balance por contrato</h2><span class="muted small">${k.contratos_activos} contrato(s) activo(s)</span></div>${tablaContratos(p.contratos, { economico: !es('secretario') })}</div>`;
      const max = Math.max(1, ...p.por_mes.map((m) => m.valor));
      const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
      html += `<div class="grid grid-2">
        <div class="tarjeta"><h2>Valor entregado por mes</h2><div class="barras-mes">${p.por_mes.map((m) => `<div class="col" title="${fmtPeso(m.valor)} · ${m.remisiones} remisiones"><b>${m.valor ? fmtNum(m.valor / 1e6, 1) + ' M' : ''}</b><div class="barra-v" style="height:${(m.valor / max) * 100}%"></div><span>${MESES[Number(m.mes.slice(5)) - 1]}</span></div>`).join('')}</div><p class="small muted">Millones de pesos, últimos 6 meses.</p></div>
        <div class="tarjeta"><h2>Pendientes por repartidor</h2>${p.pendientes_por_repartidor.length ? `<table class="tabla"><tbody>${p.pendientes_por_repartidor.map((x) => `<tr><td>${esc(x.repartidor)}</td><td class="num"><b>${x.n}</b></td></tr>`).join('')}</tbody></table>` : '<div class="vacio">No hay remisiones pendientes.</div>'}</div>
      </div>`;
      html += `<div class="tarjeta"><div class="tarjeta-titulo"><h2>Actividad reciente</h2><a href="#/remisiones" class="small">Ver todas</a></div><div class="tabla-cont"><table class="tabla"><thead><tr><th>Número</th><th>Fecha</th><th>Cliente</th><th>Repartidor</th><th>Estado</th><th class="num">Valor</th></tr></thead><tbody>
        ${p.recientes.map((r) => `<tr class="clic" data-ir="#/remisiones/${esc(r.id)}"><td><b>${esc(r.numero)}</b></td><td>${fmtFecha(r.fecha)}</td><td>${esc(r.cliente_nombre)}</td><td>${esc(r.repartidor_nombre || '—')}</td><td>${chipEstado(r)}</td><td class="num">${fmtPeso(r.total)}</td></tr>`).join('') || '<tr><td colspan="6" class="vacio">Aún no hay remisiones.</td></tr>'}
      </tbody></table></div></div>`;
      if (es('admin') && k.contratos_activos === 0 && cap('datos_demo')) {
        html += `<div class="aviso info">¿Sistema nuevo? Puede cargar <b>datos de ejemplo</b> para practicar desde <a href="#/ajustes">Ajustes</a>.</div>`;
      }
    }
    $('.pagina').innerHTML = html;
    activarFilasClic($('.pagina'));
  }

  // ================================================================ vistas: remisiones
  async function vistaRemisiones(params) {
    const titulo = es('cliente') ? 'Entregas recibidas' : 'Remisiones';
    const puedeCrear = es('secretario');
    pintarEstructura('remisiones', titulo, '<div class="cargando">Cargando…</div>', {
      accionesBarra: puedeCrear ? `<a class="btn acento chico" href="#/remisiones/nueva">${ICONO.mas} Nueva</a>` : '',
    });
    const [clientes, repartidores] = await Promise.all([
      es('cliente') ? Promise.resolve([]) : api('GET', '/api/clientes'),
      es('admin', 'gerente', 'secretario') ? api('GET', '/api/repartidores') : Promise.resolve([]),
    ]);
    const f = { q: params.q || '', estado: params.estado || '', cliente_id: params.cliente_id || '', repartidor_id: params.repartidor_id || '', desde: params.desde || '', hasta: params.hasta || '' };
    $('.pagina').innerHTML = `
      <div class="tarjeta">
        <form class="filtros" id="f-filtros">
          <label class="campo q"><span>Buscar</span><input name="q" value="${esc(f.q)}" placeholder="Número, cliente, municipio, quien recibió…"></label>
          ${es('cliente') ? '' : `<label class="campo"><span>Estado</span><select name="estado"><option value="">Todos</option>
            ${['pendiente', 'entregada', 'anulada'].map((e) => `<option value="${e}" ${f.estado === e ? 'selected' : ''}>${{ pendiente: 'Por entregar', entregada: 'Entregadas', anulada: 'Anuladas' }[e]}</option>`).join('')}</select></label>`}
          <label class="campo"><span>Desde</span><input type="date" name="desde" value="${esc(f.desde)}"></label>
          <label class="campo"><span>Hasta</span><input type="date" name="hasta" value="${esc(f.hasta)}"></label>
          <button class="btn primario" type="submit">Filtrar</button>
          ${clientes.length > 1 ? `<label class="campo"><span>Cliente</span><select name="cliente_id"><option value="">Todos</option>${clientes.map((c) => `<option value="${esc(c.id)}" ${f.cliente_id === c.id ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select></label>` : ''}
          ${repartidores.length ? `<label class="campo"><span>Repartidor</span><select name="repartidor_id"><option value="">Todos</option>${repartidores.map((c) => `<option value="${esc(c.id)}" ${f.repartidor_id === c.id ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select></label>` : ''}
        </form>
      </div>
      <div class="tarjeta"><div class="tarjeta-titulo"><h2 id="t-res">Resultados</h2>${es('admin', 'gerente', 'secretario') ? `<button class="btn chico" id="btn-csv">${ICONO.descargar} Exportar a Excel (CSV)</button>` : ''}</div><div id="res"><div class="cargando">Cargando…</div></div></div>`;
    $('#f-filtros').onsubmit = (e) => {
      e.preventDefault();
      const d = formDatos(e.target);
      const qs = Object.entries(d).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
      location.hash = '#/remisiones' + (qs ? '?' + qs : '');
    };
    const qs = Object.entries(f).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const lista = await api('GET', '/api/remisiones' + (qs ? '?' + qs : ''));
    $('#t-res').textContent = `${lista.length} remisión(es)`;
    $('#res').innerHTML = lista.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr>
        <th>Número</th><th>Fecha</th><th>Cliente</th><th>Contrato</th><th>Municipio</th>${es('cliente') ? '<th>Recibió</th>' : '<th>Repartidor</th>'}<th>Estado</th><th class="num">Unidades</th>${es('cliente', 'repartidor', 'secretario') ? '' : '<th class="num">Valor</th>'}</tr></thead><tbody>
      ${lista.map((r) => `<tr class="clic" data-ir="#/remisiones/${esc(r.id)}"><td><b>${esc(r.numero)}</b></td><td class="nowrap">${fmtFecha(r.fecha)}</td><td>${esc(r.cliente_nombre)}</td><td>${esc(r.contrato_codigo || '—')}</td><td>${esc(r.municipio || '')}</td>
        <td>${esc(es('cliente') ? r.receptor_nombre : (r.repartidor_nombre || '—'))}</td><td>${chipEstado(r)}</td><td class="num">${fmtNum(r.unidades)}</td>${es('cliente', 'repartidor', 'secretario') ? '' : `<td class="num">${fmtPeso(r.total)}</td>`}</tr>`).join('')}
      </tbody></table></div>` : '<div class="vacio">No se encontraron remisiones con esos filtros.</div>';
    activarFilasClic($('#res'));
    const bcsv = $('#btn-csv');
    if (bcsv) bcsv.onclick = () => exportarCsv(lista);
  }

  function exportarCsv(lista) {
    const cols = [['numero', 'Número'], ['fecha', 'Fecha'], ['cliente_nombre', 'Cliente'], ['contrato_codigo', 'Contrato'], ['municipio', 'Municipio'], ['repartidor_nombre', 'Repartidor'],
      ['estado', 'Estado'], ['editada', 'Editada'], ['entregada_en', 'Entregada en'], ['receptor_nombre', 'Recibió'], ['unidades', 'Unidades'], ['total', 'Valor']];
    const celda = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const filas = [cols.map((c) => c[1]).join(';'), ...lista.map((r) => cols.map(([k]) => celda(k === 'editada' ? (r[k] ? 'Sí' : 'No') : k === 'entregada_en' ? fmtFechaHora(r[k]) : r[k])).join(';'))];
    const blob = new Blob(['﻿' + filas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `remisiones-${hoy()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------------------------------------------------------------- formulario de remisión (nueva / editar)
  async function vistaFormRemision(id) {
    const editar = !!id;
    pintarEstructura('remisiones', editar ? 'Editar remisión' : 'Nueva remisión', '<div class="cargando">Cargando…</div>', { volver: editar ? `#/remisiones/${id}` : '#/remisiones' });
    const [contratos, clientes, productos, repartidores, actual] = await Promise.all([
      api('GET', '/api/contratos'), api('GET', '/api/clientes'), api('GET', '/api/productos'),
      es('repartidor') ? Promise.resolve([]) : api('GET', '/api/repartidores'),
      editar ? api('GET', `/api/remisiones/${id}`) : Promise.resolve(null),
    ]);
    const contratosActivos = contratos.filter((c) => c.estado === 'activo' || (actual && c.id === actual.contrato_id));
    const prodActivos = productos.filter((p) => p.activo);
    const v = actual || { fecha: hoy(), items: [] };

    $('.pagina').innerHTML = `
      ${editar ? `<div class="aviso alerta">Toda edición queda registrada con fecha, hora, usuario y el motivo. La versión anterior se conserva en el historial.</div>` : ''}
      <form id="f-rem">
        <div class="tarjeta"><h2>Datos de la entrega</h2>
          <div class="grid grid-2">
            <label class="campo"><span>Contrato</span><select name="contrato_id"><option value="">Sin contrato (venta directa)</option>
              ${contratosActivos.map((c) => `<option value="${esc(c.id)}" ${v.contrato_id === c.id ? 'selected' : ''}>${esc(c.codigo)} — ${esc(c.cliente_nombre)}</option>`).join('')}</select></label>
            <label class="campo"><span>Cliente *</span><select name="cliente_id" required><option value="">Seleccione…</option>
              ${clientes.filter((c) => c.activo || c.id === v.cliente_id).map((c) => `<option value="${esc(c.id)}" ${v.cliente_id === c.id ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select></label>
            <label class="campo"><span>Fecha *</span><input type="date" name="fecha" value="${esc(v.fecha)}" required></label>
            ${es('repartidor') ? '' : `<label class="campo"><span>Repartidor asignado</span><select name="repartidor_id"><option value="">Sin asignar</option>
              ${repartidores.map((r) => `<option value="${esc(r.id)}" ${v.repartidor_id === r.id ? 'selected' : ''}>${esc(r.nombre)}</option>`).join('')}</select></label>`}
            <label class="campo"><span>Municipio de entrega</span><input name="municipio" value="${esc(v.municipio || '')}" placeholder="Maicao, Uribia, Riohacha…"></label>
            <label class="campo"><span>Dirección o sitio de entrega</span><input name="direccion_entrega" value="${esc(v.direccion_entrega || '')}"></label>
          </div>
          <label class="campo"><span>Observaciones</span><textarea name="observaciones" maxlength="1000">${esc(v.observaciones || '')}</textarea></label>
        </div>
        <div class="tarjeta"><div class="tarjeta-titulo"><h2>Mercancía</h2><button type="button" class="btn chico" id="btn-add">${ICONO.mas} Agregar producto</button></div>
          <div id="info-contrato"></div>
          <div class="lineas-items" id="items"></div>
          <div class="right"><b id="total-rem"></b></div>
        </div>
        ${editar ? `<div class="tarjeta"><label class="campo"><span>Motivo de la edición * (obligatorio)</span><textarea name="motivo" required minlength="5" placeholder="Ej.: el cliente pidió corregir la cantidad de kits"></textarea></label></div>` : ''}
        <div class="acciones"><button class="btn primario grande" type="submit" style="max-width:340px">${editar ? 'Guardar cambios' : 'Crear remisión'}</button><a class="btn" href="${editar ? `#/remisiones/${esc(id)}` : '#/remisiones'}">Cancelar</a></div>
      </form>`;

    const form = $('#f-rem');
    const selContrato = form.contrato_id;
    const selCliente = form.cliente_id;
    let avance = null;

    function opcionesProducto(sel) {
      const lista = avance ? prodActivos.filter((p) => avance.items.some((i) => i.producto_id === p.id)) : prodActivos;
      return `<option value="">Seleccione producto…</option>` + lista.map((p) => `<option value="${esc(p.id)}" ${sel === p.id ? 'selected' : ''}>${esc(p.nombre)}${p.codigo ? ' (' + esc(p.codigo) + ')' : ''}</option>`).join('');
    }

    function infoProducto(pid) {
      if (!avance || !pid) return '';
      const i = avance.items.find((x) => x.producto_id === pid);
      if (!i) return 'Este producto no hace parte del contrato.';
      const disponible = i.contratado - i.entregado - i.en_transito;
      return `Contratado ${fmtNum(i.contratado)} · entregado ${fmtNum(i.entregado)} · en camino ${fmtNum(i.en_transito)} · disponible <b>${fmtNum(disponible)}</b>`;
    }

    function agregarFila(item = {}) {
      const fila = document.createElement('div');
      fila.className = 'fila';
      fila.innerHTML = `<select class="i-prod" required>${opcionesProducto(item.producto_id)}</select>
        <input class="i-cant" type="number" min="1" step="1" inputmode="numeric" placeholder="Cantidad" value="${esc(item.cantidad || '')}" required>
        <button type="button" class="btn chico peligro i-quitar" title="Quitar">✕</button>
        <div class="info">${infoProducto(item.producto_id)}</div>`;
      $('.i-prod', fila).onchange = () => { $('.info', fila).innerHTML = infoProducto($('.i-prod', fila).value); calcularTotal(); };
      $('.i-cant', fila).oninput = calcularTotal;
      $('.i-quitar', fila).onclick = () => { fila.remove(); calcularTotal(); };
      $('#items').appendChild(fila);
    }

    function precioDe(pid) {
      if (avance) { const i = avance.items.find((x) => x.producto_id === pid); if (i) return i.precio_unitario; }
      const p = productos.find((x) => x.id === pid);
      return p ? p.precio : 0;
    }

    function calcularTotal() {
      let total = 0; let unidades = 0;
      $$('#items .fila').forEach((f) => { const c = Number($('.i-cant', f).value || 0); unidades += c; total += c * precioDe($('.i-prod', f).value); });
      $('#total-rem').textContent = es('secretario') ? '' : es('repartidor') ? `${fmtNum(unidades)} unidades` : `${fmtNum(unidades)} unidades · ${fmtPeso(total)}`;
    }

    async function alCambiarContrato(conservar) {
      avance = null;
      $('#info-contrato').innerHTML = '';
      if (selContrato.value) {
        const c = await api('GET', `/api/contratos/${selContrato.value}`);
        avance = c.avance;
        selCliente.value = c.cliente_id;
        selCliente.disabled = true;
        $('#info-contrato').innerHTML = `<div class="aviso info small">Contrato ${esc(c.codigo)}: avance ${fmtPct(c.avance.totales.porcentaje)}. Solo se muestran los productos del contrato.</div>`;
        const cli = clientes.find((x) => x.id === c.cliente_id);
        if (cli && !form.municipio.value) form.municipio.value = cli.municipio || '';
        if (cli && !form.direccion_entrega.value) form.direccion_entrega.value = cli.direccion || '';
      } else {
        selCliente.disabled = false;
      }
      const previos = conservar ? conservar : [];
      $('#items').innerHTML = '';
      if (previos.length) previos.forEach(agregarFila); else agregarFila();
      calcularTotal();
    }

    selContrato.onchange = () => alCambiarContrato();
    selCliente.onchange = () => {
      const cli = clientes.find((x) => x.id === selCliente.value);
      if (cli) { form.municipio.value = cli.municipio || ''; form.direccion_entrega.value = cli.direccion || ''; }
    };
    $('#btn-add').onclick = () => agregarFila();
    await alCambiarContrato(v.items.map((i) => ({ producto_id: i.producto_id, cantidad: i.cantidad })));

    form.onsubmit = async (e) => {
      e.preventDefault();
      const d = formDatos(form);
      d.cliente_id = selCliente.value;
      d.items = $$('#items .fila').map((f) => ({ producto_id: $('.i-prod', f).value, cantidad: Number($('.i-cant', f).value) }));
      if (!d.items.length) return toast('Agregue al menos un producto.', 'error');
      if (d.items.some((i) => !i.producto_id || !(i.cantidad > 0))) return toast('Revise los productos: todos deben tener producto y cantidad.', 'error');
      const btn = $('button[type=submit]', form);
      try {
        await conBoton(btn, async () => {
          const r = editar ? await api('PUT', `/api/remisiones/${id}`, d) : await api('POST', '/api/remisiones', d);
          (r.advertencias || []).forEach((a) => toast(a, 'error'));
          toast(editar ? 'Remisión actualizada.' : `Remisión ${r.numero} creada.`, 'ok');
          sincronizarEnSegundoPlano();
          location.hash = `#/remisiones/${r.id}`;
        });
      } catch (er) { toast(er.message, 'error'); }
    };
  }

  // ---------------------------------------------------------------- detalle de remisión
  async function vistaDetalleRemision(id) {
    pintarEstructura('remisiones', 'Remisión', '<div class="cargando">Cargando…</div>', { volver: '#/remisiones' });
    const r = await api('GET', `/api/remisiones/${id}`);
    $('.barra h1').textContent = `Remisión ${r.numero}`;
    const puedeEntregar = r.estado === 'pendiente' && (es('secretario') || (es('repartidor') && (!r.repartidor_id || r.repartidor_id === S.usuario.id)));
    const puedeEditar = r.estado !== 'anulada' && es('secretario') && cap('edicion_remisiones');
    const verValores = !es('repartidor', 'secretario');
    const firma = (r.evidencias || []).find((e) => e.tipo === 'firma' && e.rol !== 'repartidor');
    const firmaRep = (r.evidencias || []).find((e) => e.tipo === 'firma' && e.rol === 'repartidor');
    const fotos = (r.evidencias || []).filter((e) => e.tipo === 'foto');
    const src = (e) => `/api/evidencias/${encodeURIComponent(e.id)}?t=${encodeURIComponent(S.token)}`;
    const ACC = { creada: 'Creada', editada: 'Editada', entregada: 'Entrega registrada', anulada: 'Anulada', conflicto: 'Conflicto de sincronización' };

    $('.pagina').innerHTML = `
      <div class="acciones no-imprimir" style="margin-bottom:14px">
        ${puedeEntregar ? `<a class="btn acento" href="#/remisiones/${esc(r.id)}/entrega">${ICONO.entrega} Registrar entrega</a>` : ''}
        ${puedeEditar ? `<a class="btn" href="#/remisiones/${esc(r.id)}/editar">${ICONO.editar} Editar</a>` : ''}
        <a class="btn" href="#/remisiones/${esc(r.id)}/imprimir">${ICONO.imprimir} ${esMovil() ? 'Ver formato' : 'Imprimir / PDF'}</a>
        ${puedeEditar ? `<button class="btn peligro" id="btn-anular">Anular</button>` : ''}
      </div>
      ${r.estado === 'anulada' ? `<div class="aviso error"><b>Remisión anulada.</b> Motivo: ${esc(r.motivo_anulacion)}</div>` : ''}
      ${r.editada ? `<div class="aviso info">Esta remisión fue <b>editada</b> después de creada. Vea el historial abajo.</div>` : ''}
      ${r.pendiente_sync ? `<div class="aviso alerta">Guardada en este celular. Se enviará a la oficina cuando haya conexión.</div>` : ''}
      <div class="grid grid-2">
        <div class="tarjeta detalle"><div class="tarjeta-titulo"><h2>Datos</h2>${chipEstado(r)}</div><dl>
          <dt>Número</dt><dd>${esc(r.numero)}</dd>
          <dt>Fecha</dt><dd>${fmtFecha(r.fecha)}</dd>
          <dt>Cliente</dt><dd>${esc(r.cliente_nombre)}${r.cliente_nit ? ` · NIT ${esc(r.cliente_nit)}` : ''}</dd>
          <dt>Contrato</dt><dd>${r.contrato_id ? `<a href="#/contratos/${esc(r.contrato_id)}">${esc(r.contrato_codigo)}</a>` : 'Sin contrato'}</dd>
          <dt>Entregar en</dt><dd>${esc([r.direccion_entrega, r.municipio].filter(Boolean).join(', ')) || '—'}</dd>
          <dt>Repartidor</dt><dd>${esc(r.repartidor_nombre || 'Sin asignar')}</dd>
          <dt>Elaborada por</dt><dd>${esc(r.creado_por_nombre || '—')} · ${fmtFechaHora(r.creado_en)}</dd>
          ${r.observaciones ? `<dt>Observaciones</dt><dd>${esc(r.observaciones)}</dd>` : ''}
        </dl></div>
        <div class="tarjeta detalle"><h2>Entrega</h2>${r.estado === 'entregada' ? `<dl>
          <dt>Entregada el</dt><dd>${fmtFechaHora(r.entregada_en)}</dd>
          <dt>Recibió</dt><dd>${esc(r.receptor_nombre)}${r.receptor_documento ? ` · Doc. ${esc(r.receptor_documento)}` : ''}</dd>
          ${r.observaciones_entrega ? `<dt>Observaciones</dt><dd>${esc(r.observaciones_entrega)}</dd>` : ''}
        </dl>
        <div class="evidencias" style="margin-top:14px">
          ${firma ? `<figure><img src="${src(firma)}" alt="Firma" data-ver="Firma de quien recibe"><figcaption>Firma de quien recibe · ${fmtFechaHora(firma.tomada_en)}</figcaption></figure>` : ''}
          ${firmaRep ? `<figure><img src="${src(firmaRep)}" alt="Firma del repartidor" data-ver="Firma del repartidor"><figcaption>Firma del repartidor · ${fmtFechaHora(firmaRep.tomada_en)}</figcaption></figure>` : ''}
          ${fotos.map((f) => `<figure><img src="${src(f)}" alt="Foto de la entrega" data-ver="Foto de la entrega"><figcaption>Foto · ${fmtFechaHora(f.tomada_en)}</figcaption></figure>`).join('')}
        </div>` : `<div class="vacio">${r.estado === 'anulada' ? 'Remisión anulada.' : 'Aún no se ha entregado.'}</div>`}</div>
      </div>
      <div class="tarjeta"><h2>Mercancía</h2><div class="tabla-cont"><table class="tabla"><thead><tr><th>Producto</th><th class="num">Cantidad</th>${verValores ? '<th class="num">Precio unitario</th><th class="num">Subtotal</th>' : ''}</tr></thead><tbody>
        ${r.items.map((i) => `<tr><td>${esc(i.descripcion)}${i.producto_codigo ? ` <span class="muted small">(${esc(i.producto_codigo)})</span>` : ''}</td><td class="num">${fmtNum(i.cantidad)} ${esc(i.unidad || '')}</td>${verValores ? `<td class="num">${fmtPeso(i.precio_unitario)}</td><td class="num">${fmtPeso(i.cantidad * i.precio_unitario)}</td>` : ''}</tr>`).join('')}
      </tbody><tfoot><tr><td>Total</td><td class="num">${fmtNum(r.unidades)}</td>${verValores ? `<td></td><td class="num">${fmtPeso(r.total)}</td>` : ''}</tr></tfoot></table></div></div>
      <div class="tarjeta"><h2>Historial y trazabilidad</h2><ul class="historial">
        ${(r.historial || []).map((h) => `<li class="${esc(h.accion)}"><b>${esc(ACC[h.accion] || h.accion)}</b> · ${fmtFechaHora(h.fecha)} · ${esc(h.usuario_nombre || '')}
          ${h.motivo ? `<div>Motivo: ${esc(h.motivo)}</div>` : ''}
          ${h.version_anterior ? `<details><summary>Ver versión anterior</summary>${versionAnteriorHtml(h.version_anterior)}</details>` : ''}</li>`).join('')}
      </ul></div>`;

    $$('[data-ver]').forEach((img) => img.addEventListener('click', () => verImagen(img.src, img.dataset.ver)));
    const ba = $('#btn-anular');
    if (ba) {
      ba.onclick = async () => {
        const motivo = await pedirTexto('Anular remisión', 'Motivo de la anulación', { boton: 'Anular remisión', ayuda: 'La remisión no se borra: queda marcada como anulada con su motivo, y se conserva todo su historial.' });
        if (!motivo) return;
        try { await api('POST', `/api/remisiones/${id}/anular`, { motivo }); toast('Remisión anulada.', 'ok'); vistaDetalleRemision(id); } catch (er) { toast(er.message, 'error'); }
      };
    }
  }

  function versionAnteriorHtml(v) {
    return `<div class="small"><div>Cliente: ${esc(v.cliente_nombre || '')} · Contrato: ${esc(v.contrato_codigo || '—')} · Fecha: ${fmtFecha(v.fecha)}</div>
      <div>Repartidor: ${esc(v.repartidor_nombre || '—')} · Lugar: ${esc([v.direccion_entrega, v.municipio].filter(Boolean).join(', '))}</div>
      ${v.observaciones ? `<div>Observaciones: ${esc(v.observaciones)}</div>` : ''}
      <ul>${(v.items || []).map((i) => `<li>${esc(i.descripcion)}: ${fmtNum(i.cantidad)}</li>`).join('')}</ul></div>`;
  }

  // ---------------------------------------------------------------- registrar entrega (firma + foto)
  function comprimirFoto(archivo, max = 1280, calidad = 0.72) {
    return new Promise((resolve, reject) => {
      const lector = new FileReader();
      lector.onerror = () => reject(new Error('No se pudo leer la foto.'));
      lector.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('El archivo no es una imagen válida.'));
        img.onload = () => {
          const k = Math.min(1, max / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, c.width, c.height);
          // sello de fecha y hora sobre la foto
          const sello = new Date().toLocaleString('es-CO');
          const alto = Math.max(18, Math.round(c.width / 45));
          ctx.font = `bold ${alto}px sans-serif`;
          ctx.fillStyle = 'rgba(0,0,0,.55)';
          ctx.fillRect(0, c.height - alto * 1.7, c.width, alto * 1.7);
          ctx.fillStyle = '#fff';
          ctx.fillText(sello, alto * 0.6, c.height - alto * 0.5);
          resolve(c.toDataURL('image/jpeg', calidad));
        };
        img.src = lector.result;
      };
      lector.readAsDataURL(archivo);
    });
  }

  async function vistaEntrega(id) {
    pintarEstructura('remisiones', 'Registrar entrega', '<div class="cargando">Cargando…</div>', { volver: `#/remisiones/${id}` });
    const r = await api('GET', `/api/remisiones/${id}`);
    if (r.estado !== 'pendiente') { toast(`La remisión ya está ${r.estado}.`, 'error'); location.hash = `#/remisiones/${id}`; return; }
    let foto = null;
    $('.pagina').innerHTML = `
      <div class="tarjeta"><h2>${esc(r.numero)} · ${esc(r.cliente_nombre)}</h2>
        <p class="muted" style="margin:0 0 8px">${esc([r.direccion_entrega, r.municipio].filter(Boolean).join(', '))}</p>
        <ul style="margin:0;padding-left:20px">${r.items.map((i) => `<li><b>${fmtNum(i.cantidad)}</b> ${esc(i.unidad || '')} · ${esc(i.descripcion)}</li>`).join('')}</ul>
      </div>
      <form id="f-ent">
        <div class="tarjeta"><h2>1. ¿Quién recibe?</h2>
          <div class="grid grid-2">
            <label class="campo"><span>Nombre completo *</span><input name="receptor_nombre" required maxlength="120" value="${esc(r.cliente_representante || '')}"></label>
            <label class="campo"><span>Documento (cédula)</span><input name="receptor_documento" inputmode="numeric" maxlength="30"></label>
          </div>
        </div>
        <div class="tarjeta"><div class="tarjeta-titulo"><h2>2. Firma de quien recibe *</h2><button type="button" class="btn chico" id="btn-limpiar">Borrar firma</button></div>
          <div class="firma-caja"><canvas id="lienzo"></canvas><div class="linea"></div><div class="ayuda">Firme aquí con el dedo</div></div>
        </div>
        <div class="tarjeta"><div class="tarjeta-titulo"><h2>3. Firma del repartidor *</h2><button type="button" class="btn chico" id="btn-limpiar-rep">Borrar firma</button></div>
          <div class="firma-caja"><canvas id="lienzo-rep"></canvas><div class="linea"></div><div class="ayuda">Firma de quien entrega</div></div>
        </div>
        <div class="tarjeta"><h2>4. Foto de la mercancía entregada</h2>
          <label class="btn grande" style="cursor:pointer">${ICONO.camara} <span id="txt-foto">Tomar foto</span>
            <input type="file" accept="image/*" capture="environment" id="in-foto" style="display:none"></label>
          <img id="previa" class="foto-previa hidden" alt="Foto tomada">
          <label class="check" style="margin-top:14px"><input type="checkbox" id="sin-foto"><span>No fue posible tomar la foto</span></label>
          <label class="campo hidden" id="campo-sin-foto"><span>¿Por qué no se tomó la foto?</span><input name="sin_foto_motivo" maxlength="300"></label>
        </div>
        <div class="tarjeta"><label class="campo"><span>Observaciones de la entrega</span><textarea name="observaciones_entrega" maxlength="1000" placeholder="Ej.: se entregó completo, cajas en buen estado"></textarea></label>
          <p class="small muted" style="margin-top:0">La fecha y hora se registran automáticamente al guardar.</p>
        </div>
        <button class="btn acento grande" type="submit">Guardar entrega</button>
      </form>`;

    const panel = window.PanelFirma($('#lienzo'));
    $('#btn-limpiar').onclick = () => panel.limpiar();
    const panelRep = window.PanelFirma($('#lienzo-rep'));
    $('#btn-limpiar-rep').onclick = () => panelRep.limpiar();
    $('#in-foto').onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        foto = await comprimirFoto(f);
        const p = $('#previa'); p.src = foto; p.classList.remove('hidden');
        $('#txt-foto').textContent = 'Tomar otra foto';
      } catch (er) { toast(er.message, 'error'); }
    };
    $('#sin-foto').onchange = (e) => $('#campo-sin-foto').classList.toggle('hidden', !e.target.checked);
    $('#f-ent').onsubmit = async (e) => {
      e.preventDefault();
      const d = formDatos(e.target);
      if (panel.estaVacia()) return toast('Falta la firma de quien recibe.', 'error');
      const sinFoto = $('#sin-foto').checked;
      if (!foto && !sinFoto) return toast('Tome la foto de la entrega o marque que no fue posible.', 'error');
      if (!foto && sinFoto && (d.sin_foto_motivo || '').trim().length < 3) return toast('Explique por qué no se tomó la foto.', 'error');
      if (panelRep.estaVacia()) return toast('Falta la firma del repartidor.', 'error');
      d.firma = panel.imagen();
      d.firma_repartidor = panelRep.imagen();
      d.foto = foto;
      if (!sinFoto) delete d.sin_foto_motivo;
      const btn = $('button[type=submit]', e.target);
      try {
        await conBoton(btn, async () => {
          const res = await api('POST', `/api/remisiones/${id}/entrega`, d);
          if (!(res && res.encolada)) await Escenas.celebrarEntrega(r.numero);
          sincronizarEnSegundoPlano();
          location.hash = `#/remisiones/${id}`;
        });
      } catch (er) { toast(er.message, 'error'); }
    };
  }

  // ---------------------------------------------------------------- formato imprimible
  async function vistaImprimir(id) {
    pintarEstructura('remisiones', 'Formato de remisión', '<div class="cargando">Cargando…</div>', {
      volver: `#/remisiones/${id}`,
      accionesBarra: esMovil() ? '' : `<button class="btn primario chico" id="btn-print">${ICONO.imprimir} Imprimir o guardar PDF</button>`,
    });
    const [r, emp] = await Promise.all([api('GET', `/api/remisiones/${id}`), api('GET', '/api/ajustes-publicos')]);
    const firma = (r.evidencias || []).find((e) => e.tipo === 'firma' && e.rol !== 'repartidor');
    const firmaRep = (r.evidencias || []).find((e) => e.tipo === 'firma' && e.rol === 'repartidor');
    const foto = (r.evidencias || []).find((e) => e.tipo === 'foto');
    const src = (e) => `/api/evidencias/${encodeURIComponent(e.id)}?t=${encodeURIComponent(S.token)}`;
    const verValores = !es('repartidor', 'secretario');
    $('.pagina').innerHTML = `<div class="hoja">
      <div class="enc">
        <div><h1>${esc(emp.empresa_nombre)}</h1><div>${emp.empresa_nit ? 'NIT ' + esc(emp.empresa_nit) : ''}</div><div>${esc(emp.empresa_direccion || '')}</div>
          <div>${esc(emp.empresa_telefono || '')}</div>${emp.empresa_representante ? `<div>Representante legal: ${esc(emp.empresa_representante)}</div>` : ''}</div>
        <div class="num">REMISIÓN<b>${esc(r.numero)}</b>Fecha: ${fmtFecha(r.fecha)}
          ${r.editada ? '<div><span class="sello">EDITADA</span></div>' : ''}${r.estado === 'anulada' ? '<div><span class="sello anulada">ANULADA</span></div>' : ''}</div>
      </div>
      <div class="datos">
        <div><b>Cliente:</b> ${esc(r.cliente_nombre)}</div><div><b>NIT:</b> ${esc(r.cliente_nit || '')}</div>
        <div><b>Representante:</b> ${esc(r.cliente_representante || '')}</div><div><b>Teléfono:</b> ${esc(r.cliente_telefono || '')}</div>
        <div><b>Lugar de entrega:</b> ${esc([r.direccion_entrega, r.municipio].filter(Boolean).join(', '))}</div><div><b>Contrato:</b> ${esc(r.contrato_codigo || 'N/A')}</div>
        <div><b>Repartidor:</b> ${esc(r.repartidor_nombre || '')}</div><div><b>Estado:</b> ${esc({ pendiente: 'Por entregar', entregada: 'Entregada', anulada: 'Anulada' }[r.estado])}</div>
      </div>
      <table><thead><tr><th>#</th><th>Descripción</th><th>Unidad</th><th style="text-align:right">Cantidad</th>${verValores ? '<th style="text-align:right">Vr. unitario</th><th style="text-align:right">Vr. total</th>' : ''}</tr></thead><tbody>
        ${r.items.map((i, k) => `<tr><td>${k + 1}</td><td>${esc(i.descripcion)}</td><td>${esc(i.unidad || '')}</td><td style="text-align:right">${fmtNum(i.cantidad)}</td>${verValores ? `<td style="text-align:right">${fmtPeso(i.precio_unitario)}</td><td style="text-align:right">${fmtPeso(i.cantidad * i.precio_unitario)}</td>` : ''}</tr>`).join('')}
        <tr><td colspan="3"><b>TOTAL</b></td><td style="text-align:right"><b>${fmtNum(r.unidades)}</b></td>${verValores ? `<td></td><td style="text-align:right"><b>${fmtPeso(r.total)}</b></td>` : ''}</tr>
      </tbody></table>
      ${r.observaciones ? `<p><b>Observaciones:</b> ${esc(r.observaciones)}</p>` : ''}
      <div class="firmas">
        <div>${firmaRep ? `<img src="${src(firmaRep)}" alt="Firma del repartidor">` : '<div style="height:94px"></div>'}<div class="f">Entrega: ${esc(r.repartidor_nombre || '')}<br>${esc(emp.empresa_nombre)}</div></div>
        <div>${firma ? `<img src="${src(firma)}" alt="Firma">` : '<div style="height:94px"></div>'}<div class="f">Recibe: ${esc(r.receptor_nombre || '')} ${r.receptor_documento ? '· C.C. ' + esc(r.receptor_documento) : ''}<br>${r.entregada_en ? 'Recibido el ' + fmtFechaHora(r.entregada_en) : ''}</div></div>
      </div>
      ${foto ? `<p><b>Evidencia fotográfica de la entrega:</b></p><img class="foto" src="${src(foto)}" alt="Foto de la entrega">` : ''}
      ${r.editada ? `<p class="small"><b>Ediciones registradas:</b> ${(r.historial || []).filter((h) => h.accion === 'editada').map((h) => `${fmtFechaHora(h.fecha)} por ${esc(h.usuario_nombre)} — ${esc(h.motivo)}`).join('; ')}</p>` : ''}
      <div class="pie-hoja">Documento generado por el Sistema de Remisiones ${esc(emp.empresa_nombre)} el ${fmtFechaHora(new Date().toISOString())}. La firma y la foto fueron capturadas digitalmente en el momento de la entrega. Los datos personales se tratan conforme a la Ley 1581 de 2012.</div>
    </div>`;
    const bp = $('#btn-print');
    if (bp) bp.onclick = () => window.print();
  }

  // ================================================================ contratos
  async function vistaContratos() {
    const editor = es('secretario');
    pintarEstructura('contratos', es('cliente') ? 'Mis contratos' : 'Contratos', '<div class="cargando">Cargando…</div>', {
      accionesBarra: editor ? `<button class="btn acento chico" id="btn-nuevo">${ICONO.mas} Nuevo contrato</button>` : '',
    });
    const lista = await api('GET', '/api/contratos');
    const economico = !es('cliente', 'repartidor', 'secretario');
    $('.pagina').innerHTML = `<div class="tarjeta">${lista.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr><th>Código</th><th>Cliente</th><th>Vigencia</th><th>Estado</th><th style="min-width:140px">Avance</th>${economico ? '<th class="num">Valor contrato</th><th class="num">Entregado</th>' : '<th class="num">Falta</th>'}</tr></thead><tbody>
      ${lista.map((c) => `<tr class="clic" data-ir="#/contratos/${esc(c.id)}"><td><b>${esc(c.codigo)}</b></td><td>${esc(c.cliente_nombre)}</td><td class="nowrap">${fmtFecha(c.fecha_inicio)} – ${fmtFecha(c.fecha_fin)}</td>
        <td><span class="chip ${c.estado === 'activo' ? 'entregada' : 'gris'}">${esc(c.estado)}</span></td>
        <td>${barraAvance(c.avance.porcentaje)}<div class="small muted">${fmtPct(c.avance.porcentaje)}</div></td>
        ${economico ? `<td class="num">${fmtPeso(c.avance.valor_contratado)}</td><td class="num">${fmtPeso(c.avance.valor_entregado)}</td>` : `<td class="num">${fmtNum(c.avance.pendiente)}</td>`}</tr>`).join('')}
      </tbody></table></div>` : '<div class="vacio">No hay contratos registrados.</div>'}</div>`;
    activarFilasClic($('.pagina'));
    const bn = $('#btn-nuevo');
    if (bn) bn.onclick = () => formContrato(null);
  }

  async function formContrato(c) {
    const [clientes, productos] = await Promise.all([api('GET', '/api/clientes'), api('GET', '/api/productos')]);
    const v = c || { estado: 'activo', items: [] };
    const verPrecio = !es('secretario');
    modal(`<h2>${c ? 'Editar contrato' : 'Nuevo contrato'}</h2>
      <form id="f-con">
        <div class="grid grid-2">
          <label class="campo"><span>Código del contrato *</span><input name="codigo" required value="${esc(v.codigo || '')}"></label>
          <label class="campo"><span>Cliente *</span><select name="cliente_id" required><option value="">Seleccione…</option>${clientes.map((x) => `<option value="${esc(x.id)}" ${v.cliente_id === x.id ? 'selected' : ''}>${esc(x.nombre)}</option>`).join('')}</select></label>
          <label class="campo"><span>Fecha de inicio</span><input type="date" name="fecha_inicio" value="${esc(v.fecha_inicio || '')}"></label>
          <label class="campo"><span>Fecha de finalización</span><input type="date" name="fecha_fin" value="${esc(v.fecha_fin || '')}"></label>
          <label class="campo"><span>Estado</span><select name="estado">${['activo', 'suspendido', 'finalizado'].map((e) => `<option ${v.estado === e ? 'selected' : ''}>${e}</option>`).join('')}</select></label>
        </div>
        <label class="campo"><span>Objeto del contrato</span><textarea name="objeto">${esc(v.objeto || '')}</textarea></label>
        <div class="tarjeta-titulo"><h3>Productos contratados</h3><button type="button" class="btn chico" id="c-add">${ICONO.mas} Agregar</button></div>
        <div id="c-items"></div>
        <div class="pie"><button type="button" class="btn" data-cerrar>Cancelar</button><button class="btn primario" type="submit">Guardar</button></div>
      </form>`, {
      ancho: true,
      alMontar: (el, cerrar) => {
        const agregar = (i = {}) => {
          const f = document.createElement('div');
          f.className = 'grid grid-3';
          f.style.marginBottom = '8px';
          f.innerHTML = `<select class="ci-p" required><option value="">Producto…</option>${productos.map((p) => `<option value="${esc(p.id)}" data-precio="${p.precio}" ${i.producto_id === p.id ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('')}</select>
            <input class="ci-c" type="number" min="1" placeholder="Cantidad" value="${esc(i.cantidad || '')}" required>
            <div style="display:flex;gap:6px">${verPrecio ? `<input class="ci-v" type="number" min="0" step="any" placeholder="Precio unitario" value="${esc(i.precio_unitario ?? '')}">` : ''}<button type="button" class="btn chico peligro">✕</button></div>`;
          if (verPrecio) $('.ci-p', f).onchange = (e) => { const o = e.target.selectedOptions[0]; if (o && !$('.ci-v', f).value) $('.ci-v', f).value = o.dataset.precio; };
          $('button', f).onclick = () => f.remove();
          $('#c-items', el).appendChild(f);
        };
        (v.items.length ? v.items : [{}]).forEach(agregar);
        $('#c-add', el).onclick = () => agregar();
        $('#f-con', el).onsubmit = async (e) => {
          e.preventDefault();
          const d = formDatos(e.target);
          d.items = $$('#c-items > div', el).map((f) => ({ producto_id: $('.ci-p', f).value, cantidad: Number($('.ci-c', f).value), ...(verPrecio ? { precio_unitario: Number($('.ci-v', f).value || 0) } : {}) }));
          try {
            const r = c ? await api('PUT', `/api/contratos/${c.id}`, d) : await api('POST', '/api/contratos', d);
            cerrar(); toast('Contrato guardado.', 'ok');
            location.hash = `#/contratos/${r.id}`; enrutar();
          } catch (er) { toast(er.message, 'error'); }
        };
      },
    });
  }

  async function vistaDetalleContrato(id) {
    pintarEstructura('contratos', 'Contrato', '<div class="cargando">Cargando…</div>', { volver: '#/contratos' });
    const c = await api('GET', `/api/contratos/${id}`);
    const t = c.avance.totales;
    const economico = !es('cliente', 'repartidor', 'secretario');
    $('.barra h1').textContent = `Contrato ${c.codigo}`;
    $('.pagina').innerHTML = `
      ${es('secretario') ? `<div class="acciones" style="margin-bottom:14px"><button class="btn" id="btn-editar">${ICONO.editar} Editar contrato</button>${es('secretario') ? `<a class="btn acento" href="#/remisiones/nueva">${ICONO.mas} Nueva remisión</a>` : ''}</div>` : ''}
      <div class="tarjeta"><div class="tarjeta-titulo"><h2>${esc(c.cliente_nombre)}</h2><span class="chip ${c.estado === 'activo' ? 'entregada' : 'gris'}">${esc(c.estado)}</span></div>
        <p class="muted" style="margin-top:0">${esc(c.objeto || '')}<br>Vigencia: ${fmtFecha(c.fecha_inicio)} – ${fmtFecha(c.fecha_fin)}</p>
        <div class="grid grid-4" style="margin-bottom:12px">
          ${kpi(fmtNum(t.contratado), 'Unidades contratadas')}${kpi(fmtNum(t.entregado), 'Entregadas con firma', 'ok')}${kpi(fmtNum(t.pendiente), 'Faltan por entregar', 'alerta')}${kpi(fmtPct(t.porcentaje), 'Avance')}
        </div>
        ${barraAvance(t.porcentaje, t.contratado ? (t.en_transito / t.contratado) * 100 : 0)}
        ${economico ? `<div class="grid grid-3" style="margin-top:14px">${kpi(fmtPeso(t.valor_contratado), 'Valor del contrato')}${kpi(fmtPeso(t.valor_entregado), 'Valor entregado (cobrable)', 'ok')}${kpi(fmtPeso(t.saldo_valor), 'Saldo por entregar')}</div>` : ''}
      </div>
      <div class="tarjeta"><h2>Detalle por producto</h2><div class="tabla-cont"><table class="tabla"><thead><tr><th>Producto</th><th class="num">Contratado</th><th class="num">Entregado</th><th class="num">En camino</th><th class="num">Falta</th><th style="min-width:120px">Avance</th>${economico ? '<th class="num">Vr. unitario</th><th class="num">Vr. entregado</th>' : ''}</tr></thead><tbody>
        ${c.avance.items.map((i) => `<tr><td>${esc(i.producto)}</td><td class="num">${fmtNum(i.contratado)}</td><td class="num">${fmtNum(i.entregado)}</td><td class="num">${fmtNum(i.en_transito)}</td><td class="num">${fmtNum(i.pendiente)}</td>
          <td>${barraAvance(i.porcentaje)}<div class="small muted">${fmtPct(i.porcentaje)}</div></td>${economico ? `<td class="num">${fmtPeso(i.precio_unitario)}</td><td class="num">${fmtPeso(i.valor_entregado)}</td>` : ''}</tr>`).join('')}
      </tbody></table></div></div>
      <div class="tarjeta"><h2>${es('cliente') ? 'Entregas recibidas' : 'Remisiones del contrato'}</h2>${c.remisiones.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr><th>Número</th><th>Fecha</th><th>Estado</th><th>Repartidor</th><th class="num">Unidades</th>${economico ? '<th class="num">Valor</th>' : ''}</tr></thead><tbody>
        ${c.remisiones.map((r) => `<tr class="clic" data-ir="#/remisiones/${esc(r.id)}"><td><b>${esc(r.numero)}</b></td><td>${fmtFecha(r.fecha)}</td><td>${chipEstado(r)}</td><td>${esc(r.repartidor_nombre || '—')}</td><td class="num">${fmtNum(r.unidades)}</td>${economico ? `<td class="num">${fmtPeso(r.total)}</td>` : ''}</tr>`).join('')}
      </tbody></table></div>` : '<div class="vacio">Aún no hay remisiones en este contrato.</div>'}</div>`;
    activarFilasClic($('.pagina'));
    const be = $('#btn-editar');
    if (be) be.onclick = () => formContrato(c);
  }

  // ================================================================ catálogos: clientes y productos
  async function vistaClientes() {
    const editor = es('secretario');
    pintarEstructura('clientes', 'Clientes', '<div class="cargando">Cargando…</div>', { accionesBarra: editor ? `<button class="btn acento chico" id="btn-nuevo">${ICONO.mas} Nuevo cliente</button>` : '' });
    const lista = await api('GET', '/api/clientes');
    $('.pagina').innerHTML = `<div class="tarjeta">${lista.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr><th>Nombre</th><th>NIT</th><th>Tipo</th><th>Municipio</th><th>Representante</th><th>Teléfono</th><th>Autoriza datos</th></tr></thead><tbody>
      ${lista.map((c, k) => `<tr class="${editor ? 'clic' : ''}" data-k="${k}"><td><b>${esc(c.nombre)}</b>${c.activo ? '' : ' <span class="chip gris">inactivo</span>'}</td><td>${esc(c.nit || '')}</td><td>${esc(NOMBRE_TIPO[c.tipo] || c.tipo)}</td><td>${esc(c.municipio || '')}</td><td>${esc(c.representante || '')}</td><td>${esc(c.telefono || '')}</td>
        <td>${c.autoriza_datos ? '<span class="chip entregada">Sí</span>' : '<span class="chip pendiente">Pendiente</span>'}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="vacio">No hay clientes registrados.</div>'}</div>`;
    if (editor) {
      $$('tr[data-k]').forEach((tr) => tr.addEventListener('click', () => formCliente(lista[Number(tr.dataset.k)])));
      $('#btn-nuevo').onclick = () => formCliente(null);
    }
  }

  function formCliente(c) {
    const v = c || { tipo: 'fundacion', activo: 1 };
    modal(`<h2>${c ? 'Editar cliente' : 'Nuevo cliente'}</h2><form id="f-cli">
      <div class="grid grid-2">
        <label class="campo"><span>Nombre o razón social *</span><input name="nombre" required value="${esc(v.nombre || '')}"></label>
        <label class="campo"><span>NIT o cédula</span><input name="nit" value="${esc(v.nit || '')}"></label>
        <label class="campo"><span>Tipo</span><select name="tipo">${Object.entries(NOMBRE_TIPO).map(([k, t]) => `<option value="${k}" ${v.tipo === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="campo"><span>Representante o contacto</span><input name="representante" value="${esc(v.representante || '')}"></label>
        <label class="campo"><span>Teléfono</span><input name="telefono" value="${esc(v.telefono || '')}"></label>
        <label class="campo"><span>Correo</span><input name="email" type="email" value="${esc(v.email || '')}"></label>
        <label class="campo"><span>Municipio</span><input name="municipio" value="${esc(v.municipio || '')}"></label>
        <label class="campo"><span>Dirección</span><input name="direccion" value="${esc(v.direccion || '')}"></label>
      </div>
      <label class="check"><input type="checkbox" name="autoriza_datos" ${v.autoriza_datos ? 'checked' : ''}><span>El cliente <b>autorizó el tratamiento de sus datos personales</b> (Ley 1581 de 2012). <a href="#/politica" target="_blank">Ver política</a></span></label>
      <label class="check"><input type="checkbox" name="activo" ${v.activo ? 'checked' : ''}><span>Cliente activo</span></label>
      <div class="pie"><button type="button" class="btn" data-cerrar>Cancelar</button><button class="btn primario" type="submit">Guardar</button></div></form>`, {
      ancho: true,
      alMontar: (el, cerrar) => {
        $('#f-cli', el).onsubmit = async (e) => {
          e.preventDefault();
          try { c ? await api('PUT', `/api/clientes/${c.id}`, formDatos(e.target)) : await api('POST', '/api/clientes', formDatos(e.target)); cerrar(); toast('Cliente guardado.', 'ok'); vistaClientes(); } catch (er) { toast(er.message, 'error'); }
        };
      },
    });
  }

  async function vistaProductos() {
    pintarEstructura('productos', 'Productos', '<div class="cargando">Cargando…</div>', { accionesBarra: es('secretario') ? `<button class="btn acento chico" id="btn-nuevo">${ICONO.mas} Nuevo producto</button>` : '' });
    const lista = await api('GET', '/api/productos');
    $('.pagina').innerHTML = `<div class="tarjeta">${lista.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr><th>Código</th><th>Nombre</th><th>Unidad</th>${es('secretario') ? '' : '<th class="num">Precio de referencia</th>'}<th>Estado</th></tr></thead><tbody>
      ${lista.map((p, k) => `<tr class="clic" data-k="${k}"><td>${esc(p.codigo || '')}</td><td><b>${esc(p.nombre)}</b></td><td>${esc(p.unidad)}</td>${es('secretario') ? '' : `<td class="num">${fmtPeso(p.precio)}</td>`}<td>${p.activo ? '<span class="chip entregada">activo</span>' : '<span class="chip gris">inactivo</span>'}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="vacio">No hay productos registrados.</div>'}</div>`;
    if (es('secretario')) $$('tr[data-k]').forEach((tr) => tr.addEventListener('click', () => formProducto(lista[Number(tr.dataset.k)])));
    if ($('#btn-nuevo')) $('#btn-nuevo').onclick = () => formProducto(null);
  }

  function formProducto(p) {
    const v = p || { unidad: 'unidad', activo: 1 };
    modal(`<h2>${p ? 'Editar producto' : 'Nuevo producto'}</h2><form id="f-pro">
      <div class="grid grid-2">
        <label class="campo"><span>Código</span><input name="codigo" value="${esc(v.codigo || '')}"></label>
        <label class="campo"><span>Nombre *</span><input name="nombre" required value="${esc(v.nombre || '')}"></label>
        <label class="campo"><span>Unidad</span><input name="unidad" value="${esc(v.unidad || '')}" placeholder="unidad, kit, caja"></label>
        ${es('secretario') ? '' : `<label class="campo"><span>Precio de referencia</span><input name="precio" type="number" min="0" step="any" value="${esc(v.precio ?? '')}"></label>`}
      </div>
      <label class="check"><input type="checkbox" name="activo" ${v.activo ? 'checked' : ''}><span>Producto activo</span></label>
      <div class="pie"><button type="button" class="btn" data-cerrar>Cancelar</button><button class="btn primario" type="submit">Guardar</button></div></form>`, {
      alMontar: (el, cerrar) => {
        $('#f-pro', el).onsubmit = async (e) => {
          e.preventDefault();
          try { p ? await api('PUT', `/api/productos/${p.id}`, formDatos(e.target)) : await api('POST', '/api/productos', formDatos(e.target)); cerrar(); toast('Producto guardado.', 'ok'); vistaProductos(); } catch (er) { toast(er.message, 'error'); }
        };
      },
    });
  }

  // ================================================================ usuarios
  async function vistaUsuarios() {
    pintarEstructura('usuarios', 'Usuarios', '<div class="cargando">Cargando…</div>', { accionesBarra: `<button class="btn acento chico" id="btn-nuevo">${ICONO.mas} Nuevo usuario</button>` });
    const [lista, clientes] = await Promise.all([api('GET', '/api/usuarios'), api('GET', '/api/clientes')]);
    $('.pagina').innerHTML = `<div class="aviso info small">Roles: <b>Gerente</b> ve todo y el balance; <b>Secretario</b> crea y edita remisiones; <b>Repartidor</b> registra entregas desde el celular; <b>Cliente</b> solo ve lo que ha recibido y su avance; <b>Administrador</b> gestiona usuarios y respaldos.</div>
      <div class="tarjeta"><div class="tabla-cont"><table class="tabla"><thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Cliente asociado</th><th>Estado</th></tr></thead><tbody>
      ${lista.map((u, k) => `<tr class="clic" data-k="${k}"><td><b>${esc(u.nombre)}</b></td><td>${esc(u.usuario)}</td><td>${esc(NOMBRE_ROL[u.rol])}</td><td>${esc(u.cliente_nombre || '')}</td><td>${u.activo ? '<span class="chip entregada">activo</span>' : '<span class="chip gris">inactivo</span>'}${u.debe_cambiar_clave ? ' <span class="chip pendiente">clave temporal</span>' : ''}</td></tr>`).join('')}
      </tbody></table></div></div>`;
    $$('tr[data-k]').forEach((tr) => tr.addEventListener('click', () => formUsuario(lista[Number(tr.dataset.k)], clientes)));
    $('#btn-nuevo').onclick = () => formUsuario(null, clientes);
  }

  function formUsuario(u, clientes) {
    const v = u || { rol: 'repartidor', activo: true };
    modal(`<h2>${u ? 'Editar usuario' : 'Nuevo usuario'}</h2><form id="f-usr">
      <div class="grid grid-2">
        <label class="campo"><span>Nombre completo *</span><input name="nombre" required value="${esc(v.nombre || '')}"></label>
        <label class="campo"><span>Usuario (para ingresar) *</span><input name="usuario" required value="${esc(v.usuario || '')}" autocapitalize="none"></label>
        <label class="campo"><span>Rol *</span><select name="rol">${Object.entries(NOMBRE_ROL).map(([k, t]) => `<option value="${k}" ${v.rol === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="campo" id="campo-cli"><span>Cliente asociado (rol cliente)</span><select name="cliente_id"><option value="">—</option>${clientes.map((c) => `<option value="${esc(c.id)}" ${v.cliente_id === c.id ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select></label>
        <label class="campo"><span>${u ? 'Nueva contraseña (dejar vacío para no cambiar)' : 'Contraseña inicial *'}</span><input name="clave" type="text" minlength="6" ${u ? '' : 'required'} autocomplete="new-password"></label>
      </div>
      <label class="check"><input type="checkbox" name="activo" ${v.activo ? 'checked' : ''}><span>Usuario activo</span></label>
      <p class="small muted">Al asignar una contraseña, el usuario deberá cambiarla en su primer ingreso.</p>
      <div class="pie"><button type="button" class="btn" data-cerrar>Cancelar</button><button class="btn primario" type="submit">Guardar</button></div></form>`, {
      ancho: true,
      alMontar: (el, cerrar) => {
        const f = $('#f-usr', el);
        const ver = () => $('#campo-cli', el).classList.toggle('hidden', f.rol.value !== 'cliente');
        f.rol.onchange = ver; ver();
        f.onsubmit = async (e) => {
          e.preventDefault();
          const d = formDatos(f);
          if (!d.clave) delete d.clave;
          try { u ? await api('PUT', `/api/usuarios/${u.id}`, d) : await api('POST', '/api/usuarios', d); cerrar(); toast('Usuario guardado.', 'ok'); vistaUsuarios(); } catch (er) { toast(er.message, 'error'); }
        };
      },
    });
  }

  // ================================================================ respaldos
  async function vistaRespaldos() {
    pintarEstructura('respaldos', 'Respaldos', '<div class="cargando">Cargando…</div>');
    const d = await api('GET', '/api/respaldos');
    $('.pagina').innerHTML = `
      <div class="aviso info">El sistema crea un <b>respaldo automático cada día</b> y conserva los 30 más recientes. Para protegerse de daños del computador, copie periódicamente la carpeta de respaldos a una memoria USB o a la nube.<br><span class="small">Carpeta: <code>${esc(d.carpeta)}</code></span></div>
      <div class="acciones" style="margin-bottom:16px">
        <button class="btn primario" id="btn-resp">${ICONO.respaldos} Crear respaldo ahora</button>
        <label class="btn" style="cursor:pointer">${ICONO.descargar} Restaurar desde archivo…<input type="file" accept=".db" id="in-rest" style="display:none"></label>
      </div>
      <div class="tarjeta"><h2>Respaldos disponibles</h2><p class="muted small">Último respaldo: ${d.ultimo ? fmtFechaHora(d.ultimo) : 'nunca'}</p>
        ${d.archivos.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr><th>Archivo</th><th>Fecha</th><th class="num">Tamaño</th><th></th></tr></thead><tbody>
        ${d.archivos.map((a) => `<tr><td>${esc(a.nombre)}</td><td>${fmtFechaHora(a.fecha)}</td><td class="num">${fmtNum(a.bytes / 1024 / 1024, 2)} MB</td>
          <td class="nowrap"><button class="btn chico" data-ver="${esc(a.nombre)}">Probar recuperación</button> <button class="btn chico" data-bajar="${esc(a.nombre)}">${ICONO.descargar}</button> <button class="btn chico peligro" data-rest="${esc(a.nombre)}">Restaurar</button></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="vacio">Aún no hay respaldos.</div>'}</div>`;
    $('#btn-resp').onclick = async (e) => {
      try { await conBoton(e.currentTarget, async () => { const r = await api('POST', '/api/respaldos'); toast(`Respaldo creado y verificado (${r.verificacion.remisiones} remisiones).`, 'ok'); }); vistaRespaldos(); } catch (er) { toast(er.message, 'error'); }
    };
    $$('[data-ver]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const v = await api('POST', `/api/respaldos/${encodeURIComponent(b.dataset.ver)}/verificar`);
        modal(`<h2>Prueba de recuperación</h2><div class="aviso ${v.integridad === 'ok' ? 'ok' : 'error'}">Integridad del archivo: <b>${esc(v.integridad)}</b></div>
          <table class="tabla"><tbody>${['remisiones', 'evidencias', 'clientes', 'contratos', 'usuarios'].map((k) => `<tr><td>${k}</td><td class="num"><b>${fmtNum(v[k])}</b></td></tr>`).join('')}</tbody></table>
          <p class="small muted">El respaldo se abrió y se leyó correctamente sin modificar los datos actuales.</p><div class="pie"><button class="btn" data-cerrar>Cerrar</button></div>`);
      } catch (er) { toast(er.message, 'error'); }
    }));
    $$('[data-bajar]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const blob = await api('GET', `/api/respaldos/${encodeURIComponent(b.dataset.bajar)}`, undefined, { binario: true });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = b.dataset.bajar; document.body.appendChild(a); a.click(); a.remove();
      } catch (er) { toast(er.message, 'error'); }
    }));
    $$('[data-rest]').forEach((b) => b.addEventListener('click', async () => {
      const ok = await confirmar('Restaurar respaldo', `Los datos actuales se reemplazarán por los del respaldo ${b.dataset.rest}. Antes de hacerlo, el sistema guardará una copia de los datos actuales.`, { boton: 'Restaurar', peligro: true });
      if (!ok) return;
      try { await api('POST', `/api/respaldos/${encodeURIComponent(b.dataset.rest)}/restaurar`); toast('Respaldo restaurado.', 'ok'); vistaRespaldos(); } catch (er) { toast(er.message, 'error'); }
    }));
    $('#in-rest').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const ok = await confirmar('Restaurar desde archivo', `Se reemplazarán los datos actuales por los del archivo ${f.name}. Se guardará antes una copia de los datos actuales.`, { boton: 'Restaurar', peligro: true });
      if (!ok) return;
      try { await api('POST', '/api/respaldos-subir', f); toast('Respaldo restaurado.', 'ok'); vistaRespaldos(); } catch (er) { toast(er.message, 'error'); }
    };
  }

  // ================================================================ auditoría
  async function vistaAuditoria(params) {
    pintarEstructura('auditoria', 'Auditoría', '<div class="cargando">Cargando…</div>');
    const q = params.q || '';
    const lista = await api('GET', '/api/auditoria' + (q ? `?q=${encodeURIComponent(q)}` : ''));
    $('.pagina').innerHTML = `<div class="tarjeta"><form id="f-aud" class="acciones"><input name="q" value="${esc(q)}" placeholder="Buscar por usuario, acción o detalle" style="max-width:420px"><button class="btn primario">Buscar</button></form></div>
      <div class="tarjeta"><p class="muted small">Últimos 500 registros. Cada acción importante queda registrada con fecha, hora y usuario.</p><div class="tabla-cont"><table class="tabla"><thead><tr><th>Fecha</th><th>Usuario</th><th>Acción</th><th>Detalle</th></tr></thead><tbody>
      ${lista.map((a) => `<tr><td class="nowrap">${fmtFechaHora(a.fecha)}</td><td>${esc(a.usuario)}</td><td>${esc(a.accion.replace(/_/g, ' '))}</td><td>${esc(a.detalle || '')}</td></tr>`).join('')}
      </tbody></table></div></div>`;
    $('#f-aud').onsubmit = (e) => { e.preventDefault(); const v = e.target.q.value.trim(); location.hash = '#/auditoria' + (v ? `?q=${encodeURIComponent(v)}` : ''); };
  }

  // ================================================================ ajustes
  async function vistaAjustes() {
    pintarEstructura('ajustes', 'Ajustes', '<div class="cargando">Cargando…</div>');
    const a = await api('GET', '/api/ajustes');
    $('.pagina').innerHTML = `
      <div class="tarjeta"><h2>Datos de la empresa (aparecen en la remisión impresa)</h2><form id="f-aj">
        <div class="grid grid-2">
          <label class="campo"><span>Nombre de la empresa</span><input name="empresa_nombre" value="${esc(a.empresa_nombre)}"></label>
          <label class="campo"><span>NIT</span><input name="empresa_nit" value="${esc(a.empresa_nit)}"></label>
          <label class="campo"><span>Dirección</span><input name="empresa_direccion" value="${esc(a.empresa_direccion)}"></label>
          <label class="campo"><span>Teléfono</span><input name="empresa_telefono" value="${esc(a.empresa_telefono)}"></label>
          <label class="campo"><span>Representante legal</span><input name="empresa_representante" value="${esc(a.empresa_representante)}"></label>
          <label class="campo"><span>Prefijo del número de remisión</span><input name="prefijo_remision" value="${esc(a.prefijo_remision)}" maxlength="6"></label>
        </div>
        <button class="btn primario">Guardar ajustes</button></form></div>
      ${S.info.direcciones && S.info.direcciones.length ? `<div class="tarjeta"><h2>Conexión de los celulares</h2><p>En la app de cada repartidor, en <b>Vincular con la oficina</b>, escriba una de estas direcciones (el celular debe estar en la misma red Wi-Fi que este computador):</p>
        <ul>${S.info.direcciones.map((d) => `<li><code style="font-size:1.05rem">${esc(d)}</code></li>`).join('')}</ul>
        <p class="small muted">Si Windows pregunta por el firewall al abrir el servidor, permita el acceso en redes privadas.</p></div>` : ''}
      ${cap('datos_demo') ? `<div class="tarjeta"><h2>Datos de ejemplo</h2><p class="muted">Carga clientes, contratos, remisiones y usuarios ficticios para capacitar al personal (contraseña de todos: <b>demo123</b>). Solo funciona si no hay clientes registrados.</p><button class="btn" id="btn-demo">Cargar datos de ejemplo</button></div>` : ''}
      <div class="tarjeta"><h2>Acerca del sistema</h2><p class="muted">Sistema de Remisiones DISTRIMOS v${esc(S.info.version)} · Servidor ${esc(S.info.modo === 'pc' ? 'PC (central)' : 'móvil')}</p></div>`;
    $('#f-aj').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('PUT', '/api/ajustes', formDatos(e.target)); S.empresa = await api('GET', '/api/ajustes-publicos'); toast('Ajustes guardados.', 'ok'); vistaAjustes(); } catch (er) { toast(er.message, 'error'); }
    };
    const bd = $('#btn-demo');
    if (bd) bd.onclick = async () => {
      try { await api('POST', '/api/demo'); toast('Datos de ejemplo cargados.', 'ok'); location.hash = '#/inicio'; } catch (er) { toast(er.message, 'error'); }
    };
  }

  // ================================================================ cuenta y política
  function vistaCuenta() {
    pintarEstructura('cuenta', 'Mi cuenta', `
      <div class="tarjeta detalle"><h2>Mis datos</h2><dl><dt>Nombre</dt><dd>${esc(S.usuario.nombre)}</dd><dt>Usuario</dt><dd>${esc(S.usuario.usuario)}</dd><dt>Rol</dt><dd>${esc(NOMBRE_ROL[S.usuario.rol])}</dd></dl></div>
      <div class="tarjeta"><h2>Cambiar contraseña</h2><form id="f-clave" style="max-width:420px">
        <label class="campo"><span>Contraseña actual</span><input type="password" name="actual" required autocomplete="current-password"></label>
        <label class="campo"><span>Nueva contraseña (mínimo 6 caracteres)</span><input type="password" name="nueva" required minlength="6" autocomplete="new-password"></label>
        <label class="campo"><span>Repita la nueva contraseña</span><input type="password" name="nueva2" required minlength="6" autocomplete="new-password"></label>
        <button class="btn primario">Cambiar contraseña</button></form>
        ${esMovil() ? '<p class="small muted">En el celular, la contraseña de los usuarios vinculados se cambia en el sistema de la oficina y llega con la sincronización.</p>' : ''}</div>`);
    $('#f-clave').onsubmit = async (e) => {
      e.preventDefault();
      const d = formDatos(e.target);
      if (d.nueva !== d.nueva2) return toast('Las contraseñas nuevas no coinciden.', 'error');
      try { await api('POST', '/api/auth/clave', d); S.usuario.debe_cambiar_clave = false; toast('Contraseña cambiada.', 'ok'); location.hash = '#/inicio'; } catch (er) { toast(er.message, 'error'); }
    };
  }

  function vistaPolitica() {
    const html = `<div class="tarjeta" style="max-width:820px"><h2>Política de tratamiento de datos personales</h2>
      <p>En cumplimiento de la <b>Ley 1581 de 2012</b> y el Decreto 1377 de 2013, ${esc(S.empresa ? S.empresa.empresa_nombre : 'DISTRIMOS S.A.S')} informa:</p>
      <ol>
        <li><b>Datos que se recogen:</b> nombre o razón social, NIT o cédula, representante, teléfono, correo y dirección de los clientes; nombre, documento y firma de quien recibe la mercancía; fotografía de la mercancía entregada; fecha y hora de la entrega.</li>
        <li><b>Finalidad:</b> respaldar las entregas realizadas, gestionar el cobro de los contratos, informar al cliente el avance de sus entregas y cumplir obligaciones contractuales y legales.</li>
        <li><b>Seguridad:</b> el acceso es con usuario y contraseña personales, con permisos según el rol; las contraseñas se guardan cifradas (hash) y cada acción queda registrada en la bitácora de auditoría. Se hacen respaldos diarios.</li>
        <li><b>Derechos del titular:</b> conocer, actualizar, rectificar y solicitar la supresión de sus datos, y revocar la autorización, mediante solicitud a la empresa.</li>
        <li><b>Autorización:</b> se solicita la autorización del cliente antes de registrar sus datos; el sistema registra si fue otorgada.</li>
      </ol>
      <p class="small muted">Texto base para revisión con asesoría legal. La empresa debe designar el responsable del tratamiento.</p></div>`;
    if (S.usuario) pintarEstructura('politica', 'Tratamiento de datos', html);
    else $('#raiz').innerHTML = `<div class="pagina" style="margin:0 auto">${html}<a class="btn" href="#/login">Volver</a></div>`;
  }

  // ================================================================ sincronización y vinculación (app móvil)
  async function vistaSincronizacion() {
    pintarEstructura('sincronizacion', 'Sincronización', '<div class="cargando">Cargando…</div>');
    const e = await api('GET', '/api/sync/estado');
    ultimoEstadoSync = e;
    $('.pagina').innerHTML = `
      <div class="aviso info">Este celular trabaja con <b>su propio servidor interno</b>: todo se guarda primero aquí, aunque no haya señal. Cuando hay conexión con la oficina, las entregas se envían solas y llegan las remisiones nuevas.</div>
      <div class="grid grid-3" style="margin-bottom:16px">
        ${kpi(e.pendientes, 'Por enviar a la oficina', e.pendientes ? 'alerta' : 'ok')}
        ${kpi(e.ultima_sync ? fmtFechaHora(e.ultima_sync) : 'Nunca', 'Última sincronización')}
        ${kpi(e.vinculado ? 'Vinculado' : 'Sin vincular', 'Estado', e.vinculado ? 'ok' : 'alerta')}
      </div>
      ${e.ultimo_error ? `<div class="aviso error"><b>Último intento sin éxito:</b> ${esc(e.ultimo_error)}<br><span class="small">Es normal si está en una zona sin señal. Se reintentará automáticamente.</span></div>` : ''}
      <div class="tarjeta detalle"><h2>Conexión</h2><dl>
        <dt>Servidor de la oficina</dt><dd>${esc(e.servidor || 'No configurado')}</dd>
        <dt>Usuario vinculado</dt><dd>${esc(e.usuario_central || '—')}</dd>
        <dt>Prefijo de este celular</dt><dd>${esc(e.prefijo || '')} <span class="muted small">(numeración de remisiones creadas aquí)</span></dd>
        <dt>Servidor de este celular</dt><dd>${esc((S.info.direcciones || []).join(', ') || 'http://127.0.0.1')}</dd>
      </dl>
      <div class="acciones" style="margin-top:16px">
        ${e.vinculado ? `<button class="btn acento grande" id="btn-sync" style="max-width:320px">${ICONO.sync} Sincronizar ahora</button>` : ''}
        <a class="btn" href="#/vincular">${e.vinculado ? 'Cambiar vinculación' : 'Vincular con la oficina'}</a>
      </div></div>`;
    const b = $('#btn-sync');
    if (b) b.onclick = async () => {
      try {
        await conBoton(b, async () => {
          const r = await api('POST', '/api/sync/ejecutar', {});
          toast(r.mensaje || 'Sincronización completa.', 'ok');
        });
        actualizarIndicadorSync(true);
        vistaSincronizacion();
      } catch (er) { toast(er.message, 'error'); vistaSincronizacion(); }
    };
  }

  async function vistaVincular() {
    let e = {};
    try { e = await api('GET', '/api/sync/estado'); } catch (_) { e = {}; }
    const html = `<div class="tarjeta" style="max-width:520px">
      <h2>Vincular con el servidor de la oficina</h2>
      <p class="muted">Escriba la dirección que aparece en la ventana del servidor del computador de la oficina (por ejemplo <code>http://192.168.1.10:3580</code>) y su usuario y contraseña del sistema.</p>
      <form id="f-vin">
        <label class="campo"><span>Dirección del servidor</span><input name="servidor" required value="${esc(e.servidor || 'http://')}" inputmode="url" autocapitalize="none"></label>
        <label class="campo"><span>Usuario</span><input name="usuario" required autocapitalize="none" value="${esc(e.usuario_central || '')}"></label>
        <label class="campo"><span>Contraseña</span><input name="clave" type="password" required></label>
        <label class="campo"><span>Prefijo para remisiones creadas en este celular</span><input name="prefijo" value="${esc(e.prefijo || '')}" maxlength="6" placeholder="Ej.: M1"></label>
        <div id="vin-msg"></div>
        <button class="btn primario grande">Vincular y descargar datos</button>
      </form>
      <p class="small muted" style="margin-top:12px">El celular y el computador deben estar conectados a la misma red (Wi-Fi de la oficina) o el servidor debe estar publicado en internet.</p>
      ${S.usuario ? '' : '<a class="btn texto" href="#/login">Volver al ingreso</a>'}</div>`;
    if (S.usuario) pintarEstructura('sincronizacion', 'Vincular celular', html, { volver: '#/sincronizacion' });
    else $('#raiz').innerHTML = `<div class="login-fondo">${html.replace('class="tarjeta"', 'class="login"')}</div>`;
    $('#f-vin').onsubmit = async (ev) => {
      ev.preventDefault();
      const d = formDatos(ev.target);
      const btn = $('button', ev.target);
      try {
        await conBoton(btn, async () => {
          const r = await api('POST', '/api/sync/vincular', d);
          toast(r.mensaje || 'Celular vinculado.', 'ok');
          if (r.token) iniciarSesion(r);
          else { location.hash = S.usuario ? '#/sincronizacion' : '#/login'; enrutar(); }
        });
      } catch (er) { $('#vin-msg').innerHTML = `<div class="aviso error">${esc(er.message)}</div>`; }
    };
  }

  function vistaMas() {
    const todas = opcionesMenu();
    pintarEstructura('mas', 'Más opciones', `<div class="lista-tarjetas">
      ${todas.map((o) => `<a class="item-tarjeta" href="#/${o.r}">${ICONO[o.i]}<div class="cuerpo"><b>${esc(o.t)}</b></div></a>`).join('')}
      <a class="item-tarjeta" href="#/politica">${ICONO.politica}<div class="cuerpo"><b>Tratamiento de datos</b></div></a>
      <a class="item-tarjeta" href="#" id="mas-salir">${ICONO.salir}<div class="cuerpo"><b>Cerrar sesión</b><div class="muted">${esc(S.usuario.nombre)} · ${esc(NOMBRE_ROL[S.usuario.rol])}</div></div></a>
    </div>`);
    $$('.item-tarjeta svg').forEach((s) => { s.style.width = '24px'; s.style.height = '24px'; s.style.color = 'var(--azul-2)'; });
    $('#mas-salir').onclick = (e) => { e.preventDefault(); cerrarSesion(true); };
  }

  // ================================================================ enrutador
  function leerRuta() {
    const h = location.hash.replace(/^#\/?/, '');
    const [ruta, qs] = h.split('?');
    const partes = ruta.split('/').filter(Boolean);
    const params = {};
    if (qs) for (const par of qs.split('&')) { const [k, v] = par.split('='); if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || ''); }
    return { partes, params };
  }

  async function enrutar() {
    const { partes, params } = leerRuta();
    const [a, b, c] = partes;
    try {
      if (a === 'politica') return vistaPolitica();
      if (a === 'vincular' && cap('sync_movil')) return await vistaVincular();
      if (!S.usuario) return await vistaLogin();
      switch (a) {
        case undefined: case 'inicio': case 'login': return await vistaInicio();
        case 'remisiones':
          if (b === 'nueva') { if (!es('secretario')) { toast('Solo la secretaria puede crear remisiones.', 'error'); location.hash = '#/remisiones'; return; } return await vistaFormRemision(null); }
          if (b && c === 'editar') return await vistaFormRemision(b);
          if (b && c === 'entrega') return await vistaEntrega(b);
          if (b && c === 'imprimir') return await vistaImprimir(b);
          if (b) return await vistaDetalleRemision(b);
          return await vistaRemisiones(params);
        case 'contratos': return b ? await vistaDetalleContrato(b) : await vistaContratos();
        case 'clientes': return await vistaClientes();
        case 'productos': return await vistaProductos();
        case 'usuarios': return await vistaUsuarios();
        case 'respaldos': return await vistaRespaldos();
        case 'auditoria': return await vistaAuditoria(params);
        case 'ajustes': return await vistaAjustes();
        case 'sincronizacion': return await vistaSincronizacion();
        case 'cuenta': return vistaCuenta();
        case 'mas': return vistaMas();
        default: location.hash = '#/inicio';
      }
    } catch (e) {
      const pag = $('.pagina');
      if (pag) pag.innerHTML = `<div class="aviso error">${esc(e.message)}</div><a class="btn" href="#/inicio">Ir al inicio</a>`;
      else toast(e.message, 'error');
    }
  }

  // ================================================================ arranque
  async function iniciar() {
    Escenas.observar($('#raiz'));
    if (window.SinConexion) await window.SinConexion.listo;
    try {
      [S.info, S.empresa] = await Promise.all([api('GET', '/api/info'), api('GET', '/api/ajustes-publicos')]);
    } catch (e) {
      $('#raiz').innerHTML = `<div class="login-fondo"><div class="login"><h1>Sin conexión con el servidor</h1><p>${esc(e.message)}</p><button class="btn primario" onclick="location.reload()">Reintentar</button></div></div>`;
      return;
    }
    document.title = `Remisiones · ${S.empresa.empresa_nombre}`;
    if (S.token) {
      try { const r = await api('GET', '/api/auth/yo'); S.usuario = r.usuario; iniciarSyncAutomatica(); } catch (_) { S.token = null; guardar('rem_token', null); }
    }
    iniciarModoSinConexion();
    window.addEventListener('hashchange', enrutar);
    enrutar();
  }

  iniciar();
})();
