import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'scripts', 'build.mjs');
const NODE = process.execPath;

function readConfig(htmlPath) {
  const match = readFileSync(htmlPath, 'utf8').match(/<script>window\.MD2WEB = (.*?)<\/script>/s);
  assert.ok(match, 'built page should contain the MD2WEB config');
  return JSON.parse(match[1].replace(/;$/, ''));
}

function sidecarVersion(path) {
  const match = readFileSync(path, 'utf8').match(/window\.__md2webVersion\s*=\s*"([^"]+)"/);
  assert.ok(match, 'sidecar should assign window.__md2webVersion');
  return match[1];
}

async function until(fn, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!fn()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for ' + what);
    await new Promise(r => setTimeout(r, 50));
  }
}

function startWatcher(args) {
  const child = spawn(NODE, [BUILD, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', c => { stderr += c; });
  const exited = new Promise(r => child.once('exit', code => r({ code, stderr })));
  return { child, exited };
}

test('--watch rebuilds the page and its version sidecar when the source changes', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'md2web-watch-test-'));
  const input = join(dir, 'notes.md');
  const out = join(dir, 'out', 'notes-1234abcd.html');
  const sidecar = out + '.ver.js';
  writeFileSync(input, '# One\n');
  const { child, exited } = startWatcher([input, '--out', out, '--quiet', '--watch', '--watch-poll', '100']);
  try {
    await until(() => existsSync(sidecar), 'first build');
    const first = readConfig(out);
    assert.equal(first.source, '# One\n');
    assert.equal(first.watch.sidecar, 'notes-1234abcd.html.ver.js', 'page knows its sidecar by relative name');
    assert.equal(sidecarVersion(sidecar), first.watch.version, 'sidecar and page agree on the version');

    writeFileSync(input, '# Two\n');
    await until(() => sidecarVersion(sidecar) !== first.watch.version, 'rebuild after edit');
    const second = readConfig(out);
    assert.equal(second.source, '# Two\n');
    assert.equal(sidecarVersion(sidecar), second.watch.version);
    assert.notEqual(second.watch.version, first.watch.version);
    assert.equal(child.exitCode, null, 'watcher keeps running');
  } finally {
    child.kill('SIGTERM');
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--watch-owner exits once no process with that command line is alive', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'md2web-watch-test-'));
  const input = join(dir, 'notes.md');
  const out = join(dir, 'notes.html');
  writeFileSync(input, '# One\n');
  const { child, exited } = startWatcher([input, '--out', out, '--quiet', '--watch', '--watch-poll', '100',
    '--watch-owner', 'md2web-no-such-owner-' + process.pid]);
  try {
    const startedAt = Date.now();
    const { code } = await exited;
    assert.equal(code, 0);
    assert.ok(Date.now() - startedAt < 8000, 'exits promptly when the owner is gone');
    assert.ok(existsSync(out), 'still builds once before leaving');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without --watch the page carries no watch config and no sidecar is written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'md2web-watch-test-'));
  try {
    const input = join(dir, 'notes.md');
    const out = join(dir, 'notes.html');
    writeFileSync(input, '# One\n');
    const r = spawnSync(NODE, [BUILD, input, '--out', out, '--quiet'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readConfig(out).watch, undefined);
    assert.equal(existsSync(out + '.ver.js'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
