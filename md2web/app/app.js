/**
 * md2web — Markdown viewer
 * Plain script (no ES modules) so it works when opened directly via file://
 * Depends on globals: window.marked, window.DOMPurify, window.hljs
 */

(function () {
  'use strict';

  // ── Sanity check: libraries loaded? ────────────────────────────────────────
  if (!window.marked || !window.DOMPurify || !window.hljs) {
    document.addEventListener('DOMContentLoaded', () => {
      document.body.innerHTML =
        '<div style="padding:40px;font-family:system-ui;color:var(--status-error)">' +
        '<h1>Failed to load libraries</h1>' +
        '<p>marked / DOMPurify / highlight.js could not be loaded from the CDN. ' +
        'Check your internet connection and reload the page.</p></div>';
    });
    return;
  }

  const marked    = window.marked;
  const DOMPurify = window.DOMPurify;
  const hljs      = window.hljs;

  // ── Constants ──────────────────────────────────────────────────────────────
  // Built single-file pages (scripts/build.mjs) define window.MD2WEB with the
  // embedded document, baked format defaults and a per-document storage key.
  const CONFIG             = window.MD2WEB || {};
  const FORMAT_STORAGE_KEY = CONFIG.storageKey || 'md2web-format';
  const FORMAT_KEYS        = ['accent', 'font', 'scale', 'leading', 'measure', 'theme'];
  const DEFAULT_FORMAT     = Object.assign({
    accent: 'blue', font: 'raleway', scale: 'md',
    leading: 'normal', measure: 'default', theme: 'light',
    accentCustom: '#2563EB',
  }, CONFIG.defaults || {});
  // The editor pane is UI state, not typography: one global key, untouched by Format > Reset.
  const EDITOR_STATE_KEY   = 'md2web-editor';
  const EDITOR_WRAP_KEY    = 'md2web-editor-wrap';
  const SIDEBAR_STATE_KEY  = 'md2web-sidebar';   // 'off' when the user hid the Files/Contents panel
  // Live reload (pages built with --watch): poll the .ver.js sidecar this often and
  // carry the scroll position across the reload in sessionStorage.
  const LIVE_POLL_MS       = 1000;
  const LIVE_SCROLL_KEY    = 'md2web-live-scroll:' + (CONFIG.storageKey || '');
  const NARROW_QUERY       = '(max-width: 1100px)';  // must match the drawer breakpoint in md-styles.css
  const EDITOR_DEBOUNCE_MS = 150;
  const SYNC_GAP           = 24;   // px below the top bar where a synced heading should land
  const IS_MAC             = /Mac|iPhone|iPad/.test(navigator.platform);
  const MD_FILE_RE = /\.(md|markdown|txt)$/i;
  // Local images inlined by scripts/build.mjs: { "img/x.png": "data:image/png;base64,..." }
  const ASSETS             = CONFIG.assets || {};
  const HL_CACHE_MAX       = 400;  // highlighted code blocks kept across re-renders
  const TALL_CODE_LINES    = 30;   // code blocks longer than this may break across printed pages
  const TALL_TABLE_ROWS    = 20;   // same for tables
  const TOAST_MS           = 5000;

  // ── State ──────────────────────────────────────────────────────────────────
  let docs        = [];    // [{ id, name, raw, original, scroll }]
  let activeDocId = null;
  let docSeq      = 0;
  let format      = Object.assign({}, DEFAULT_FORMAT);
  let overrides   = {};         // only the format keys the reader changed (what gets persisted)
  let tocObserver = null;
  let usedSlugs   = new Set();  // deduped per render so anchors/TOC links stay unique
  let reservedIds = new Set();  // element ids the app shell owns; article ids must not clash
  let hlCache     = new Map();  // lang + text -> highlighted HTML
  let editorOpen  = false;
  let editorWrap  = true;
  let sidebarCollapsed = false;
  let mirrorTops  = null;   // [lineTop px, ...] per source line (+ sentinel) while wrapping; null = stale
  let mirrorKey   = '';     // width/font the cached tops were measured with
  let mirrorValue = '';     // text the cached tops were measured for
  let editorTimer = null;       // debounced re-render while typing
  let syncTimer   = null;       // editor -> article scroll sync, one per frame
  let suppressSync = false;     // ignore the scroll event caused by setting textarea.value
  let toastTimer  = null;
  let liveTimer   = null;       // sidecar poll while a --watch build is live
  let liveNotified = false;     // "changed on disk" toast shown once per version
  let lastRevert  = null;       // { id, raw } so Revert can be undone from the toast
  let lineOffset  = 0;          // source lines removed before the body (front matter)
  let schemeQuery = null;       // matchMedia(prefers-color-scheme) for the "auto" theme

  // ── DOM refs (resolved on DOMContentLoaded) ───────────────────────────────
  let layout, mainArea, article;
  let articleHeader, articleBody, tocNav, tocList, topbarMeta, siteFooter, printTitle;
  let sidebar, filesNav, fileList, srLive, btnDrawer, btnSidebarClose;
  let editorMirror, btnEditorWrap;
  let btnPdf, btnFormat, formatPopover, mixerInput, mixerBtn;
  let editorPane, editorText, editorName, editorStatus;
  let toast, toastText, toastAction;

  // ── Heading slugs ──────────────────────────────────────────────────────────
  // Unicode-aware: "Ćwiczenia" -> "ćwiczenia", not "wiczenia". Slugs never reuse an
  // id the app shell owns (toast, editor, ...), so a heading can't hijack the UI.
  function slugBase(raw) {
    let base = String(raw).toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
    return base || 'section';
  }

  function slugify(raw) {
    const base = slugBase(raw);
    let slug = base, n = 1;
    while (usedSlugs.has(slug) || reservedIds.has(slug)) { slug = base + '-' + (++n); }
    usedSlugs.add(slug);
    return slug;
  }

  // Line endings and BOM are normalised once, at load: the textarea only ever holds
  // "\n", so a CRLF file would otherwise never compare equal to its own editor value.
  function normalizeSource(s) {
    return String(s).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  }

  // Relative image paths inlined at build time (see build.mjs); otherwise unchanged.
  function resolveAsset(src) {
    if (!src) return src;
    if (ASSETS[src]) return ASSETS[src];
    try { const dec = decodeURIComponent(src); if (ASSETS[dec]) return ASSETS[dec]; } catch (e) { /* not encoded */ }
    return src;
  }

  // ── marked: object-argument renderer (marked v14+, tested on v18) ─────────
  // Each renderer method receives a single token object and uses
  // `this.parser.parseInline()` / `.parse()` to render child tokens to HTML.
  marked.use({
    gfm: true,
    renderer: {
      heading({ text, depth, tokens, line }) {
        const slug = slugify(text);
        const inner = this.parser.parseInline(tokens);
        return '<h' + depth + ' id="' + slug + '" class="md-h' + depth + '" data-md-heading="true"' + lineAttr(line) + '>' + inner + '</h' + depth + '>\n';
      },

      // Raw HTML headings get the same data-line anchor as Markdown ones
      html({ text, line }) {
        if (line === undefined) return text;
        let scanAt = 0;
        let scanLine = line;
        return text.replace(/<h([1-6])(?=[\s>])/gi, (m, d, at) => {
          while (scanAt < at) {
            if (text.charCodeAt(scanAt) === 10) scanLine++;
            scanAt++;
          }
          return '<h' + d + lineAttr(scanLine);
        });
      },

      blockquote({ tokens }) {
        return '<blockquote class="md-blockquote">' + this.parser.parse(tokens) + '</blockquote>\n';
      },

      hr() {
        return '<div class="md-hr" role="separator"><span></span></div>\n';
      },

      image({ href, title, text }) {
        const titleAttr = title ? ' title="' + escapeHtml(title) + '"' : '';
        const cap = title ? '<figcaption>' + escapeHtml(title) + '</figcaption>' : '';
        return '<figure class="md-figure"><img src="' + escapeHtml(resolveAsset(href || '')) + '" alt="' + escapeHtml(text || '') + '"' + titleAttr + ' loading="lazy" />' + cap + '</figure>\n';
      },

      table({ header, rows }) {
        const align = cell => cell.align ? ' md-table-cell--' + cell.align : '';
        const head = '<tr>' + header.map(cell =>
          '<th class="md-table-cell' + align(cell) + '">' + this.parser.parseInline(cell.tokens) + '</th>').join('') + '</tr>';
        const body = rows.map(row =>
          '<tr>' + row.map(cell =>
            '<td class="md-table-cell' + align(cell) + '">' + this.parser.parseInline(cell.tokens) + '</td>').join('') + '</tr>').join('');
        const tall = rows.length > TALL_TABLE_ROWS ? ' is-tall' : '';
        return '<div class="md-table-wrap' + tall + '"><table class="md-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>\n';
      },

      code({ text, lang: infostring }) {
        const lang = (infostring || '').match(/\S*/)[0];
        const hl = highlightCode(text, lang);
        const label = lang ? '<span class="code-lang">' + escapeHtml(lang) + '</span>' : '';
        const tall = countLines(text) >= TALL_CODE_LINES ? ' is-tall' : '';
        return '<div class="md-code-block' + tall + '">' + label + '<pre><code class="hljs' + (lang ? ' language-' + escapeHtml(lang) : '') + '">' + hl + '</code></pre></div>\n';
      },
    },
  });

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Highlighting (auto-detection especially) dominates re-render time while typing,
  // and most blocks are unchanged between keystrokes, so results are memoised.
  function highlightCode(text, lang) {
    const key = lang + ' ' + text;
    const hit = hlCache.get(key);
    if (hit !== undefined) return hit;
    const validLang = lang && hljs.getLanguage(lang) ? lang : null;
    let hl;
    try {
      if (validLang) {
        hl = hljs.highlight(text, { language: validLang }).value;
      } else if (text.length <= 50000) {
        // Auto-detection is expensive; skip it for very large unlabeled blocks
        hl = hljs.highlightAuto(text).value;
      } else {
        hl = escapeHtml(text);
      }
    } catch (e) {
      hl = escapeHtml(text);
    }
    if (hlCache.size >= HL_CACHE_MAX) hlCache.clear();
    hlCache.set(key, hl);
    return hl;
  }

  function countLines(s) {
    let n = 0;
    for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
    return n;
  }

  function lineAttr(line) {
    return line === undefined ? '' : ' data-line="' + line + '"';
  }

  // ── Source line annotation ─────────────────────────────────────────────────
  // Tags every heading / raw-HTML token with the 0-based source line it starts on,
  // so the rendered article carries exact data-line anchors for the editor sync.
  // Top-level token raws concatenate back to the source exactly; nested tokens
  // (blockquote, list items) lose their prefix, so they are located by searching
  // their first line inside the parent raw. The source prefix is scanned once per
  // token list, rather than re-counted from its beginning for every token.
  function annotateLines(tokens, parentRaw, baseLine, nested) {
    let cursor = 0;
    let scanAt = 0;
    let scanLine = baseLine;

    function lineAt(offset) {
      // `offset` is monotonic for both top-level and nested token lists. Keeping
      // this counter local to each raw token preserves exact nested offsets while
      // making the total character scan linear in the parent raw length.
      while (scanAt < offset) {
        if (parentRaw.charCodeAt(scanAt) === 10) scanLine++;
        scanAt++;
      }
      return scanLine;
    }

    tokens.forEach(t => {
      let at = cursor;
      let firstLine = '';
      if (nested) {
        firstLine = t.raw.split('\n', 1)[0].trim();
        const found = firstLine ? parentRaw.indexOf(firstLine, cursor) : -1;
        if (found !== -1) at = found;
      }
      const line = lineAt(at);
      if (t.type === 'heading' || t.type === 'html') t.line = line;
      const children = t.tokens || t.items;
      if (children && t.type !== 'paragraph' && t.type !== 'heading') annotateLines(children, t.raw, line, true);
      cursor = nested ? at + firstLine.length : cursor + t.raw.length;
    });
  }

  function formatDate(ms) {
    const d = new Date(ms);
    return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function announce(message) {
    if (srLive) srLive.textContent = message;
  }

  // ── Front-matter parser ────────────────────────────────────────────────────
  function parseFrontMatter(raw) {
    const fm = {};
    let body = raw;
    if (/^---[ \t]*(?:\n|$)/.test(raw)) {
      // Closing fence must be a line containing only `---`
      const end = raw.slice(3).search(/\n---[ \t]*(\n|$)/);
      if (end !== -1) {
        raw.slice(3, end + 3).trim().split('\n').forEach(line => {
          const colon = line.indexOf(':');
          if (colon === -1) return;
          fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
        });
        body = raw.slice(end + 3).replace(/^\n---[ \t]*\n?/, '').trimStart();
      }
    }
    return { fm, body };
  }

  // ── Render pipeline ────────────────────────────────────────────────────────
  function activeDoc() {
    return docs.find(d => d.id === activeDocId) || null;
  }

  function isHeadingElement(el) {
    return /^H[1-6]$/.test(el.tagName);
  }

  function hasUsableId(id) {
    return typeof id === 'string' && id.trim() !== '';
  }

  function nextUniqueId(raw, used, reserved) {
    const base = slugBase(raw);
    let id = base;
    let n = 1;
    while (used.has(id) || reserved.has(id)) id = base + '-' + (++n);
    used.add(id);
    return id;
  }

  // Raw HTML can supply heading IDs before/after Markdown headings are rendered.
  // Keep the first valid raw ID where possible, then give every other heading a
  // deterministic, shell-safe ID before the ToC is built.
  function ensureHeadingIds() {
    const headings = Array.from(article.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    const used = new Set(reservedIds);

    // Non-heading raw IDs are still part of the page namespace. Keep them unique
    // first so a heading cannot silently target a duplicate wrapper or shell id.
    articleBody.querySelectorAll('[id]').forEach(el => {
      if (isHeadingElement(el)) return;
      const original = el.getAttribute('id');
      if (!hasUsableId(original)) {
        el.removeAttribute('id');
        return;
      }
      if (!used.has(original)) {
        used.add(original);
        return;
      }
      el.id = nextUniqueId(original, used, new Set());
    });

    const preferred = new Set();
    const rawPreferred = new Set();
    const generatedPreferred = new Set();
    headings.forEach(h => {
      const original = h.getAttribute('id');
      if (!hasUsableId(original) || used.has(original)) return;
      preferred.add(original);
      if (h.dataset.mdHeading === 'true') generatedPreferred.add(original);
      else rawPreferred.add(original);
    });

    headings.forEach(h => {
      const original = h.getAttribute('id');
      const generated = h.dataset.mdHeading === 'true';
      const canPreserve = hasUsableId(original) && !used.has(original) &&
        (generated ? generatedPreferred.has(original) && !rawPreferred.has(original) : rawPreferred.has(original));
      if (canPreserve) {
        used.add(original);
      } else {
        h.id = nextUniqueId(h.textContent, used, preferred);
      }
      h.removeAttribute('data-md-heading');
    });
  }

  function render(doc) {
    usedSlugs = new Set();  // reset per render so heading IDs stay unique
    const raw = doc.raw;    // already normalised (BOM, CRLF) at load
    const { fm, body } = parseFrontMatter(raw);

    // Show the article first so even a parse error is visible, not hidden behind the drop zone
    mainArea.hidden   = true;
    article.hidden    = false;
    siteFooter.hidden = false;
    btnPdf.disabled   = false;

    articleHeader.innerHTML = '';
    if (fm.title || fm.category || fm.date || fm.author) {
      // Front-matter values are plain text — escape before injecting as HTML.
      const eyebrow = [fm.category, fm.date, fm.author].filter(Boolean).map(escapeHtml).join(' · ');
      articleHeader.innerHTML =
        '<div class="article-fm">' +
        (eyebrow      ? '<p class="type-eyebrow article-fm__eyebrow">' + eyebrow + '</p>' : '') +
        (fm.title     ? '<h1 class="article-fm__title" data-md-heading="true">' + escapeHtml(fm.title) + '</h1>' : '') +
        (fm.subtitle  ? '<p class="article-fm__subtitle type-body-lg">' + escapeHtml(fm.subtitle) + '</p>' : '') +
        '<div class="article-fm__rule"></div>' +
        '</div>';
    }

    let html;
    try {
      lineOffset = countLines(raw.slice(0, raw.length - body.length));
      const tokens = marked.lexer(body);
      annotateLines(tokens, body, lineOffset, false);
      html = marked.parser(tokens);
    } catch (err) {
      console.error('Markdown parse error:', err);
      articleBody.innerHTML = '<p class="md-parse-error">Failed to parse Markdown: ' + escapeHtml(err.message) + '</p>';
      return false;
    }

    articleBody.innerHTML = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['id', 'loading', 'role'],
      FORBID_TAGS: ['style'],
      FORBID_ATTR: ['style'],
    });

    ensureHeadingIds();

    // Raw <img src="local.png"> gets the same build-time inlining as Markdown images
    articleBody.querySelectorAll('img[src]').forEach(img => {
      const src = img.getAttribute('src');
      const resolved = resolveAsset(src);
      if (resolved !== src) img.setAttribute('src', resolved);
    });

    // Replace GFM task-list checkboxes with SVG icons and wrap the item's own text so
    // it can be struck through without touching nested lists or paragraphs.
    articleBody.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      const li = cb.closest('li');
      if (!li) return;
      li.classList.add('task-item');
      li.classList.toggle('task-item--checked', cb.checked);
      const icon = document.createElement('span');
      icon.className = 'task-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = cb.checked
        ? '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
        : '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';
      const host = cb.parentElement;  // <li> for tight lists, <p> inside <li> for loose ones
      const text = document.createElement('span');
      text.className = 'task-text';
      let node = cb.nextSibling;
      while (node && !/^(UL|OL|P|DIV|PRE|TABLE|BLOCKQUOTE)$/.test(node.nodeName)) {
        const next = node.nextSibling;
        text.appendChild(node);
        node = next;
      }
      host.insertBefore(text, cb.nextSibling);
      cb.replaceWith(icon);
    });

    buildToC();
    updateSidebar();

    // Date: front matter wins, otherwise the file's last-modified time (never "today")
    const dateStr = fm.date || (doc.modified ? formatDate(doc.modified) : '');
    const label   = fm.title || doc.name || 'Untitled';
    topbarMeta.innerHTML =
      '<span class="topbar__filename type-mono">' + escapeHtml(label) + '</span>' +
      (dateStr ? '<span class="topbar__date type-mono" title="Last changed">' + escapeHtml(dateStr) + '</span>' : '');
    printTitle.textContent = fm.title || (doc.name || '').replace(MD_FILE_RE, '');
    return true;
  }

  function showEmpty() {
    articleHeader.innerHTML = '';
    articleBody.innerHTML   = '';
    article.hidden    = true;
    siteFooter.hidden = true;
    mainArea.hidden   = false;
    btnPdf.disabled   = true;
    tocNav.hidden     = true;
    topbarMeta.innerHTML = '<span class="topbar__hint">Open a .md file to preview it</span>';
    updateSidebar();
    syncEditor();
  }

  // ── Multi-file session ─────────────────────────────────────────────────────
  function addFiles(fileListLike) {
    const files = Array.from(fileListLike).filter(f =>
      MD_FILE_RE.test(f.name) || f.type === 'text/markdown' || f.type === 'text/plain');
    if (!files.length) {
      showToast('No Markdown files found — expected .md, .markdown, or .txt');
      return;
    }

    // Create entries synchronously so list order matches selection order,
    // then fill raw content as each FileReader completes.
    const entries = files.map(f => ({ id: ++docSeq, name: f.name, raw: null, original: null, scroll: 0, draftKey: null, modified: f.lastModified || 0 }));
    docs = docs.concat(entries);
    let pending = files.length;

    files.forEach((file, i) => {
      const reader = new FileReader();
      reader.onload = e => {
        entries[i].raw = entries[i].original = normalizeSource(e.target.result);
        if (--pending === 0) finishAdd(entries);
      };
      reader.onerror = e => {
        showToast('Failed to read ' + file.name + ': ' + (e.target.error || 'unknown error'));
        docs = docs.filter(d => d.id !== entries[i].id);
        if (--pending === 0) finishAdd(entries);
      };
      reader.readAsText(file);
    });
  }

  function finishAdd(entries) {
    const loaded = entries.filter(e => docs.includes(e));
    if (loaded.length) {
      activateDoc(loaded[0].id);
      announce('Loaded ' + loaded.length + (loaded.length === 1 ? ' file: ' + loaded[0].name : ' files'));
    } else {
      updateSidebar();
    }
  }

  function activateDoc(id) {
    const current = activeDoc();
    if (current) { flushEdit(); current.scroll = window.scrollY; }

    const doc = docs.find(d => d.id === id);
    if (!doc) return;
    activeDocId = id;
    render(doc);
    renderFileList();
    syncEditor();
    window.scrollTo({ top: doc.scroll || 0, behavior: 'instant' });  // no animated jump between files
  }

  function closeDoc(id) {
    const idx = docs.findIndex(d => d.id === id);
    if (idx === -1) return;
    const wasActive = docs[idx].id === activeDocId;
    if (wasActive) flushEdit();
    docs.splice(idx, 1);

    if (wasActive) {
      activeDocId = null;
      if (docs.length) {
        activateDoc((docs[idx] || docs[idx - 1]).id);
        return;
      } else {
        showEmpty();
      }
    }
    renderFileList();
    if (!wasActive) updateSidebar();
  }

  function renderFileList() {
    fileList.innerHTML = '';
    docs.forEach(doc => {
      const li = document.createElement('li');
      li.className = 'files__item' + (doc.id === activeDocId ? ' files__item--active' : '');

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'files__open';
      open.textContent = doc.name;
      open.title = doc.name;
      open.addEventListener('click', () => activateDoc(doc.id));

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'files__close';
      close.setAttribute('aria-label', 'Close ' + doc.name);
      close.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      close.addEventListener('click', () => closeDoc(doc.id));

      li.appendChild(open);
      li.appendChild(close);
      fileList.appendChild(li);
    });
  }

  function updateSidebar() {
    filesNav.hidden = docs.length < 2;
    const available = !(filesNav.hidden && tocNav.hidden);
    sidebar.hidden  = !available || sidebarCollapsed;
    layout.classList.toggle('layout--side', !sidebar.hidden);
    // The top-bar "Contents" button exists whenever there is a panel to show: on wide
    // screens it docks/undocks the panel, on narrow screens it opens the drawer.
    btnDrawer.hidden = !available;
    if (sidebar.hidden) setDrawerOpen(false);
    else if (!isNarrow()) btnDrawer.setAttribute('aria-expanded', 'true');
    document.documentElement.setAttribute('data-md2web-sidebar', sidebar.hidden ? 'off' : 'on');
    document.documentElement.setAttribute('data-md2web-docs', String(docs.length));
  }

  function isNarrow() {
    return window.matchMedia(NARROW_QUERY).matches;
  }

  function setDrawerOpen(open) {
    layout.classList.toggle('layout--drawer', open);
    btnDrawer.setAttribute('aria-expanded', open);
  }

  // Hidden state is UI, not typography: one global key, untouched by Format > Reset
  function setSidebarCollapsed(collapsed, persist = true) {
    sidebarCollapsed = collapsed;
    updateSidebar();
    if (persist) {
      try { localStorage.setItem(SIDEBAR_STATE_KEY, collapsed ? 'off' : 'on'); } catch (e) { /* private mode */ }
    }
  }

  function toggleSidebarButton() {
    if (sidebarCollapsed) {
      setSidebarCollapsed(false);
      if (isNarrow()) setDrawerOpen(true);
    } else if (isNarrow()) {
      setDrawerOpen(!layout.classList.contains('layout--drawer'));
    } else {
      setSidebarCollapsed(true);
    }
  }

  // ── Table of Contents ──────────────────────────────────────────────────────
  function buildToC() {
    const headings = Array.from(articleBody.querySelectorAll('h2, h3'));
    const tocLinks = new Map();
    tocList.innerHTML = '';
    if (tocObserver) { tocObserver.disconnect(); tocObserver = null; }

    if (headings.length < 3) {
      tocNav.hidden = true;
      return;
    }

    headings.forEach((h, i) => {
      // Built with createElement/textContent — heading text must never be
      // re-parsed as HTML here (it can contain decoded entities).
      const li = document.createElement('li');
      li.className = 'toc__item toc__item--h' + h.tagName[1];
      const a = document.createElement('a');
      // Encode the fragment rather than interpolating a raw ID into a selector.
      // IDs may legally contain quotes, %, or # characters from source HTML.
      a.href = '#' + encodeURIComponent(h.id);
      a.className = 'toc__link';
      const num = document.createElement('span');
      num.className = 'toc__num type-mono';
      num.textContent = String(i + 1).padStart(2, '0');
      const text = document.createElement('span');
      text.className = 'toc__text';
      text.textContent = h.textContent;
      a.appendChild(num);
      a.appendChild(text);
      li.appendChild(a);
      tocList.appendChild(li);
      tocLinks.set(h, a);
    });

    tocNav.hidden = false;

    tocObserver = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (!e.isIntersecting) return;
        tocList.querySelectorAll('.toc__link').forEach(a => a.classList.remove('toc__link--active'));
        const active = tocLinks.get(e.target);
        if (active) active.classList.add('toc__link--active');
      });
    }, { rootMargin: '-10% 0px -80% 0px' });

    headings.forEach(h => tocObserver.observe(h));
  }

  // ── Formatting panel ───────────────────────────────────────────────────────
  // Only the keys the reader changed are persisted, so a page rebuilt with new
  // --accent/--theme defaults still shows them for every untouched control.
  function loadFormat() {
    overrides = {};
    try {
      const saved = JSON.parse(localStorage.getItem(FORMAT_STORAGE_KEY) || '{}');
      FORMAT_KEYS.concat('accentCustom').forEach(key => { if (saved[key] !== undefined) overrides[key] = saved[key]; });
    } catch (e) { /* corrupted settings — defaults apply */ }
    format = Object.assign({}, DEFAULT_FORMAT, overrides);
  }

  function saveFormat() {
    try {
      if (Object.keys(overrides).length) localStorage.setItem(FORMAT_STORAGE_KEY, JSON.stringify(overrides));
      else localStorage.removeItem(FORMAT_STORAGE_KEY);
    } catch (e) { /* private mode */ }
  }

  // "auto" follows the OS colour scheme; the attribute always carries a concrete theme
  function resolveTheme(theme) {
    return theme === 'auto' ? (schemeQuery && schemeQuery.matches ? 'dark' : 'light') : theme;
  }

  function applyFormat() {
    const root = document.documentElement;
    FORMAT_KEYS.forEach(key => root.setAttribute('data-md-' + key, key === 'theme' ? resolveTheme(format[key]) : format[key]));

    if (format.accent === 'custom') {
      root.style.setProperty('--accent', format.accentCustom);
    } else {
      root.style.removeProperty('--accent');
    }

    syncFormatButtons();
    mixerBtn.classList.toggle('is-selected', format.accent === 'custom');
    mixerBtn.setAttribute('aria-pressed', format.accent === 'custom');
    mixerInput.value = format.accentCustom;
    saveFormat();
  }

  // Selected state of every segmented control, including the (non-format) editor toggle
  function syncFormatButtons() {
    formatPopover.querySelectorAll('[data-format]').forEach(btn => {
      const key = btn.dataset.format;
      const value = key === 'editor' ? (editorOpen ? 'on' : 'off') : format[key];
      const on = value === btn.dataset.value;
      btn.classList.toggle('is-selected', on);
      btn.setAttribute('aria-pressed', on);
    });
  }

  function setFormat(key, value) {
    format[key] = value;
    if (value === DEFAULT_FORMAT[key]) delete overrides[key]; else overrides[key] = value;
    applyFormat();
  }

  function initFormatPanel() {
    schemeQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    if (schemeQuery) schemeQuery.addEventListener('change', () => { if (format.theme === 'auto') applyFormat(); });

    formatPopover.addEventListener('click', e => {
      const btn = e.target.closest('[data-format]');
      if (!btn) return;
      if (btn.dataset.format === 'editor') setEditorOpen(btn.dataset.value === 'on');
      else setFormat(btn.dataset.format, btn.dataset.value);
    });

    mixerBtn.addEventListener('click', () => mixerInput.click());
    mixerInput.addEventListener('input', () => {
      format.accentCustom = mixerInput.value;
      overrides.accentCustom = mixerInput.value;
      setFormat('accent', 'custom');
    });

    document.getElementById('btn-format-reset').addEventListener('click', () => {
      format = Object.assign({}, DEFAULT_FORMAT);
      overrides = {};
      applyFormat();
      announce('Formatting reset to defaults');
    });

    // Popover open/close
    function setOpen(open) {
      const wasOpen = formatPopover.classList.contains('is-open');
      // Move focus out before applying inert. Otherwise the browser can leave
      // focus on an element that has just become unavailable to keyboard users.
      if (wasOpen && !open && formatPopover.contains(document.activeElement)) btnFormat.focus();
      if (open) {
        formatPopover.removeAttribute('inert');
        formatPopover.inert = false;
      } else {
        formatPopover.setAttribute('inert', '');
        formatPopover.inert = true;
      }
      formatPopover.classList.toggle('is-open', open);
      formatPopover.setAttribute('aria-hidden', String(!open));
      btnFormat.setAttribute('aria-expanded', String(open));
    }
    btnFormat.addEventListener('click', () => setOpen(!formatPopover.classList.contains('is-open')));
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { setOpen(false); setDrawerOpen(false); }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && !e.repeat && e.key.toLowerCase() === 'e') {
        // macOS: Ctrl+E in a text field is the system "move to end of line" binding; Cmd+E still toggles
        if (IS_MAC && !e.metaKey && e.target.closest('textarea, input, [contenteditable]')) return;
        e.preventDefault();
        setEditorOpen(!editorOpen);
      }
    });
    document.addEventListener('click', e => {
      if (!formatPopover.contains(e.target) && !btnFormat.contains(e.target)) setOpen(false);
    });

    loadFormat();
    applyFormat();
  }

  // ── Live editor pane ───────────────────────────────────────────────────────
  function setEditorOpen(open, persist = true) {
    if (!editorPane) return;
    const wasOpen = editorOpen;
    if (!open) flushEdit();  // before the flag flips: flushEdit only applies while the pane counts as open
    editorOpen = open;
    editorPane.hidden = !open;
    layout.classList.toggle('layout--editor', open);
    document.documentElement.setAttribute('data-md2web-editor', open ? 'on' : 'off');
    syncFormatButtons();
    if (open) {
      syncEditor();
      // Focus only on the closed -> open transition, never on a re-apply
      if (!wasOpen && activeDoc()) editorText.focus({ preventScroll: true });
    }
    if (persist) {
      try { localStorage.setItem(EDITOR_STATE_KEY, open ? 'on' : 'off'); } catch (e) { /* private mode */ }
    }
  }

  function setEditorWrap(on, persist = true) {
    editorWrap = on;
    editorText.setAttribute('wrap', on ? 'soft' : 'off');
    btnEditorWrap.setAttribute('aria-pressed', String(on));
    mirrorTops = null;
    if (persist) {
      try { localStorage.setItem(EDITOR_WRAP_KEY, on ? 'on' : 'off'); } catch (e) { /* private mode */ }
    }
  }

  // Mirror the active doc into the pane (only when open; the value is set only when it differs).
  function syncEditor() {
    if (!editorOpen) return;
    const doc = activeDoc();
    const raw = doc ? doc.raw : '';
    if (editorText.value !== raw) {
      suppressSync = true;  // the value change fires a scroll event that must not move the article
      editorText.value = raw;
      requestAnimationFrame(() => { suppressSync = false; });
    }
    editorText.disabled = !doc;
    editorName.textContent = doc ? doc.name : '';
    editorStatus.textContent = doc && doc.raw !== doc.original ? 'edited' : '';
  }

  function applyEdit() {
    const doc = activeDoc();
    if (!doc || doc.raw === editorText.value) return;
    doc.raw = editorText.value;
    const parsed = render(doc);
    editorStatus.textContent = doc.raw !== doc.original ? 'edited' : '';
    if (parsed) saveDraft(doc);  // never persist text the renderer choked on
    // Keep the section being typed in view (only scrolls when it is off screen)
    syncArticleToLine(countLines(editorText.value.slice(0, editorText.selectionStart)), true);
  }

  function scheduleEdit() {
    clearTimeout(editorTimer);
    editorTimer = setTimeout(applyEdit, EDITOR_DEBOUNCE_MS);
  }

  // Apply a pending debounced edit now (before the active doc changes or the pane closes)
  function flushEdit() {
    if (editorTimer === null) return;
    clearTimeout(editorTimer);
    editorTimer = null;
    if (editorOpen) applyEdit();
  }

  function saveDraft(doc) {
    if (!doc.draftKey) return;
    try {
      if (doc.raw === doc.original) localStorage.removeItem(doc.draftKey);
      else localStorage.setItem(doc.draftKey, doc.raw);
    } catch (e) {
      showToast('Edits could not be saved in this browser (storage full or blocked) - use Download .md');
    }
  }

  function loadDraft(draftKey) {
    try { return localStorage.getItem(draftKey); } catch (e) { return null; }
  }

  function revertEdits() {
    const doc = activeDoc();
    if (!doc || doc.raw === doc.original) return;
    flushEdit();
    lastRevert = { id: doc.id, raw: doc.raw };
    doc.raw = doc.original;
    render(doc);
    syncEditor();
    saveDraft(doc);
    announce('Edits discarded, original restored');
    showToast('Original restored', { kind: 'info', action: 'Undo', onAction: undoRevert, ms: 8000 });
  }

  function undoRevert() {
    if (!lastRevert) return;
    const doc = docs.find(d => d.id === lastRevert.id);
    const raw = lastRevert.raw;
    lastRevert = null;
    if (!doc) return;
    if (doc.id !== activeDocId) activateDoc(doc.id);
    doc.raw = raw;
    render(doc);
    syncEditor();
    saveDraft(doc);
    announce('Edits restored');
  }

  function downloadEdits() {
    const doc = activeDoc();
    if (!doc) return;
    flushEdit();
    const blob = new Blob([doc.raw], { type: 'text/markdown;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = doc.name || 'document.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ── Editor → article scroll sync ───────────────────────────────────────────
  // Anchors are the rendered elements carrying data-line (set from marked's own
  // tokens at render time, so setext headings, headings inside quotes/lists and
  // raw <h2> tags all count). Positions between anchors are interpolated; with no
  // anchors the interpolation runs start to end, i.e. proportional scrolling.

  function syncArticleToEditor() {
    syncTimer = null;
    syncArticleToLine(editorTopLine(), false);
  }

  // Fractional source line at the top of the editor viewport. Without wrapping every
  // source line is one visual line; with wrapping the mirror's measured line tops
  // are searched instead.
  function editorTopLine() {
    const cs = getComputedStyle(editorText);
    const padTop = parseFloat(cs.paddingTop) || 0;
    if (!editorWrap) {
      const lh = parseFloat(cs.lineHeight) || 20;
      return Math.max(0, (editorText.scrollTop - padTop) / lh);
    }
    const tops = measureMirror(cs);
    const y = editorText.scrollTop + padTop;   // mirror tops include the padding
    let lo = 0, hi = tops.length - 2;          // tops[n] is the sentinel below the last line
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tops[mid] <= y) lo = mid; else hi = mid - 1;
    }
    const span = tops[lo + 1] - tops[lo];
    return lo + (span > 0 ? Math.min(1, Math.max(0, (y - tops[lo]) / span)) : 0);
  }

  // Lay the editor text out in the hidden mirror (same class, same width) and cache
  // each source line's top. Re-measured only when the text, width or type changes.
  function measureMirror(cs) {
    const key = editorText.clientWidth + '|' + cs.font + '|' + cs.lineHeight + '|' + cs.letterSpacing;
    const value = editorText.value;
    if (mirrorTops && key === mirrorKey && value === mirrorValue) return mirrorTops;
    editorMirror.style.width = editorText.clientWidth + 'px';
    const frag = document.createDocumentFragment();
    for (const line of value.split('\n')) {
      const div = document.createElement('div');
      div.textContent = line || '\u200b';   // keep empty lines one line tall
      frag.appendChild(div);
    }
    editorMirror.replaceChildren(frag);
    const tops = Array.from(editorMirror.children, el => el.offsetTop);
    tops.push(editorMirror.scrollHeight);
    mirrorTops = tops; mirrorKey = key; mirrorValue = value;
    return tops;
  }

  // Scroll the article so source line `topLine` sits under the top bar. With
  // `onlyIfOffscreen` (typing) the page is left alone while the target is visible.
  function syncArticleToLine(topLine, onlyIfOffscreen) {
    const doc = activeDoc();
    if (!doc || editorPane.hidden || article.hidden) return;

    const pageY = el => el.getBoundingClientRect().top + window.scrollY;
    const artTop = pageY(article), artBottom = artTop + article.offsetHeight;
    const totalLines = countLines(editorText.value) + 1;

    // Anchor points [sourceLine, pageY] between virtual start/end anchors (kept monotonic)
    const anchors = [];
    articleBody.querySelectorAll('[data-line]').forEach(el => {
      const l = Number(el.dataset.line);
      if (l >= 0 && l < totalLines && (!anchors.length || l >= anchors[anchors.length - 1][0])) anchors.push([l, pageY(el)]);
    });
    const pts = [[0, artTop]].concat(anchors, [[totalLines, artBottom]]);
    let i = 0;
    while (i < pts.length - 2 && pts[i + 1][0] <= topLine) i++;
    const [l0, y0] = pts[i], [l1, y1] = pts[i + 1];
    const frac = l1 > l0 ? Math.min(1, (topLine - l0) / (l1 - l0)) : 0;
    const target = y0 + frac * (y1 - y0);
    // Keep the anchored line just below the top bar; scrollTo clamps to the page.
    // Instant: smooth scrolling would lag behind a stream of scroll events.
    const topbarH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')) || 60;
    if (onlyIfOffscreen) {
      const viewTop = window.scrollY + topbarH, viewBottom = window.scrollY + window.innerHeight - 40;
      if (target >= viewTop && target <= viewBottom) return;
    }
    window.scrollTo({ top: target - topbarH - SYNC_GAP, behavior: 'instant' });
  }

  function scheduleSync() {
    if (suppressSync) return;
    if (syncTimer === null) syncTimer = setTimeout(syncArticleToEditor, 16);  // ~one frame
  }

  function initEditor() {
    editorPane    = document.getElementById('editor');
    editorText    = document.getElementById('editor-text');
    editorName    = document.getElementById('editor-name');
    editorStatus  = document.getElementById('editor-status');
    editorMirror  = document.getElementById('editor-mirror');
    btnEditorWrap = document.getElementById('btn-editor-wrap');

    editorText.addEventListener('input', scheduleEdit);
    editorText.addEventListener('scroll', scheduleSync, { passive: true });
    // Tab inserts two spaces instead of moving focus. execCommand keeps the native
    // undo stack intact (assigning .value would wipe it); setRangeText is the fallback.
    editorText.addEventListener('keydown', e => {
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        let inserted = false;
        try { inserted = document.execCommand('insertText', false, '  '); } catch (err) { /* unsupported */ }
        if (!inserted) {
          editorText.setRangeText('  ', editorText.selectionStart, editorText.selectionEnd, 'end');
          scheduleEdit();  // execCommand fires "input" itself; setRangeText does not
        }
      }
    });
    document.getElementById('btn-editor-revert').addEventListener('click', revertEdits);
    document.getElementById('btn-editor-close').addEventListener('click', () => setEditorOpen(false));
    document.getElementById('btn-editor-download').addEventListener('click', downloadEdits);
    btnEditorWrap.addEventListener('click', () => setEditorWrap(!editorWrap));
    let wrapSaved = null;
    try { wrapSaved = localStorage.getItem(EDITOR_WRAP_KEY); } catch (e) { /* private mode */ }
    setEditorWrap(wrapSaved !== 'off', false);

    // Drag handle on the pane's left edge: dragging left widens the pane
    initResizer({ handleId: 'editor-resizer', cssVar: '--editor-w', storageKey: 'md2web-editor-w',
                  min: 280, max: 900, initial: 480, dir: -1, step: 10 });
  }

  // ── Resizable panes (sidebar, editor) ─────────────────────────────────────
  // The pane width is a CSS custom property on <html>, persisted per pane.
  // `dir` is +1 when dragging right widens the pane (sidebar, left edge of the
  // page) and -1 when dragging left widens it (editor, right edge).
  function initResizer({ handleId, cssVar, storageKey, min, max, initial, dir, step }) {
    const handle = document.getElementById(handleId);
    const root   = document.documentElement;
    let width = initial;

    handle.setAttribute('aria-valuemin', min);
    handle.setAttribute('aria-valuemax', max);

    function setWidth(px, persist) {
      // Never let a pane swallow the article: cap at 60% of the viewport
      const cap = Math.max(min, Math.min(max, Math.floor(window.innerWidth * 0.6)));
      width = Math.min(cap, Math.max(min, Math.round(px)));
      root.style.setProperty(cssVar, width + 'px');
      handle.setAttribute('aria-valuenow', width);
      if (persist) {
        try { localStorage.setItem(storageKey, String(width)); } catch (e) { /* private mode */ }
      }
    }

    let saved = NaN;
    try { saved = parseInt(localStorage.getItem(storageKey), 10); } catch (e) { /* private mode */ }
    if (!isNaN(saved)) setWidth(saved, false);

    let startX = 0, startW = 0, dragging = false;
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      startX = e.clientX;
      startW = width;
      dragging = true;
      handle.classList.add('is-dragging');
      root.classList.add('is-resizing');
      // Keep receiving moves outside the 8px handle; can throw for
      // already-released pointers (e.g. pen lift), so guard it.
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* drag still works within the handle */ }
    });
    handle.addEventListener('pointermove', e => {
      if (dragging) setWidth(startW + dir * (e.clientX - startX), false);
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('is-dragging');
      root.classList.remove('is-resizing');
      setWidth(width, true);
    }
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
    handle.addEventListener('dblclick', () => setWidth(initial, true));

    // ARIA separator pattern: arrows resize (Shift for bigger steps), Home/End = min/max
    handle.addEventListener('keydown', e => {
      const s = e.shiftKey ? step * 3 : step;
      if      (e.key === 'ArrowLeft')  setWidth(width - dir * s, true);
      else if (e.key === 'ArrowRight') setWidth(width + dir * s, true);
      else if (e.key === 'Home')       setWidth(min, true);
      else if (e.key === 'End')        setWidth(max, true);
      else return;
      e.preventDefault();
    });
  }

  // ── PDF export — uses native browser print → "Save as PDF" ────────────────
  function exportPdf() {
    flushEdit();
    // Switch the document title so the print dialog's suggested filename matches the .md
    const doc = activeDoc();
    const originalTitle = document.title;
    document.title = ((doc && doc.name) || '').replace(MD_FILE_RE, '') || 'document';
    window.print();
    // Restore after the print dialog closes
    setTimeout(() => { document.title = originalTitle; }, 100);
  }

  // ── Styled, auto-dismissing toast (replaces blocking alert) ────────────────
  // opts: { kind: 'error' | 'info', action: 'Undo', onAction: fn, ms }
  function showToast(message, opts = {}) {
    toastText.textContent = message;
    toast.classList.toggle('toast--info', opts.kind === 'info');
    toastAction.hidden = !opts.action;
    toastAction.textContent = opts.action || '';
    toastAction.onclick = opts.onAction ? () => { hideToast(); opts.onAction(); } : null;
    toast.classList.add('toast--visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, opts.ms || TOAST_MS);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toast.classList.remove('toast--visible');
  }

  // ── Init on DOM ready ──────────────────────────────────────────────────────
  function init() {
    layout        = document.getElementById('layout');
    mainArea      = document.getElementById('main-area');
    article       = document.getElementById('article');
    articleHeader = document.getElementById('article-header');
    articleBody   = document.getElementById('article-body');
    sidebar       = document.getElementById('sidebar');
    filesNav      = document.getElementById('files');
    fileList      = document.getElementById('file-list');
    tocNav        = document.getElementById('toc');
    tocList       = document.getElementById('toc-list');
    topbarMeta    = document.getElementById('topbar-meta');
    siteFooter    = document.getElementById('site-footer');
    printTitle    = document.getElementById('print-title');
    srLive        = document.getElementById('sr-live');
    btnDrawer     = document.getElementById('btn-drawer');
    btnSidebarClose = document.getElementById('btn-sidebar-close');
    btnPdf        = document.getElementById('btn-pdf');
    btnFormat     = document.getElementById('btn-format');
    formatPopover = document.getElementById('format-popover');
    mixerInput    = document.getElementById('mixer-input');
    mixerBtn      = document.getElementById('btn-mixer');
    toast         = document.getElementById('toast');
    toastText     = document.getElementById('toast-text');
    toastAction   = document.getElementById('toast-action');

    // Every id the shell owns is off-limits for heading slugs and raw-HTML ids
    document.querySelectorAll('[id]').forEach(el => reservedIds.add(el.id));

    const fileInput   = document.getElementById('file-input');
    const dropOverlay = document.getElementById('drop-overlay');
    const btnOpen     = document.getElementById('btn-open');
    const btnOpenDrop = document.getElementById('btn-open-drop');

    [btnOpen, btnOpenDrop].forEach(btn => btn.addEventListener('click', () => fileInput.click()));
    fileInput.addEventListener('change', e => {
      addFiles(e.target.files);
      fileInput.value = '';  // allow re-selecting the same file
    });

    // Only real file drags show the overlay (not text dragged inside the editor)
    const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    document.addEventListener('dragover',  e => { if (!hasFiles(e)) return; e.preventDefault(); dropOverlay.style.display = 'flex'; });
    document.addEventListener('dragleave', e => { if (!e.relatedTarget) dropOverlay.style.display = ''; });
    document.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dropOverlay.style.display = '';
      if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });

    // Sidebar drawer (narrow screens): toggle from the top bar, close on a ToC/file pick or outside click
    btnDrawer.addEventListener('click', e => { e.stopPropagation(); toggleSidebarButton(); });
    btnSidebarClose.addEventListener('click', () => { setSidebarCollapsed(true); if (!isNarrow()) btnDrawer.focus(); });
    sidebar.addEventListener('click', e => { if (e.target.closest('a, button')) setDrawerOpen(false); });
    window.matchMedia(NARROW_QUERY).addEventListener('change', updateSidebar);
    document.addEventListener('click', e => {
      if (layout.classList.contains('layout--drawer') && !sidebar.contains(e.target)) setDrawerOpen(false);
    });

    btnPdf.addEventListener('click', exportPdf);
    window.addEventListener('beforeprint', flushEdit);
    initEditor();
    initFormatPanel();
    let editorSaved = null;
    try { editorSaved = localStorage.getItem(EDITOR_STATE_KEY); } catch (e) { /* private mode */ }
    if (editorSaved === 'on') setEditorOpen(true, false);
    let sidebarSaved = null;
    try { sidebarSaved = localStorage.getItem(SIDEBAR_STATE_KEY); } catch (e) { /* private mode */ }
    if (sidebarSaved === 'off') setSidebarCollapsed(true, false);
    initResizer({ handleId: 'sidebar-resizer', cssVar: '--sidebar-w', storageKey: 'md2web-sidebar-w',
                  min: 180, max: 480, initial: 240, dir: 1, step: 16 });
    loadEmbedded();
  }

  // ── Embedded document (single-file build) ──────────────────────────────────
  // Edits are kept in localStorage under a key that includes a hash of the embedded
  // source: all file:// pages share one origin, so a name-only key would let a draft
  // from another document (or an older build of this one) replace the real content.
  function hashString(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  function loadEmbedded() {
    if (typeof CONFIG.source !== 'string') return;
    const source = normalizeSource(CONFIG.source);
    const draftPrefix = (CONFIG.storageKey || 'md2web-format').replace(/^md2web-format/, 'md2web-draft') + ':';
    const draftKey = draftPrefix + hashString(source);
    pruneDrafts(draftPrefix, draftKey);
    const draft = loadDraft(draftKey);
    const entry = { id: ++docSeq, name: CONFIG.name || 'document.md', raw: draft !== null ? normalizeSource(draft) : source, original: source, scroll: liveScrollRestore(), draftKey, modified: CONFIG.modified || 0 };
    docs.push(entry);
    activateDoc(entry.id);
    initLiveReload();
    document.title = entry.name.replace(MD_FILE_RE, '') + ' · md2web';
    // DOM contract for agents/verification: the embedded document is rendered.
    // (Together with data-md2web-docs and data-md2web-editor on <html>.)
    document.documentElement.setAttribute('data-md2web-ready', 'true');
  }

  // ── Live reload (scripts/build.mjs --watch) ─────────────────────────────────
  // The watcher rewrites the page and a sibling <name>.html.ver.js that sets
  // window.__md2webVersion. A <script> tag is the one thing a file:// page may load
  // from its own folder, so poll with that; when the version moves, reload - unless
  // the reader has unsaved in-page edits, then only offer it.
  function initLiveReload() {
    const watch = CONFIG.watch;
    if (!watch || !watch.sidecar || !watch.version) return;
    document.documentElement.setAttribute('data-md2web-live', 'on');
    liveTimer = setInterval(pollLive, LIVE_POLL_MS);
  }

  function pollLive() {
    const script = document.createElement('script');
    script.src = CONFIG.watch.sidecar + '?t=' + Date.now();
    script.onload = () => { script.remove(); onLiveVersion(window.__md2webVersion); };
    script.onerror = () => script.remove();   // watcher gone or file missing: try again later
    document.head.appendChild(script);
  }

  function onLiveVersion(version) {
    if (!version || version === CONFIG.watch.version) return;
    const doc = docs.find(d => d.draftKey);   // the embedded document
    if (doc && doc.raw !== doc.original) {
      if (liveNotified) return;
      liveNotified = true;
      showToast('File changed on disk. Reload discards your edits', { action: 'Reload', onAction: liveReload, ms: 60000 });
      return;
    }
    liveReload();
  }

  function liveReload() {
    clearInterval(liveTimer);
    try { sessionStorage.setItem(LIVE_SCROLL_KEY, String(window.scrollY)); } catch (e) { /* private mode */ }
    location.reload();
  }

  function liveScrollRestore() {
    if (!CONFIG.watch) return 0;
    try {
      const y = sessionStorage.getItem(LIVE_SCROLL_KEY);
      sessionStorage.removeItem(LIVE_SCROLL_KEY);
      return y ? Number(y) || 0 : 0;
    } catch (e) { return 0; }
  }

  // Drafts of earlier builds of the same document (same slug, other content hash)
  // would otherwise pile up forever on the shared file:// origin.
  function pruneDrafts(prefix, keep) {
    try {
      const stale = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix) && k !== keep) stale.push(k);
      }
      stale.forEach(k => localStorage.removeItem(k));
    } catch (e) { /* private mode */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
