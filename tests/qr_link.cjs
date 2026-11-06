// The links in the QR codes carry ?p=android or ?p=windows. AR used to need Chrome, so Android
// browsers were sent there; AR now works in every phone browser, so every browser stays put and the
// tag just disappears from the address (other options are kept).
// usage: node tests/qr_link.cjs <url>
const { chromium } = require('playwright');
const url = process.argv[2] || 'http://127.0.0.1:8099/';
const UA = {
  chrome: 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36',
  firefox: 'Mozilla/5.0 (Android 14; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0',
  webview: 'Mozilla/5.0 (Linux; Android 14; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/155.0.0.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1',
};
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const results = [];
  const check = (name, ok, extra = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };
  const visit = async (ua, q) => {
    const ctx = await b.newContext({ userAgent: ua, viewport: { width: 412, height: 892 } });
    const p = await ctx.newPage();
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Page.enable');
    const asked = [];
    cdp.on('Page.frameRequestedNavigation', e => asked.push(e.url));
    p.on('request', r => { if (r.isNavigationRequest()) asked.push(r.url()); });
    await p.goto(url + q, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await p.waitForTimeout(1500);
    const now = p.url();
    await ctx.close();
    return { asked, now };
  };
  const intent = a => a.find(u => u.startsWith('intent://'));
  for (const name of ['samsung', 'firefox', 'chrome', 'webview', 'iphone']) {
    const r = await visit(UA[name], '?p=android&reset');
    check(`${name}: stays, tag dropped, other options kept`, !intent(r.asked) && r.now.endsWith('/?reset'), r.now);
  }
  let r = await visit(UA.iphone, '?p=android');
  check('iPhone with the Android code: clean address', !intent(r.asked) && /\/$/.test(r.now), r.now);
  r = await visit(UA.windows, '?p=windows');
  check('Windows: stays, tag dropped', !intent(r.asked) && /\/$/.test(r.now), r.now);
  r = await visit(UA.samsung, '');
  check('a plain link never jumps', !intent(r.asked));
  await b.close();
  const failed = results.filter(x => !x).length;
  console.log(`${results.length - failed}/${results.length} QR link checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
