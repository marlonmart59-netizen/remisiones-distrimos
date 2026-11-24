// Prueba de interfaz de punta a punta con Chrome instalado (playwright-core).
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const BASE = process.argv[2] || 'http://localhost:3591';
const OUT = path.join(__dirname, 'capturas');
fs.mkdirSync(OUT, { recursive: true });
const errores = [];

async function sesion(browser, usuario, clave, movil) {
  const ctx = await browser.newContext(movil ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } : { viewport: { width: 1366, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errores.push(`[${usuario}] pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errores.push(`[${usuario}] console: ${m.text()}`); });
  await page.goto(BASE + '/#/login');
  await page.fill('input[name=usuario]', usuario);
  await page.fill('input[name=clave]', clave);
  await page.click('button[type=submit]');
  await page.waitForSelector('.pagina', { timeout: 10000 });
  await page.waitForTimeout(600);
  return { ctx, page };
}

const cap = (page, n) => page.screenshot({ path: path.join(OUT, n + '.png'), fullPage: true });

(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });

  // ---- secretaria: crear y editar remisión
  let { ctx, page } = await sesion(browser, 'secretaria', 'demo123');
  await cap(page, '01-secretaria-inicio');
  await page.goto(BASE + '/#/remisiones/nueva');
  await page.waitForSelector('select[name=contrato_id]');
  const opt = await page.$$eval('select[name=contrato_id] option', (o) => o.map((x) => x.value).filter(Boolean));
  await page.selectOption('select[name=contrato_id]', opt[0]);
  await page.waitForTimeout(500);
  const prods = await page.$$eval('#items .i-prod option', (o) => o.map((x) => x.value).filter(Boolean));
  await page.selectOption('#items .i-prod', prods[0]);
  await page.fill('#items .i-cant', '150');
  const reps = await page.$$eval('select[name=repartidor_id] option', (o) => o.map((x) => x.value).filter(Boolean));
  await page.selectOption('select[name=repartidor_id]', { label: 'Repartidor Ruta Uribia' }); void reps;
  await cap(page, '02-nueva-remision');
  await page.click('button[type=submit]');
  await page.waitForSelector('.historial', { timeout: 10000 });
  const urlRem = page.url();
  console.log('Remisión creada:', urlRem);
  await page.click('a:has-text("Editar")');
  await page.waitForSelector('textarea[name=motivo]');
  await page.fill('#items .i-cant', '180');
  await page.fill('textarea[name=motivo]', 'El cliente pidió aumentar la cantidad');
  await page.click('button[type=submit]');
  await page.waitForSelector('.historial li.editada', { timeout: 10000 });
  await cap(page, '03-remision-editada');
  await ctx.close();

  // ---- repartidor (celular): registrar entrega con firma y foto
  ({ ctx, page } = await sesion(browser, 'repartidor1', 'demo123', true));
  await cap(page, '04-repartidor-inicio-movil');
  await page.goto(urlRem.replace(/#.*$/, '') + '#/remisiones/' + urlRem.split('/').pop() + '/entrega');
  await page.waitForSelector('#lienzo');
  const box = await page.locator('#lienzo').boundingBox();
  await page.mouse.move(box.x + 30, box.y + 120);
  await page.mouse.down();
  for (let i = 0; i < 40; i++) await page.mouse.move(box.x + 30 + i * 7, box.y + 110 + Math.sin(i / 3) * 40);
  await page.mouse.up();
  await page.setInputFiles('#in-foto', path.join(__dirname, 'foto.png'));
  await page.waitForSelector('#previa:not(.hidden)', { timeout: 5000 });
  await page.fill('input[name=receptor_documento]', '1122334455');
  await cap(page, '05-entrega-movil');
  await page.click('button[type=submit]');
  await page.waitForSelector('.evidencias img', { timeout: 10000 });
  await page.waitForTimeout(800);
  await cap(page, '06-remision-entregada-movil');
  await ctx.close();

  // ---- gerente: panel y contrato
  ({ ctx, page } = await sesion(browser, 'gerente', 'demo123'));
  await cap(page, '07-gerente-inicio');
  await page.click('.tabla tr.clic >> nth=0');
  await page.waitForSelector('.kpi');
  await page.waitForTimeout(400);
  await cap(page, '08-gerente-contrato');
  await page.goto(urlRem.replace(/\/[^/]+$/, '/' + urlRem.split('/').pop()) + '/imprimir');
  await page.waitForSelector('.hoja');
  await page.waitForTimeout(800);
  await cap(page, '09-formato-impresion');
  await page.goto(BASE + '/#/insumos');
  await page.waitForSelector('.kpi');
  await cap(page, '10-insumos');
  await ctx.close();

  // ---- cliente
  ({ ctx, page } = await sesion(browser, 'cliente1', 'demo123'));
  await cap(page, '11-cliente-inicio');
  await ctx.close();

  // ---- admin: cambio de clave obligatorio y respaldos
  ({ ctx, page } = await sesion(browser, 'admin', 'admin123'));
  await page.waitForSelector('#f-clave');
  await page.fill('input[name=actual]', 'admin123');
  await page.fill('input[name=nueva]', 'Admin2026');
  await page.fill('input[name=nueva2]', 'Admin2026');
  await page.click('#f-clave button');
  await page.waitForTimeout(800);
  await page.goto(BASE + '/#/respaldos');
  await page.waitForSelector('#btn-resp');
  await page.click('#btn-resp');
  await page.waitForTimeout(1500);
  await page.click('[data-ver] >> nth=0');
  await page.waitForSelector('.modal');
  await cap(page, '12-respaldos-prueba');
  await page.goto(BASE + '/#/usuarios');
  await page.waitForSelector('.tabla');
  await cap(page, '13-usuarios');
  await page.goto(BASE + '/#/auditoria');
  await page.waitForSelector('.tabla');
  await cap(page, '14-auditoria');
  await ctx.close();

  await browser.close();
  console.log('ERRORES:', errores.length ? errores.join('\n') : 'ninguno');
})().catch((e) => { console.error('FALLO:', e); console.log('ERRORES:', errores.join('\n')); process.exit(1); });
