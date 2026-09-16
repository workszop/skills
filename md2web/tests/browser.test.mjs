import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { buildHtml, sourceVersion } from '../scripts/build.mjs';

// Chrome's crashpad helper can outlive the main process and keep writing into the profile,
// so a recursive rm may hit ENOTEMPTY; keep trying until it is really gone.
async function removeDirEventually(dir, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch (e) { if (Date.now() > deadline) throw e; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
}

// Chrome's private CDP pipe avoids WebSocket dependencies and shared debug ports.
async function startBrowser(profile) {
  const chrome = spawn(process.env.MD2WEB_CHROME || 'google-chrome', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-pipe', '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let seq = 0, buffer = '', stderr = '', failed = null;
  const pending = new Map();
  const pageErrors = [];
  chrome.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  function fail(error) {
    failed = error;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  }
  chrome.on('error', fail);
  chrome.on('exit', code => fail(new Error('Chrome exited: ' + code + '\n' + stderr)));
  chrome.stdio[3].on('error', fail);
  chrome.stdio[4].on('error', fail);
  chrome.stdio[4].setEncoding('utf8');
  chrome.stdio[4].on('end', () => fail(new Error('CDP pipe closed\n' + stderr)));
  chrome.stdio[4].on('data', chunk => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (['Inspector.detached', 'Inspector.targetCrashed', 'Target.targetCrashed'].includes(message.method)) {
        fail(new Error(message.method));
      }
      if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails);
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    }
  });
  function call(method, params = {}, sessionId) {
    if (failed) return Promise.reject(failed);
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 8000);
      pending.set(id, { resolve, reject, timer });
      chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }
  async function close() {
    fail(new Error('Test cleanup'));
    if (!chrome.pid || chrome.exitCode !== null || chrome.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => chrome.kill('SIGKILL'), 2000);
      chrome.once('exit', () => { clearTimeout(timer); resolve(); });
      chrome.kill('SIGTERM');
    });
  }
  return { call, close, pageErrors };
}

