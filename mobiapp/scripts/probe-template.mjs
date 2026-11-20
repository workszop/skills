// Browser probe template for a phone-first app: desktop mouse + phone touch, fake API, state checks.
// Copy to a scratch folder, adapt the CHECKS section, run: node probe.mjs http://localhost:8791/
// PLAYWRIGHT=/abs/path/to/playwright/index.mjs uses a Playwright installed elsewhere; CHROME= picks the browser binary.
// Never point it at production with writes: the API is faked below, so nothing reaches the live server.
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';

const base = process.argv[2] || 'http://localhost:8791/';
const API_RE = /workers\.dev|\/api\//;           // every API call the app makes
const b = await chromium.launch({ ...(CHROME ? { executablePath: CHROME } : {}), args: ['--no-sandbox'] });
const errs = [], sent = [];
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };

const DESKTOP = { viewport: { width: 1280, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 };

async function open(ctxOpts, url) {
  const ctx = await b.newContext(ctxOpts);
  await ctx.route(API_RE, async r => {             // fake API: answer by path, record what the app sent
    const u = new URL(r.request().url()), body = r.request().postData();
    sent.push({ method: r.request().method(), path: u.pathname, body: body ? JSON.parse(body) : null });
    const json = (status, o) => r.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(o) });
    if (u.pathname.endsWith('/event')) return json(200, { names: 'Test Event', dateLine: 'x', guests: 3, photo: 0 });
    return json(200, {});
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(base + url); await page.waitForTimeout(800);
  return { ctx, page, touch: !!ctxOpts.hasTouch };
}

const tap = (p, x, y) => p.touch ? p.page.touchscreen.tap(x, y) : p.page.mouse.click(x, y);

async function pinch(p, cx, cy, from = 30, to = 130) {   // two fingers moving apart through CDP
  const cdp = await p.ctx.newCDPSession(p.page);
  const pts = d => [{ x: cx - d, y: cy, id: 0 }, { x: cx + d, y: cy, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(from) });
  for (let d = from; d <= to; d += 12) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d) }); await p.page.waitForTimeout(16); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

// ─── CHECKS: run every UI check in both contexts ───
for (const opts of [DESKTOP, PHONE]) {
  const p = await open(opts, 'index.html');
  const label = p.touch ? 'phone' : 'desktop';
  // Example: tapping an item opens its sheet and it stays open (catches the pointerup -> scrim click trap)
  // const [x, y] = await p.page.evaluate(() => { const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  // await tap(p, x, y); await p.page.waitForTimeout(400);
  // ok(await p.page.evaluate(() => document.querySelector('#sheet').classList.contains('open')), label + ': sheet opens and stays open');
  ok(true, label + ': page loaded');
  await p.ctx.close();
}

ok(!errs.length, 'no page errors ' + errs.join(' | '));
await b.close();
process.exit(failed ? 1 : 0);
