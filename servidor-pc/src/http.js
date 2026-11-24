'use strict';
/** Utilidades HTTP mínimas: enrutador, errores, lectura de cuerpos y respuestas. */

class ErrorHttp extends Error {
  constructor(estado, mensaje, extra) {
    super(mensaje);
    this.estado = estado;
    this.extra = extra;
  }
}

const err = (estado, mensaje, extra) => new ErrorHttp(estado, mensaje, extra);

class Enrutador {
  constructor() { this.rutas = []; }

  /**
   * Registra una ruta. `roles` = null (público), '*' (cualquier usuario autenticado)
   * o un arreglo de roles permitidos.
   */
  agregar(metodo, patron, roles, manejador, opciones = {}) {
    const nombres = [];
    const regex = new RegExp('^' + patron.replace(/\/:([a-zA-Z_]+)/g, (_, n) => { nombres.push(n); return '/([^/]+)'; }) + '/?$');
    this.rutas.push({ metodo, regex, nombres, roles, manejador, opciones });
  }

  buscar(metodo, ruta) {
    let existeRuta = false;
    for (const r of this.rutas) {
      const m = r.regex.exec(ruta);
      if (!m) continue;
      existeRuta = true;
      if (r.metodo !== metodo) continue;
      const params = {};
      r.nombres.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      return { r, params };
    }
    return existeRuta ? { metodoInvalido: true } : null;
  }
}

function leerCuerpo(req, limiteBytes) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limiteBytes) {
        reject(err(413, 'La información enviada es demasiado grande.'));
        req.destroy();
        return;
      }
      partes.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

const CABECERAS_SEGURIDAD = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
};

function enviarJson(res, estado, datos) {
  const cuerpo = Buffer.from(JSON.stringify(datos));
  res.writeHead(estado, {
    ...CABECERAS_SEGURIDAD,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': cuerpo.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(cuerpo);
}

function enviarBinario(res, tipo, datos, extra = {}) {
  res.writeHead(200, {
    ...CABECERAS_SEGURIDAD,
    'Content-Type': tipo,
    'Content-Length': datos.length,
    'Access-Control-Allow-Origin': '*',
    ...extra,
  });
  res.end(datos);
}

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

module.exports = { ErrorHttp, err, Enrutador, leerCuerpo, enviarJson, enviarBinario, TIPOS, CABECERAS_SEGURIDAD };
