import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OPEN = join(ROOT, 'scripts', 'md2web-open');

async function until(fn, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!fn()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for ' + what);
    await new Promise(r => setTimeout(r, 50));
  }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
const version = p => readFileSync(p, 'utf8').match(/"([^"]+)"/)[1];

test('md2web-open starts one live watcher per file and reuses it on reopen', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'md2web-launcher-test-'));
  const bin = join(dir, 'bin'), cache = join(dir, 'cache');
  mkdirSync(bin);
  // Fake Chrome: record its arguments, then linger so the watcher's owner check sees a live profile
  writeFileSync(join(bin, 'google-chrome'), '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "' + join(dir, 'chrome-args') + '"\nsleep 20\n');
  chmodSync(join(bin, 'google-chrome'), 0o755);
  const input = join(dir, 'notes.md');
  writeFileSync(input, '# One\n');
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, XDG_CACHE_HOME: cache, MD2WEB_NODE: process.execPath, MD2WEB_WATCH_POLL: '100' };
  const run = () => spawnSync('bash', [OPEN, input], { env, encoding: 'utf8', timeout: 15000 });
  let pid = 0;
  try {
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    await until(() => existsSync(join(dir, 'chrome-args')), 'Chrome launch');
    const built = readFileSync(join(dir, 'chrome-args'), 'utf8').match(/--app=file:\/\/.*open\.html#(notes-[0-9a-f]{8}\.html)/);
    assert.ok(built, 'Chrome opened the stub for the built page');
    const out = join(cache, 'md2web', built[1]);
    const sidecar = out + '.ver.js';
    await until(() => existsSync(sidecar), 'watcher sidecar');
    const pidFile = join(cache, 'md2web', built[1].replace(/\.html$/, '.watch.pid'));
    assert.ok(existsSync(pidFile), 'pid file next to the build');
    pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(alive(pid), 'watcher process is running');
    const v1 = version(sidecar);

    writeFileSync(input, '# Two\n');
    await until(() => version(sidecar) !== v1, 'rebuild after edit');
    assert.match(readFileSync(out, 'utf8'), /# Two/);

    const second = run();
    assert.equal(second.status, 0, second.stderr);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(Number(readFileSync(pidFile, 'utf8')), pid, 'reopening reuses the running watcher');
    assert.ok(alive(pid));
  } finally {
    if (pid) try { process.kill(pid, 'SIGTERM'); } catch (e) { /* already gone */ }
    spawnSync('pkill', ['-f', '[s]leep 20'], { stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
  }
});
