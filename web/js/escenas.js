/* Ilustraciones animadas del sistema (SVG en línea, sin archivos externos para que funcione sin internet).
 * Temática: reparto de morrales y kits escolares por las carreteras de La Guajira:
 * camión de DISTRIMOS, desierto, cardones, molinos de viento de Jepírachi, sol y bandas geométricas
 * de inspiración wayuu. Todas las animaciones son CSS y se desactivan con "reducir movimiento".
 */
(function () {
  'use strict';
  let seq = 0;

  // ---------------------------------------------------------------- camión de reparto
  function camion(conCarga = true) {
    return `
      <g class="camion">
        <g class="polvo"><circle cx="-14" cy="74" r="7"/><circle cx="-28" cy="70" r="5"/><circle cx="-40" cy="76" r="4"/></g>
        <g class="carroceria">
          <rect x="0" y="0" width="176" height="70" rx="6" fill="#d9731a"/>
          <rect x="0" y="0" width="176" height="12" rx="6" fill="#e8913f"/>
          <path d="M8 56 l10 -8 l10 8 l10 -8 l10 8 l10 -8 l10 8 l10 -8 l10 8 l10 -8 l10 8 l10 -8 l10 8 l10 -8 l10 8 l10 -8 l10 8" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="2.4"/>
          <text x="88" y="40" text-anchor="middle" font-size="19" font-weight="800" fill="#fff" font-family="Segoe UI, Roboto, sans-serif" letter-spacing="1.5">DISTRIMOS</text>
          ${conCarga ? `<g class="carga"><rect x="22" y="-16" width="26" height="18" rx="3" fill="#f6c99d"/><path d="M22 -10 h26" stroke="#c9873f"/><rect x="54" y="-22" width="22" height="24" rx="6" fill="#1f4a73"/><path d="M60 -22 v-4 a5 5 0 0 1 10 0 v4" fill="none" stroke="#1f4a73" stroke-width="2.4"/><rect x="58" y="-10" width="14" height="7" rx="2" fill="#d9731a"/></g>` : ''}
          <path d="M180 14 h38 l26 26 v30 h-64 z" fill="#16324f"/>
          <path d="M188 20 h26 l18 20 h-44 z" fill="#a9d4f5"/>
          <rect x="236" y="54" width="10" height="7" rx="2" fill="#ffd166"/>
          <rect x="176" y="66" width="72" height="6" rx="3" fill="#0f2237"/>
        </g>
        <g transform="translate(40 76)"><g class="rueda"><circle r="14" fill="#1b2430"/><circle r="6" fill="#c9d1db"/><path d="M0 -12 V12 M-12 0 H12" stroke="#5b6776" stroke-width="2"/></g></g>
        <g transform="translate(140 76)"><g class="rueda"><circle r="14" fill="#1b2430"/><circle r="6" fill="#c9d1db"/><path d="M0 -12 V12 M-12 0 H12" stroke="#5b6776" stroke-width="2"/></g></g>
        <g transform="translate(214 76)"><g class="rueda"><circle r="14" fill="#1b2430"/><circle r="6" fill="#c9d1db"/><path d="M0 -12 V12 M-12 0 H12" stroke="#5b6776" stroke-width="2"/></g></g>
      </g>`;
  }

  function molino(x, y, escala, retraso) {
    return `<g transform="translate(${x} ${y}) scale(${escala})" opacity=".85">
      <path d="M-2 0 L-4 90 H4 L2 0 Z" fill="#e9eef3"/>
      <g class="aspas" style="animation-delay:${retraso}s"><path d="M0 0 L-3 -40 L0 -44 L3 -40 Z M0 0 L36 18 L38 22 L33 22 Z M0 0 L-33 22 L-38 22 L-36 18 Z" fill="#fff"/><circle r="3.5" fill="#d0d8e0"/></g>
    </g>`;
  }

  function cardon(x, alto) {
    return `<g transform="translate(${x} 0)" fill="#3f6b4a">
      <rect x="-6" y="${-alto}" width="12" height="${alto}" rx="6"/>
      <path d="M-6 ${-alto * 0.55} h-10 a6 6 0 0 1 -6 -6 v-${alto * 0.25} a5 5 0 0 1 10 0 v${alto * 0.18} h6 z"/>
      <path d="M6 ${-alto * 0.4} h10 a6 6 0 0 0 6 -6 v-${alto * 0.3} a5 5 0 0 0 -10 0 v${alto * 0.24} h-6 z"/>
    </g>`;
  }

  /** Paisaje guajiro con el camión en marcha. tipo: 'grande' (ingreso) o 'banda' (encabezados). */
  function ruta(tipo = 'grande') {
    const id = `e${++seq}`;
    const alto = tipo === 'banda' ? 230 : 330;
    const suelo = alto - 70;
    const cardones = [40, 230, 410, 610, 760].map((x, i) => cardon(x, 34 + (i % 3) * 14)).join('');
    return `<svg class="escena escena-${tipo}" viewBox="0 0 800 ${alto}" preserveAspectRatio="xMidYMax slice" role="img" aria-label="Camión de DISTRIMOS repartiendo por una carretera de La Guajira">
      <defs>
        <linearGradient id="${id}-cielo" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f4a73"/><stop offset=".6" stop-color="#3e7cae"/><stop offset="1" stop-color="#f3b27a"/></linearGradient>
        <radialGradient id="${id}-sol"><stop offset="0" stop-color="#ffe29a"/><stop offset=".55" stop-color="#ffb347"/><stop offset="1" stop-color="#ffb347" stop-opacity="0"/></radialGradient>
      </defs>
      <rect width="800" height="${alto}" fill="url(#${id}-cielo)"/>
      <g class="sol" transform="translate(640 ${tipo === 'banda' ? 70 : 96})">
        <circle r="70" fill="url(#${id}-sol)" class="halo"/>
        <g class="rayos" stroke="#ffd27f" stroke-width="3" stroke-linecap="round" opacity=".7">${Array.from({ length: 12 }, (_, i) => `<line x1="0" y1="-46" x2="0" y2="-58" transform="rotate(${i * 30})"/>`).join('')}</g>
        <circle r="32" fill="#ffc861"/>
      </g>
      <g class="nube" fill="#fff" opacity=".85"><ellipse cx="120" cy="60" rx="38" ry="12"/><ellipse cx="146" cy="52" rx="24" ry="12"/></g>
      <g class="nube lenta" fill="#fff" opacity=".6"><ellipse cx="430" cy="${tipo === 'banda' ? 40 : 90}" rx="44" ry="11"/><ellipse cx="456" cy="${tipo === 'banda' ? 33 : 82}" rx="22" ry="10"/></g>
      ${molino(90, suelo - 92, 0.9, 0)}${molino(150, suelo - 80, 0.75, -1.3)}${molino(205, suelo - 72, 0.62, -0.6)}
      <path d="M0 ${suelo - 30} C 120 ${suelo - 60} 220 ${suelo - 18} 360 ${suelo - 38} S 620 ${suelo - 64} 800 ${suelo - 30} V ${alto} H0 Z" fill="#e7b98a"/>
      <path d="M0 ${suelo - 8} C 160 ${suelo - 30} 300 ${suelo - 2} 470 ${suelo - 16} S 700 ${suelo - 30} 800 ${suelo - 10} V ${alto} H0 Z" fill="#d9a06c"/>
      <g transform="translate(0 ${suelo + 2})"><g class="desfile"><g>${cardones}</g><g transform="translate(800 0)">${cardones}</g></g></g>
      <rect y="${suelo + 4}" width="800" height="${alto - suelo}" fill="#3a3f47"/>
      <rect y="${suelo + 4}" width="800" height="4" fill="#c9a27a"/>
      <line class="linea-via" x1="0" y1="${suelo + 38}" x2="800" y2="${suelo + 38}" stroke="#ffd166" stroke-width="5" stroke-dasharray="44 30"/>
      <g transform="translate(${tipo === 'banda' ? 330 : 290} ${suelo - 58})">${camion(true)}</g>
    </svg>`;
  }

  // ---------------------------------------------------------------- logo y banda decorativa
  function logo(tam = 40) {
    return `<svg class="logo-svg" width="${tam}" height="${tam}" viewBox="0 0 64 64" aria-hidden="true">
      <defs><linearGradient id="lg-logo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f09a3e"/><stop offset="1" stop-color="#c85f12"/></linearGradient></defs>
      <rect width="64" height="64" rx="15" fill="url(#lg-logo)"/>
      <path d="M17 15h21l9 9v25H17z" fill="#fff"/><path d="M38 15v9h9" fill="#f6c99d"/>
      <path d="M23 31h18M23 37h18M23 43h11" stroke="#16324f" stroke-width="3" stroke-linecap="round"/>
      <path class="logo-check" d="M36 44l4 4 8-9" fill="none" stroke="#1e8a4c" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  // ---------------------------------------------------------------- animación de entrega registrada
  function celebrarEntrega(numero) {
    return new Promise((resolve) => {
      const capa = document.createElement('div');
      capa.className = 'exito-fondo';
      capa.innerHTML = `<div class="exito">
        <svg class="exito-check" viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="50" class="c"/><path d="M38 62l15 15 30-33" class="v"/></svg>
        <h2>¡Entrega registrada!</h2>
        <p>Remisión <b>${String(numero || '').replace(/[<>&"]/g, '')}</b> con firma, foto, fecha y hora.</p>
        <svg class="exito-ruta" viewBox="0 0 600 110" aria-hidden="true"><rect y="92" width="600" height="18" fill="#3a3f47"/><line class="linea-via" x1="0" y1="101" x2="600" y2="101" stroke="#ffd166" stroke-width="3" stroke-dasharray="30 20"/>
          <g class="camion-sale"><g transform="translate(0 6) scale(.9)">${camion(false)}</g></g></svg>
      </div>`;
      document.body.appendChild(capa);
      const fin = () => { capa.classList.add('sale'); setTimeout(() => { capa.remove(); resolve(); }, 280); };
      const t = setTimeout(fin, 2300);
      capa.addEventListener('click', () => { clearTimeout(t); fin(); });
    });
  }

  // ---------------------------------------------------------------- contadores que suben al aparecer
  const reducir = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function animarContador(el) {
    el.dataset.animado = '1';
    const texto = el.textContent.trim();
    const m = /^(\D*?)(\d{1,3}(?:\.\d{3})+|\d+)(,\d+)?(.*)$/.exec(texto);
    if (!m || reducir()) return;
    const decimales = m[3] ? m[3].length - 1 : 0;
    const objetivo = Number(m[2].replace(/\./g, '') + (m[3] ? '.' + m[3].slice(1) : ''));
    if (!isFinite(objetivo) || objetivo === 0) return;
    const inicio = performance.now();
    const dur = Math.min(1400, 600 + Math.log10(objetivo + 1) * 120);
    const paso = (t) => {
      const k = Math.min(1, (t - inicio) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = m[1] + (objetivo * e).toLocaleString('es-CO', { minimumFractionDigits: decimales, maximumFractionDigits: decimales }) + m[4];
      if (k < 1) requestAnimationFrame(paso); else el.textContent = texto;
    };
    requestAnimationFrame(paso);
  }

  function observar(raiz) {
    let pendiente = false;
    const revisar = () => {
      pendiente = false;
      raiz.querySelectorAll('.kpi .v:not([data-animado])').forEach(animarContador);
    };
    new MutationObserver(() => { if (!pendiente) { pendiente = true; requestAnimationFrame(revisar); } }).observe(raiz, { childList: true, subtree: true });
  }

  function saludo() {
    const h = new Date().getHours();
    return h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
  }

  window.Escenas = { ruta, camion, logo, celebrarEntrega, observar, saludo };
})();
