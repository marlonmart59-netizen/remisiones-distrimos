'use strict';
/**
 * Seguridad: hash de contraseñas (PBKDF2-SHA256) y tokens firmados (HMAC-SHA256).
 * El formato es idéntico al del servidor móvil (Dart) para que los usuarios
 * sincronizados desde el PC puedan iniciar sesión en el celular sin conexión.
 *
 *   hash  = "pbkdf2$<iteraciones>$<sal base64>$<derivada base64>"
 *   token = "<payload base64url>.<firma base64url>"
 */
const crypto = require('node:crypto');

const ITERACIONES = 60000;

function hashClave(clave) {
  const sal = crypto.randomBytes(16);
  const der = crypto.pbkdf2Sync(String(clave), sal, ITERACIONES, 32, 'sha256');
  return `pbkdf2$${ITERACIONES}$${sal.toString('base64')}$${der.toString('base64')}`;
}

function verificarClave(clave, hash) {
  try {
    const [alg, iter, salB64, derB64] = String(hash).split('$');
    if (alg !== 'pbkdf2') return false;
    const esperado = Buffer.from(derB64, 'base64');
    const der = crypto.pbkdf2Sync(String(clave), Buffer.from(salB64, 'base64'), Number(iter), esperado.length, 'sha256');
    return crypto.timingSafeEqual(der, esperado);
  } catch (_) {
    return false;
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function crearToken(datos, secreto, horas = 12) {
  const payload = { ...datos, exp: Date.now() + horas * 3600 * 1000 };
  const p = b64url(JSON.stringify(payload));
  const firma = b64url(crypto.createHmac('sha256', secreto).update(p).digest());
  return `${p}.${firma}`;
}

function leerToken(token, secreto) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [p, firma] = token.split('.');
  const esperada = b64url(crypto.createHmac('sha256', secreto).update(p).digest());
  const a = Buffer.from(firma);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const datos = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!datos.exp || datos.exp < Date.now()) return null;
    return datos;
  } catch (_) {
    return null;
  }
}

function secretoAleatorio() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { hashClave, verificarClave, crearToken, leerToken, secretoAleatorio };
