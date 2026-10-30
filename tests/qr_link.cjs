// The links in the QR codes: ?p=android reopens the game in Chrome from other Android browsers,
// and in Chrome (or on Windows) the tag just disappears from the address.
// usage: node tests/qr_link.cjs <url>
const { chromium } = require('playwright');
const url = process.argv[2] || 'http://127.0.0.1:8099/';
const UA = {
  chrome: 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36',
  firefox: 'Mozilla/5.0 (Android 14; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0',
  webview: 'Mozilla/5.0 (Linux; Android 14; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/155.0.0.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0',
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
  let r = await visit(UA.samsung, '?p=android');
  check('Samsung Internet: reopens in Chrome', !!intent(r.asked) && /package=com\.android\.chrome/.test(intent(r.asked)) && /S\.browser_fallback_url=http/.test(intent(r.asked)), intent(r.asked) || r.asked.join(' '));
  r = await visit(UA.firefox, '?p=android');
  check('Firefox on Android: reopens in Chrome', !!intent(r.asked));
  r = await visit(UA.chrome, '?p=android&reset');
  check('Chrome on Android: stays, tag dropped, other options kept', !intent(r.asked) && r.now.endsWith('/?reset'), r.now);
  r = await visit(UA.webview, '?p=android');
  check('in-app browser: stays (no broken jump)', !intent(r.asked) && !r.now.includes('p=android'), r.now);
  r = await visit(UA.windows, '?p=windows');
  check('Windows: stays, tag dropped', !intent(r.asked) && /\/$/.test(r.now), r.now);
  r = await visit(UA.samsung, '');
  check('a plain link never jumps', !intent(r.asked));
  await b.close();
  const failed = results.filter(x => !x).length;
  console.log(`${results.length - failed}/${results.length} QR link checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
