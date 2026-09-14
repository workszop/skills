import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { marked } = require('../app/vendor/marked.umd.js');

// Keep this regression test on the production annotator without requiring a DOM.
// The viewer is a classic script, so extracting the two pure helpers is enough to
// exercise the same implementation that render() calls in the browser.
const appSource = readFileSync(new URL('../app/app.js', import.meta.url), 'utf8');
const helperStart = appSource.indexOf('  function countLines(s) {');
const helperEnd = appSource.indexOf('  function formatDate(ms) {', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'annotation helpers must remain discoverable');
const { annotateLines } = Function(
  `${appSource.slice(helperStart, helperEnd)}; return { annotateLines };`,
)();

function headingAndHtmlTokens(source) {
  const tokens = marked.lexer(source);
  annotateLines(tokens, source, 0, false);
  const found = [];
  const walk = list => {
    for (const token of list) {
      if (token.type === 'heading' || token.type === 'html') {
        found.push({ type: token.type, text: token.text, line: token.line });
      }
      if (token.tokens && token.type !== 'heading') walk(token.tokens);
      if (token.items) walk(token.items);
    }
  };
  walk(tokens);
  return { tokens, found };
}

test('annotates exact source lines across setext, blockquote, nested list, and raw HTML', () => {
  const source = [
    '# top',
    '',
    'setext',
    '-----',
    '',
    '> quote',
    '> ## quoted',
    '',
    '- item',
    '  ## nested heading',
    '',
    '<div class="wrapper">',
    '<h2 id="raw">raw</h2>',
    '</div>',
    '',
    '### final',
  ].join('\n');

  const { found } = headingAndHtmlTokens(source);
  assert.deepEqual(found, [
    { type: 'heading', text: 'top', line: 0 },
    { type: 'heading', text: 'setext', line: 2 },
    { type: 'heading', text: 'quoted', line: 6 },
    { type: 'heading', text: 'nested heading', line: 9 },
    { type: 'html', text: '<div class="wrapper">\n<h2 id="raw">raw</h2>\n</div>', line: 11 },
    { type: 'heading', text: 'final', line: 15 },
  ]);
});

test('annotation scan work grows linearly with nested sibling count', () => {
  const measure = source => {
    const tokens = marked.lexer(source);
    let scanWork = 0;
    const originalSlice = String.prototype.slice;
    const originalCharCodeAt = String.prototype.charCodeAt;
    // The old implementation repeatedly sliced the whole prefix before calling
    // countLines. The incremental implementation scans that prefix with one
    // charCodeAt pass instead. Counting both operations gives a deterministic,
    // implementation-independent work measure without a production test hook.
    String.prototype.slice = function (start, end) {
      const result = originalSlice.call(this, start, end);
      if (start === 0 && end !== undefined) scanWork += result.length;
      return result;
    };
    String.prototype.charCodeAt = function (index) {
      scanWork++;
      return originalCharCodeAt.call(this, index);
    };
    try {
      annotateLines(tokens, source, 0, false);
    } finally {
      String.prototype.slice = originalSlice;
      String.prototype.charCodeAt = originalCharCodeAt;
    }
    return scanWork;
  };

  const render = siblingCount => Array.from({ length: siblingCount }, (_, i) => `> ## heading ${i}`).join('\n');
  const small = measure(render(400));
  const large = measure(render(800));
  assert.ok(small > 0, 'annotator must perform measurable source scanning');
  // Doubling the input may at most double the number of source characters scanned,
  // with a small allowance for token boundary bookkeeping. The old prefix-slicing
  // implementation is quadratic and fails this bound by roughly 4x.
  assert.ok(large <= small * 2.5, `expected linear scan work, got ${small} -> ${large}`);
});
