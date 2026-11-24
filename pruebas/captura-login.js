const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  for (const [n, vp] of [['login-pc', { width: 1366, height: 800 }], ['login-movil', { width: 390, height: 844 }]]) {
    const p = await b.newPage({ viewport: vp, deviceScaleFactor: vp.width < 500 ? 2 : 1 });
    await p.goto('http://localhost:3591/#/login'); await p.waitForTimeout(1600);
    await p.screenshot({ path: `capturas/${n}.png` }); await p.close();
  }
  await b.close();
})();
