// Prueba de integración: servidor PC (central) <-> servidor del celular, con corte de conexión.
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const PC = 'http://localhost:3591';
const MOV = 'http://localhost:8766';
const RAIZ = path.resolve(__dirname, '..');
let ok = 0; let fallos = 0;
const check = (cond, msg) => { if (cond) { ok++; console.log('  OK  ', msg); } else { fallos++; console.log('  FALLA', msg); } };

async function api(base, metodo, ruta, token, body) {
  const r = await fetch(base + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, ...d, _d: d };
}
const png = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'foto.png')).toString('base64');
const login = async (base, u, c) => (await api(base, 'POST', '/api/auth/login', null, { usuario: u, clave: c })).token;
const pidPuerto = (p) => { const o = execSync('netstat -ano').toString().split('\n').find((l) => l.includes(`:${p} `) && l.includes('LISTENING')); return o ? o.trim().split(/\s+/).pop() : null; };
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('1. Vincular celular con la oficina');
  const v = await api(MOV, 'POST', '/api/sync/vincular', null, { servidor: 'localhost:3591', usuario: 'repartidor1', clave: 'demo123', prefijo: 'M1' });
  check(v.status === 200 && v.token && v.usuario.usuario === 'repartidor1', `vinculación (${v.mensaje || v.error})`);
  const tm = v.token;

  console.log('2. Login sin conexión en el celular con clave sincronizada (PBKDF2 compatible)');
  const tm2 = await login(MOV, 'repartidor1', 'demo123');
  check(!!tm2, 'login local con hash descargado del PC');
  check(!(await login(MOV, 'repartidor1', 'mala')), 'clave incorrecta rechazada');

  console.log('3. Panel del repartidor en el celular');
  const panel = await api(MOV, 'GET', '/api/panel', tm);
  check(panel.rol === 'repartidor' && panel.pendientes.length >= 1, `remisiones pendientes descargadas: ${panel.pendientes.length}`);

  console.log('4. Entrega con firma y foto en el celular');
  const pend = panel.pendientes[0];
  const e = await api(MOV, 'POST', `/api/remisiones/${pend.id}/entrega`, tm, { receptor_nombre: 'Prueba Receptor', receptor_documento: '123', firma: png, foto: png });
  check(e.status === 200 && e.estado === 'entregada' && e.evidencias.length === 2, `entrega registrada en ${pend.numero}`);

  console.log('5. Nueva remisión creada en el celular');
  const cons = await api(MOV, 'GET', '/api/contratos', tm);
  const c0 = cons._d[0];
  const det = await api(MOV, 'GET', `/api/contratos/${c0.id}`, tm);
  const nueva = await api(MOV, 'POST', '/api/remisiones', tm, { contrato_id: c0.id, items: [{ producto_id: det.avance.items[0].producto_id, cantidad: 25 }] });
  check(nueva.status === 200 && /^M1-/.test(nueva.numero), `remisión ${nueva.numero} con prefijo del celular`);

  console.log('6. Sincronización');
  let est = await api(MOV, 'GET', '/api/sync/estado');
  check(est.pendientes === 2, `pendientes por enviar: ${est.pendientes}`);
  const s = await api(MOV, 'POST', '/api/sync/ejecutar', tm);
  check(s.status === 200 && s.enviadas === 2, `sync: ${s.mensaje || s.error}`);
  est = await api(MOV, 'GET', '/api/sync/estado');
  check(est.pendientes === 0, 'sin pendientes tras sincronizar');

  console.log('7. Verificación en el servidor PC');
  const tp = await login(PC, 'secretaria', 'demo123');
  const rpc = await api(PC, 'GET', `/api/remisiones/${pend.id}`, tp);
  check(rpc.estado === 'entregada' && rpc.evidencias.length === 2 && rpc.receptor_nombre === 'Prueba Receptor', 'la entrega llegó al PC con firma y foto');
  const npc = await api(PC, 'GET', `/api/remisiones/${nueva.id}`, tp);
  check(npc.status === 200 && npc.numero === nueva.numero, 'la remisión creada en el celular llegó al PC');

  console.log('8. Edición en oficina y descarga al celular');
  const reps = await api(PC, 'GET', '/api/repartidores', tp);
  const rep1 = reps._d.find((r) => r.usuario === 'repartidor1');
  const creada = await api(PC, 'POST', '/api/remisiones', tp, { contrato_id: c0.id, repartidor_id: rep1.id, items: [{ producto_id: det.avance.items[0].producto_id, cantidad: 10 }] });
  const ed = await api(PC, 'PUT', `/api/remisiones/${creada.id}`, tp, { items: [{ producto_id: det.avance.items[0].producto_id, cantidad: 12 }], motivo: 'Corrección de cantidad' });
  check(ed.editada === 1 && ed.historial.some((h) => h.accion === 'editada' && h.version_anterior), 'edición con motivo y versión anterior conservada');
  const sinMotivo = await api(PC, 'PUT', `/api/remisiones/${creada.id}`, tp, { motivo: '' });
  check(sinMotivo.status === 400, 'edición sin motivo rechazada');
  const rEdit = await api(PC, 'PUT', `/api/remisiones/${creada.id}`, await login(PC, 'repartidor1', 'demo123'), { motivo: 'intento de repartidor' });
  check(rEdit.status === 403, 'repartidor no puede editar en el PC');
  await api(MOV, 'POST', '/api/sync/ejecutar', tm);
  const enMov = await api(MOV, 'GET', `/api/remisiones/${creada.id}`, tm);
  check(enMov.status === 200 && enMov.editada === 1 && enMov.unidades === 12, 'el celular recibió la remisión editada');

  console.log('9. Corte de conexión: entregar sin servidor de oficina');
  const pid = pidPuerto(3591);
  execSync(`taskkill /F /PID ${pid}`);
  await esperar(800);
  const e2 = await api(MOV, 'POST', `/api/remisiones/${creada.id}/entrega`, tm, { receptor_nombre: 'Sin Señal', firma: png, sin_foto_motivo: 'Cámara dañada' });
  check(e2.status === 200 && e2.estado === 'entregada', 'entrega guardada en el celular sin conexión');
  const sFail = await api(MOV, 'POST', '/api/sync/ejecutar', tm);
  check(sFail.status === 503, `sync sin conexión informa: ${sFail.error}`);
  est = await api(MOV, 'GET', '/api/sync/estado');
  check(est.pendientes === 1, 'la entrega queda pendiente, no se pierde');

  console.log('10. Vuelve la conexión');
  const srv = spawn(process.execPath, [path.join(RAIZ, 'servidor-pc/src/main.js')], { env: { ...process.env, REMISIONES_DATOS: process.env.TEMP + '/rem-test-ui', NO_ABRIR: '1', PUERTO: '3591' }, detached: true, stdio: 'ignore' });
  srv.unref();
  await esperar(2500);
  const s2 = await api(MOV, 'POST', '/api/sync/ejecutar', tm);
  check(s2.status === 200 && s2.enviadas === 1, `reenvío automático: ${s2.mensaje || s2.error}`);
  const fin = await api(PC, 'GET', `/api/remisiones/${creada.id}`, await login(PC, 'gerente', 'demo123'));
  check(fin.estado === 'entregada' && fin.receptor_nombre === 'Sin Señal', 'la entrega hecha sin señal llegó a la oficina');

  console.log('11. Restricciones en el celular');
  const edMov = await api(MOV, 'PUT', `/api/remisiones/${creada.id}`, await login(MOV, 'secretaria', 'demo123'), { motivo: 'prueba de edición' });
  check(edMov.status === 403, 'el celular no permite editar remisiones (solo la oficina)');

  console.log(`\nRESULTADO: ${ok} correctas, ${fallos} fallidas`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
