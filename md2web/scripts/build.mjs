#!/usr/bin/env node
/**
 * md2web build — turn a Markdown file into a single self-contained md2web page,
 * optionally rendering it to an A4 PDF with headless Chrome.
 *
 *   node build.mjs input.md [--out page.html] [--pdf [file.pdf]]
 *                  [--accent blue|indigo|violet|pink|emerald|amber|ink|#RRGGBB]
 *                  [--font raleway|inter|poppins|lato] [--size sm|md|lg]
 *                  [--spacing compact|normal|relaxed] [--measure narrow|default|wide]
 *                  [--theme light|sepia|dark|auto] [--chrome /path/to/chrome] [--quiet]
 *
 * Output: the full md2web app (Open / Format / Export PDF still work) with
 * tokens.css, md-styles.css and app.js inlined and the Markdown embedded as
 * window.MD2WEB.source. marked, DOMPurify and highlight.js are inlined from
 * app/vendor/, and local images referenced by the Markdown are embedded as
 * data URIs, so the page renders offline; only Google Fonts still need network.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

// ─── Constants ───
const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const ACCENTS = ['blue', 'indigo', 'violet', 'pink', 'emerald', 'amber', 'ink'];
const OPTIONS = {
  font:    ['raleway', 'inter', 'poppins', 'lato'],
  size:    ['sm', 'md', 'lg'],
  spacing: ['compact', 'normal', 'relaxed'],
  measure: ['narrow', 'default', 'wide'],
  theme:   ['light', 'sepia', 'dark', 'auto'],
};
const FLAG_TO_KEY = { size: 'scale', spacing: 'leading' };
const MD_EXT_RE = /\.(md|markdown|txt)$/i;
// Local images to inline: Markdown ![..](path) and raw <img src="path">, local paths only
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp' };
const IMAGE_REFS = [/!\[[^\]]*\]\(\s*<?([^\s)>]+)>?/g, /<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// [substring of the CDN <script src>, vendored file]; each tag is replaced in place
const VENDOR_LIBS = [['highlight.js/', 'highlight.min.js'], ['marked@', 'marked.umd.js'], ['dompurify@', 'purify.min.js']];
const CHROME_CANDIDATES = [
  process.env.MD2WEB_CHROME, process.env.CHROME_PATH,
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome', 'brave-browser',
].filter(Boolean);
const CHROME_PROBE_TIMEOUT_MS = 2000;

// ─── CLI parsing ───
function usage(msg) {
  if (msg) console.error('md2web: ' + msg + '\n');
  console.error(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 12).join('\n').replace(/^ \*\/?\s?/gm, ''));
  process.exit(msg ? 2 : 0);
}

function parseArgs(argv) {
  const args = { defaults: {}, pdf: false, pdfPath: null, out: null, chrome: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) usage('missing value for ' + a); return v; };
    if (a === '-h' || a === '--help') usage();
    else if (a === '--out' || a === '-o') args.out = next();
    // `--pdf notes.md` means "input after the flag", not a PDF path: only a *.pdf value is taken
    else if (a === '--pdf') { args.pdf = true; if (argv[i + 1] && /\.pdf$/i.test(argv[i + 1])) args.pdfPath = argv[++i]; }
    else if (a === '--chrome') args.chrome = next();
    else if (a === '--quiet' || a === '-q') args.quiet = true;
    else if (a === '--accent') {
      const v = next().toLowerCase();
      if (ACCENTS.includes(v)) args.defaults.accent = v;
      else if (/^#[0-9a-f]{6}$/.test(v)) { args.defaults.accent = 'custom'; args.defaults.accentCustom = v.toUpperCase(); }
      else usage('--accent must be one of ' + ACCENTS.join('|') + ' or #RRGGBB');
    }
    else if (a.startsWith('--') && OPTIONS[a.slice(2)]) {
      const flag = a.slice(2), v = next().toLowerCase();
      if (!OPTIONS[flag].includes(v)) usage('--' + flag + ' must be one of ' + OPTIONS[flag].join('|'));
      args.defaults[FLAG_TO_KEY[flag] || flag] = v;
    }
    else if (a.startsWith('-')) usage('unknown option ' + a);
    else if (!args.input) args.input = a;
    else usage('unexpected argument ' + a);
  }
  if (!args.input) usage('input .md file required');
  return args;
}

// ─── Helpers ───
function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'document';
}

// A JSON string inside a <script> must not contain "</script" or "<!--".
function jsonForScript(value) {
  return JSON.stringify(value).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
}

function replaceOnce(html, needle, replacement, what) {
  if (!html.includes(needle)) throw new Error('build: app/index.html is missing ' + what + ' (' + needle.slice(0, 40) + ')');
  return html.replace(needle, () => replacement);
}

// Map of every local image the Markdown references -> data URI (missing files are left alone,
// so a broken link still shows as broken instead of failing the build).
function collectAssets(md, baseDir, warn) {
  const assets = {};
  for (const re of IMAGE_REFS) {
    for (const m of md.matchAll(re)) {
      const ref = m[1];
      if (assets[ref] || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('#') || ref.startsWith('//')) continue;
      let file;
      try { file = resolve(baseDir, decodeURIComponent(ref.split(/[?#]/)[0])); } catch (e) { continue; }
      const mime = IMAGE_MIME[extname(file).slice(1).toLowerCase()];
      if (!mime || !existsSync(file) || !statSync(file).isFile()) continue;
      const size = statSync(file).size;
      if (size > MAX_IMAGE_BYTES) { warn('skipping ' + ref + ' (' + Math.round(size / 1048576) + ' MB, over the inline limit)'); continue; }
      assets[ref] = 'data:' + mime + ';base64,' + readFileSync(file).toString('base64');
    }
  }
  return assets;
}

function sri(text) {
  return 'sha384-' + createHash('sha384').update(text).digest('base64');
}

function findChrome(explicit) {
  const candidates = explicit ? [explicit] : CHROME_CANDIDATES;
  for (const c of candidates) {
    const probe = spawnSync(c, ['--version'], {
      encoding: 'utf8',
      timeout: CHROME_PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      stdio: 'ignore',
    });
    if (probe.status === 0) return c;
  }
  return null;
}

// ─── Build ───
export function buildHtml(mdPath, defaults = {}, { warn = msg => console.error('md2web: ' + msg) } = {}) {
  const raw    = readFileSync(mdPath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const name   = basename(mdPath);
  const shell  = readFileSync(join(APP_DIR, 'index.html'), 'utf8');
  const tokens = readFileSync(join(APP_DIR, 'tokens.css'), 'utf8');
  const styles = readFileSync(join(APP_DIR, 'md-styles.css'), 'utf8');
  const appJs  = readFileSync(join(APP_DIR, 'app.js'), 'utf8');
  const vendor = name => readFileSync(join(APP_DIR, 'vendor', name), 'utf8');

  // @import must be the first rule in a stylesheet, so keep tokens.css first
  // and hoist its @import above everything else in the inlined <style>.
  const IMPORT_RE = /^@import\s+url\([^)]*\)[^;\n]*;/gm;
  const imports = tokens.match(IMPORT_RE) || [];
  const css = imports.join('\n') + '\n' + tokens.replace(IMPORT_RE, '') + '\n' + styles;

  const config = {
    name,
    storageKey: 'md2web-format:' + slug(name.replace(MD_EXT_RE, '')),
    defaults,
    modified: Math.round(statSync(mdPath).mtimeMs),  // shown in the top bar as the file's last change
    assets: collectAssets(raw, dirname(resolve(mdPath)), warn),
    source: raw,
  };

  let html = shell;
  const favicon = 'data:image/svg+xml;base64,' + readFileSync(join(APP_DIR, '..', 'assets', 'md2web.svg')).toString('base64');
  html = replaceOnce(html, '<title>md2web</title>', '<title>' + escapeHtml(name.replace(MD_EXT_RE, '')) + ' · md2web</title>\n  <link rel="icon" type="image/svg+xml" href="' + favicon + '" />', 'the <title>');
  html = replaceOnce(html, '<link rel="stylesheet" href="tokens.css" />\n  <link rel="stylesheet" href="md-styles.css" />',
    '<style>\n' + css + '\n  </style>', 'the stylesheet links');
  // Inline the vendored libraries (app/vendor/) so the built page needs no network
  // for scripts and works offline. Each vendored file must hash to the SRI value of
  // the CDN tag it replaces, so the dev app and the built page run identical code.
  // Inline scripts run in document order, so all three are defined before app.js.
  for (const [lib, file] of VENDOR_LIBS) {
    const tag = html.match(new RegExp('<script defer src="https://[^"]*' + lib.replace(/[.]/g, '\\.') + '[^"]*"[^>]*integrity="([^"]+)"[^>]*></script>'));
    if (!tag) throw new Error('build: app/index.html is missing the CDN <script> tag (with integrity) for ' + file);
    const js = vendor(file);
    if (sri(js) !== tag[1]) throw new Error('build: app/vendor/' + file + ' does not match the SRI hash in app/index.html - re-download the same version');
    html = html.replace(tag[0], () => '<script>' + js.replace(/<\/script/gi, '<\\/script') + '</script>');
  }
  html = replaceOnce(html, '<!-- MD2WEB_CONFIG -->',
    '<script>window.MD2WEB = ' + jsonForScript(config) + ';</script>', 'the MD2WEB_CONFIG marker');
  // Inline scripts are not deferred, so wait for the deferred CDN libraries
  // (they all run before DOMContentLoaded) before starting the app.
  html = replaceOnce(html, '<script defer src="app.js"></script>',
    '<script>\ndocument.addEventListener("DOMContentLoaded", function () {\n' +
    appJs.replace(/<\/script/gi, '<\\/script') + '\n});\n  </script>', 'the app.js script tag');
  return html;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function renderPdf(htmlPath, pdfPath, chromeBin) {
  const chrome = findChrome(chromeBin);
  if (!chrome) throw new Error('no Chrome/Chromium found; install google-chrome or pass --chrome /path/to/chrome');
  const profile = mkdtempSync(join(tmpdir(), 'md2web-chrome-'));
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--user-data-dir=' + profile,
    '--no-pdf-header-footer',
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=15000',
    '--print-to-pdf=' + resolve(pdfPath),
    pathToFileURL(resolve(htmlPath)).href,
  ];
  let res;
  try {
    res = spawnSync(chrome, args, { encoding: 'utf8', timeout: 120000 });
  } finally {
    rmSync(profile, { recursive: true, force: true });  // throwaway profile, never left in /tmp
  }
  if (res.status !== 0 || !existsSync(pdfPath)) {
    throw new Error('Chrome PDF export failed (exit ' + res.status + ')\n' + (res.stderr || '').slice(-2000));
  }
  return pdfPath;
}

// ─── Main ───
// realpath both sides: the skill is usually invoked through the ~/.claude/skills symlink.
// argv[1] may not be a file at all (stdin scripts, wrappers), in which case we are a library import.
function isMain() {
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); }
  catch (e) { return false; }
}
if (isMain()) {
  const args = parseArgs(process.argv.slice(2));
  const input = resolve(args.input);
  if (!existsSync(input)) usage('input not found: ' + input);

  const stem = basename(input, extname(input));
  const outHtml = resolve(args.out || join(dirname(input), stem + '.html'));
  mkdirSync(dirname(outHtml), { recursive: true });
  writeFileSync(outHtml, buildHtml(input, args.defaults));
  if (!args.quiet) console.log('html: ' + outHtml);

  if (args.pdf) {
    const outPdf = resolve(args.pdfPath || join(dirname(outHtml), stem + '.pdf'));
    mkdirSync(dirname(outPdf), { recursive: true });
    try {
      renderPdf(outHtml, outPdf, args.chrome);
      if (!args.quiet) console.log('pdf:  ' + outPdf);
    } catch (err) {
      console.error('md2web: ' + err.message);
      process.exit(1);
    }
  }
}