test('browser regressions', { timeout: 60000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'md2web-browser-test-'));
  const input = join(dir, 'fixture.md');
  writeFileSync(input, '# Fixture\n\n## One\n\n## Two\n\n## Three\n');
  const html = buildHtml(input);
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
  let browser;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    browser = await startBrowser(join(dir, 'profile'));
    const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.call('Target.attachToTarget', { targetId, flatten: true });
    const call = (method, params) => browser.call(method, params, sessionId);
    async function evaluate(expression) {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    await call('Runtime.enable');
    await call('Network.enable');
    await call('Network.setBlockedURLs', { urls: ['*fonts.googleapis.com*', '*fonts.gstatic.com*'] });
    await call('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
    async function waitReady() {
      const deadline = Date.now() + 8000;
      while (await evaluate('document.documentElement?.dataset.md2webReady') !== 'true') {
        assert.ok(Date.now() < deadline, 'App never became ready');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    async function reload() {
      await call('Page.reload');
      await new Promise(resolve => setTimeout(resolve, 100));
      await waitReady();
    }
    const frames = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await waitReady();
    async function edit(source, flush = true) {
      await evaluate(`(() => {
        if (document.documentElement.dataset.md2webEditor !== 'on') {
          document.querySelector('#btn-format').click();
          document.querySelector('[data-format=editor][data-value=on]').click();
          document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}));
        }
        const editor = document.querySelector('#editor-text');
        editor.value = ${JSON.stringify(source)};
        editor.dispatchEvent(new Event('input'));
        ${flush ? "document.querySelector('#btn-editor-close').click();" : ''}
      })()`);
    }

    await t.test('closed formatting popover cannot receive focus', async () => {
      assert.equal(await evaluate(`(() => { const b = document.querySelector('[data-format=accent]'); b.focus(); return document.activeElement === b; })()`), false);
      await evaluate(`document.querySelector('#btn-format').click()`);
      assert.equal(await evaluate(`(() => { const b = document.querySelector('[data-format=accent]'); b.focus(); return document.activeElement === b; })()`), true);
      await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))`);
      assert.equal(await evaluate('document.activeElement.id'), 'btn-format');
      assert.equal(await evaluate(`document.querySelector('#format-popover').getAttribute('aria-hidden')`), 'true');
    });
    await t.test('document styles cannot hide controls or create fixed overlays', async () => {
      await edit('<p>Safe text</p><style>#btn-open {display:none!important}</style><div style="position:fixed;inset:0;z-index:99999">Overlay</div>');
      assert.deepEqual(await evaluate(`({styles:document.querySelectorAll('#article-body style, #article-body [style]').length, hidden:getComputedStyle(document.querySelector('#btn-open')).display === 'none'})`), { styles: 0, hidden: false });
    });
    await t.test('GFM table alignment survives CSS sanitization', async () => {
      await edit('| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |');
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('#article-body th, #article-body td')].map(c => getComputedStyle(c).textAlign)`), ['left', 'center', 'right', 'left', 'center', 'right']);
    });
    await t.test('HTML headings get unique IDs without shell or Markdown collisions', async () => {
      await edit('<h1>Title</h1>\n<h2>One</h2>\n<h2 id="one">Duplicate</h2>\n\n## One\n\n<h3 id="editor">Shell</h3>\n<h4>Fourth</h4>\n<h5>Fifth</h5>\n<h6>Sixth</h6>');
      const result = await evaluate(`({ids:[...document.querySelectorAll('#article-body :is(h1,h2,h3,h4,h5,h6)')].map(h=>h.id),links:[...document.querySelectorAll('#toc-list a')].map(a=>({href:a.getAttribute('href'),target:!!document.getElementById(decodeURIComponent(a.hash.slice(1)))})),editorCount:document.querySelectorAll('#editor').length})`);
      assert.ok(result.ids.every(Boolean));
      assert.equal(new Set(result.ids).size, result.ids.length);
      assert.equal(result.editorCount, 1);
      assert.ok(result.links.every(link => link.href !== '#' && link.target));
    });
    await t.test('unusual raw heading IDs work in scroll-spy selectors', async () => {
      await edit('<h2 id=\'a"b\'>Quoted</h2>\n<h2 id="two">Two</h2>\n<h2 id="three">Three</h2>');
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      assert.deepEqual(browser.pageErrors, []);
    });
    await t.test('raw HTML and Markdown source anchors include front matter offsets', async () => {
      await edit('---\ntitle: Lines\n---\n\n<div>\n<h2>Raw one</h2>\n\n<h3>Raw two</h3>\n</div>\n\n## Final');
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('#article-body [data-line]')].map(h=>Number(h.dataset.line))`), [5, 7, 10]);
    });
    await t.test('ToC fragments preserve literal percent and hash characters in raw IDs', async () => {
      await edit('<h2 id="literal%20space">Percent</h2>\n<h2 id="hash#part">Hash</h2>\n<h2 id="third">Third</h2>');
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('#toc-list a')].map(a=>document.getElementById(decodeURIComponent(a.hash.slice(1)))?.textContent)`), ['Percent', 'Hash', 'Third']);
    });
    await t.test('new IDs do not displace existing unique Markdown anchors', async () => {
      await edit('---\ntitle: Existing\n---\n\n<h2>Existing</h2>\n\n## Existing\n\n## Second\n\n## Third');
      assert.equal(await evaluate(`document.querySelector('#article-body h2.md-h2').id`), 'existing');
      assert.equal(await evaluate(`document.querySelectorAll('#existing').length`), 1);
    });
    await t.test('PDF button flushes pending editor text before invoking print', async () => {
      await edit('# Before print');
      await edit('# Latest button edit', false);
      const printed = await evaluate(`(() => {const original=window.print; let text; window.print=()=>{text=document.querySelector('#article-body').textContent}; try {document.querySelector('#btn-pdf').click(); return text;} finally {window.print=original}})()`);
      assert.match(printed, /Latest button edit/);
    });
    await t.test('browser beforeprint flushes pending editor text', async () => {
      await edit('# Latest browser edit', false);
      assert.match(await evaluate(`(() => {window.dispatchEvent(new Event('beforeprint')); return document.querySelector('#article-body').textContent})()`), /Latest browser edit/);
    });
    await t.test('native Chrome print generates a PDF with the current document rendered', async () => {
      await edit('# Native print smoke test', false);
      const { data } = await call('Page.printToPDF', { preferCSSPageSize: true, printBackground: true });
      assert.equal(Buffer.from(data, 'base64').subarray(0, 5).toString(), '%PDF-');
      assert.match(await evaluate(`document.querySelector('#article-body').textContent`), /Native print smoke test/);
    });
    await t.test('the Contents panel can be hidden and the choice survives a reload', async () => {
      await edit('## One\n\n## Two\n\n## Three');
      assert.equal(await evaluate('document.documentElement.dataset.md2webSidebar'), 'on');
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('#btn-drawer')).display !== 'none'`), true);
      await evaluate(`document.querySelector('#btn-sidebar-close').click()`);
      assert.deepEqual(await evaluate(`({state:document.documentElement.dataset.md2webSidebar, hidden:document.querySelector('#sidebar').hidden, side:document.querySelector('#layout').classList.contains('layout--side'), toggle:getComputedStyle(document.querySelector('#btn-drawer')).display !== 'none', expanded:document.querySelector('#btn-drawer').getAttribute('aria-expanded')})`),
        { state: 'off', hidden: true, side: false, toggle: true, expanded: 'false' });
      await reload();
      assert.equal(await evaluate('document.documentElement.dataset.md2webSidebar'), 'off');
      await evaluate(`document.querySelector('#btn-drawer').click()`);
      assert.deepEqual(await evaluate(`({state:document.documentElement.dataset.md2webSidebar, side:document.querySelector('#layout').classList.contains('layout--side'), expanded:document.querySelector('#btn-drawer').getAttribute('aria-expanded')})`),
        { state: 'on', side: true, expanded: 'true' });
      // A document without a ToC has no panel to show, so the toggle disappears
      await edit('# Solo');
      assert.deepEqual(await evaluate(`({state:document.documentElement.dataset.md2webSidebar, toggle:document.querySelector('#btn-drawer').hidden})`), { state: 'off', toggle: true });
    });
    await t.test('the editor wraps long lines by default and the toggle persists', async () => {
      await edit('# Wrap', false);
      assert.deepEqual(await evaluate(`({ws:getComputedStyle(document.querySelector('#editor-text')).whiteSpace, pressed:document.querySelector('#btn-editor-wrap').getAttribute('aria-pressed')})`), { ws: 'pre-wrap', pressed: 'true' });
      await evaluate(`document.querySelector('#btn-editor-wrap').click()`);
      assert.deepEqual(await evaluate(`({ws:getComputedStyle(document.querySelector('#editor-text')).whiteSpace, pressed:document.querySelector('#btn-editor-wrap').getAttribute('aria-pressed'), saved:localStorage.getItem('md2web-editor-wrap')})`), { ws: 'pre', pressed: 'false', saved: 'off' });
      await reload();
      assert.deepEqual(await evaluate(`({ws:getComputedStyle(document.querySelector('#editor-text')).whiteSpace, pressed:document.querySelector('#btn-editor-wrap').getAttribute('aria-pressed')})`), { ws: 'pre', pressed: 'false' });
      await evaluate(`document.querySelector('#btn-editor-wrap').click()`);
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('#editor-text')).whiteSpace`), 'pre-wrap');
    });
    await t.test('scroll sync follows source lines, not visual lines, when the editor wraps', async () => {
      const long = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '.repeat(120).trim();
      await edit('# Head\n\n' + long + '\n\n## Target\n\n' + long + '\n\n' + long + '\n\n' + long, false);
      await new Promise(resolve => setTimeout(resolve, 250));  // editor debounce
      await frames();
      // 2000 px down is still inside the first wrapped paragraph (source line 2); the
      // old one-line-per-row arithmetic would read it as line 90+ and jump to the end.
      await evaluate(`(() => { const e = document.querySelector('#editor-text'); e.scrollTop = 2000; e.dispatchEvent(new Event('scroll')); })()`);
      await new Promise(resolve => setTimeout(resolve, 60));
      await frames();
      const topbarH = await evaluate(`parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h'))`);
      const targetTop = await evaluate(`document.getElementById('target').getBoundingClientRect().top`);
      assert.ok(targetTop > topbarH, 'Target heading scrolled above the top bar: ' + targetTop);
      // Scrolling exactly to the heading's wrapped position lands it just under the top bar.
      await evaluate(`(() => { const e = document.querySelector('#editor-text'); e.scrollTop = document.querySelector('#editor-mirror').children[4].offsetTop - parseFloat(getComputedStyle(e).paddingTop); e.dispatchEvent(new Event('scroll')); })()`);
      await new Promise(resolve => setTimeout(resolve, 60));
      await frames();
      const landed = await evaluate(`document.getElementById('target').getBoundingClientRect().top - parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h'))`);
      assert.ok(landed >= 0 && landed < 60, 'Target landed at ' + landed);
    });
    await t.test('original Markdown formatting and mobile layout still work', async () => {
      await edit('## Ćwiczenia\n\n## Ćwiczenia\n\n## Third\n\n- [x] Done\n\n```js\nconst x = 1;\n```');
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('#article-body h2')].map(h=>h.id)`), ['ćwiczenia', 'ćwiczenia-2', 'third']);
      assert.equal(await evaluate(`document.querySelectorAll('.task-item--checked, code.hljs').length`), 2);
      await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    });
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    await removeDirEventually(dir);
  }
});

// Live reload: a page built with --watch polls its .ver.js sidecar and reloads itself
// when the version changes, unless the reader has unsaved in-page edits. Runs over
// file:// like the desktop app, where fetch() is blocked and only <script> can poll.
test('live reload follows the sidecar version', { timeout: 60000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'md2web-live-test-'));
  const input = join(dir, 'doc.md');
  const long = n => '# ' + n + '\n\n' + Array.from({ length: 80 }, (_, i) => 'Paragraph ' + i + ' of ' + n + '.').join('\n\n') + '\n';
  function publish(source) {
    writeFileSync(input, source);
    writeFileSync(join(dir, 'doc.html'), buildHtml(input, {}, { watchSidecar: 'doc.html.ver.js' }));
    writeFileSync(join(dir, 'doc.html.ver.js'), 'window.__md2webVersion = ' + JSON.stringify(sourceVersion(source)) + ';\n');
  }
  publish(long('First'));
  let browser;
  try {
    browser = await startBrowser(join(dir, 'profile'));
    const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.call('Target.attachToTarget', { targetId, flatten: true });
    const call = (method, params) => browser.call(method, params, sessionId);
    async function evaluate(expression) {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    async function until(expression, what, ms = 8000) {
      const deadline = Date.now() + ms;
      for (;;) {
        let value = null;
        try { value = await evaluate(expression); } catch (e) { /* mid-navigation */ }
        if (value === true) return;
        assert.ok(Date.now() < deadline, 'timed out waiting for ' + what);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    await call('Runtime.enable');
    await call('Network.enable');
    await call('Network.setBlockedURLs', { urls: ['*fonts.googleapis.com*', '*fonts.gstatic.com*'] });
    await call('Page.navigate', { url: pathToFileURL(join(dir, 'doc.html')).href });
    await until(`document.documentElement?.dataset.md2webReady === 'true'`, 'app ready');

    await t.test('the page advertises live mode through the DOM contract', async () => {
      assert.equal(await evaluate('document.documentElement.dataset.md2webLive'), 'on');
    });
    await t.test('a new sidecar version reloads the page and keeps the scroll position', async () => {
      await evaluate('window.scrollTo(0, 600)');
      await new Promise(resolve => setTimeout(resolve, 100));
      publish(long('Second'));
      await until(`document.documentElement?.dataset.md2webReady === 'true' && document.querySelector('#article-body h1')?.textContent === 'Second'`, 'reload after change');
      const y = await evaluate('window.scrollY');
      assert.ok(Math.abs(y - 600) < 40, 'scroll restored, got ' + y);
    });
    await t.test('unsaved in-page edits block auto reload and offer it in a toast', async () => {
      await evaluate(`(() => {
        document.querySelector('#btn-format').click();
        document.querySelector('[data-format=editor][data-value=on]').click();
        document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}));
        const editor = document.querySelector('#editor-text');
        editor.value = '# Mine\\n\\nunsaved';
        editor.dispatchEvent(new Event('input'));
        document.querySelector('#btn-editor-close').click();
      })()`);
      assert.equal(await evaluate(`document.querySelector('#article-body h1').textContent`), 'Mine');
      publish(long('Third'));
      await until(`document.querySelector('#toast').classList.contains('toast--visible')`, 'toast');
      await new Promise(resolve => setTimeout(resolve, 1500));
      assert.deepEqual(await evaluate(`({h1:document.querySelector('#article-body h1').textContent, text:document.querySelector('#toast-text').textContent, action:document.querySelector('#toast-action').textContent})`),
        { h1: 'Mine', text: 'File changed on disk. Reload discards your edits', action: 'Reload' });
      await evaluate(`document.querySelector('#toast-action').click()`);
      await until(`document.documentElement?.dataset.md2webReady === 'true' && document.querySelector('#article-body h1')?.textContent === 'Third'`, 'reload from toast');
    });
    assert.deepEqual(browser.pageErrors, []);
  } finally {
    if (browser) await browser.close();
    await removeDirEventually(dir);
  }
});
