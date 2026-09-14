import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'scripts', 'build.mjs');
const NODE = process.execPath;

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'md2web-build-test-'));
}

function runBuild(args, options = {}) {
  return spawnSync(NODE, [BUILD, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20_000,
    ...options,
  });
}

function readConfig(htmlPath) {
  const html = readFileSync(htmlPath, 'utf8');
  const match = html.match(/<script>window\.MD2WEB = (.*?)<\/script>/s);
  assert.ok(match, 'built page should contain the MD2WEB config');
  return JSON.parse(match[1].replace(/;$/, ''));
}

function writeExecutable(filePath, source) {
  writeFileSync(filePath, source);
  chmodSync(filePath, 0o755);
}

test('CLI accepts every documented enum value and bakes it into the page defaults', () => {
  const tempDir = makeTempDir();
  try {
    const input = join(tempDir, 'notes.md');
    writeFileSync(input, '# Notes\n\nBuild test.\n');
    const cases = [
      ['accent', ['blue', 'indigo', 'violet', 'pink', 'emerald', 'amber', 'ink'], 'accent'],
      ['font', ['raleway', 'inter', 'poppins', 'lato'], 'font'],
      ['size', ['sm', 'md', 'lg'], 'scale'],
      ['spacing', ['compact', 'normal', 'relaxed'], 'leading'],
      ['measure', ['narrow', 'default', 'wide'], 'measure'],
      ['theme', ['light', 'sepia', 'dark', 'auto'], 'theme'],
    ];

    for (const [flag, values, configKey] of cases) {
      for (const value of values) {
        const output = join(tempDir, `${flag}-${value}.html`);
        const result = runBuild([input, '--out', output, `--${flag}`, value, '--quiet']);
        assert.equal(result.status, 0, `${flag}=${value}: ${result.stderr}`);
        assert.equal(result.error, undefined, `${flag}=${value} should start the CLI`);
        assert.equal(readConfig(output).defaults[configKey], value, `${flag}=${value}`);
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI PDF export preserves the requested output path and keeps Chrome sandboxing enabled', () => {
  const tempDir = makeTempDir();
  try {
    const input = join(tempDir, 'notes.md');
    const htmlPath = join(tempDir, 'rendered.html');
    const pdfPath = join(tempDir, 'exports', 'notes.pdf');
    const argsPath = join(tempDir, 'chrome-args.json');
    const fakeChrome = join(tempDir, 'fake-chrome');
    writeFileSync(input, '# Notes\n');
    writeExecutable(fakeChrome, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.MD2WEB_FAKE_CHROME_ARGS, JSON.stringify(args));
if (args.includes('--version')) process.exit(0);
const output = args.find((arg) => arg.startsWith('--print-to-pdf='));
if (!output) process.exit(2);
fs.mkdirSync(require('node:path').dirname(output.slice('--print-to-pdf='.length)), { recursive: true });
fs.writeFileSync(output.slice('--print-to-pdf='.length), '%PDF-1.4 fake\\n');
`);

    const result = runBuild([
      input,
      '--out', htmlPath,
      '--pdf', pdfPath,
      '--chrome', fakeChrome,
      '--quiet',
    ], { env: { ...process.env, MD2WEB_FAKE_CHROME_ARGS: argsPath } });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.error, undefined);
    assert.equal(existsSync(htmlPath), true);
    assert.equal(existsSync(pdfPath), true);
    assert.equal(readFileSync(pdfPath, 'utf8'), '%PDF-1.4 fake\n');
    const chromeArgs = JSON.parse(readFileSync(argsPath, 'utf8'));
    assert.equal(chromeArgs.includes('--no-sandbox'), false);
    assert.ok(chromeArgs.some((arg) => arg === `--print-to-pdf=${resolve(pdfPath)}`));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI bounds a hanging explicit Chrome --version probe', () => {
  const tempDir = makeTempDir();
  try {
    const input = join(tempDir, 'notes.md');
    const pdfPath = join(tempDir, 'notes.pdf');
    const fakeChrome = join(tempDir, 'hanging-chrome');
    writeFileSync(input, '# Notes\n');
    writeExecutable(fakeChrome, `#!/usr/bin/env node
setTimeout(() => {}, 6000);
`);

    const startedAt = Date.now();
    const result = runBuild([
      input,
      '--pdf', pdfPath,
      '--chrome', fakeChrome,
      '--quiet',
    ], { timeout: 8_000, killSignal: 'SIGKILL' });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.error, undefined, 'the CLI process should not hit the outer test timeout');
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /no Chrome\/Chromium found/);
    assert.ok(elapsedMs < 5_000, `Chrome discovery should be bounded (took ${elapsedMs} ms)`);
    assert.equal(existsSync(pdfPath), false, 'a failed probe must not create a PDF');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
