// Renders build/qr/*.html (from tools/make_qr.py) to qr/slagalica_android.png, qr/slagalica_windows.png
// (2000 x 2680 px) and qr/slagalica_qr_print.pdf (both cards on one A4 page).
const { chromium } = require('playwright');
const path = require('path');
const root = path.join(__dirname, '..');
(async () => {
  const b = await chromium.launch();
  for (const id of ['android', 'windows']) {
    const p = await b.newPage({ viewport: { width: 1000, height: 1340 }, deviceScaleFactor: 2 });
    await p.goto('file://' + path.join(root, 'build/qr', id + '.html'));
    await p.evaluate(() => document.fonts.ready);
    await p.locator('.card').screenshot({ path: path.join(root, 'qr', `slagalica_${id}.png`) });
    await p.close();
  }
  const p = await b.newPage();
  await p.goto('file://' + path.join(root, 'build/qr/sheet.html'));
  await p.evaluate(() => document.fonts.ready);
  await p.pdf({ path: path.join(root, 'qr', 'slagalica_qr_print.pdf'), format: 'A4', printBackground: true });
  await b.close();
  console.log('rendered qr/');
})();
