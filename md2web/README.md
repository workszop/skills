# md2web

A zero-build, client-side Markdown → web viewer, packaged as a Claude Code skill.
Open or drag-and-drop a `.md` file and it renders to a polished, print-ready page
with a generated table of contents and one-click PDF export. The build script turns
any `.md` into a **single self-contained `.html`** or an **A4 PDF** from the command line.

## Features

- **Drag & drop or file picker** — load any `.md`, `.markdown`, or `.txt` file (CRLF and BOM are normalised).
- **Multi-file sessions** — open several files; switch from the *Files* list in the sidebar.
- **Formatting panel** — *Format* opens a popover with article-scoped options, persisted in
  `localStorage` and applied before first paint:
  - *Accent*: blue (default), indigo, violet, pink, emerald, amber, ink, plus a **color
    picker** for any custom accent. Hover and wash variants are derived with `color-mix()`.
  - *Font*: Raleway (default), Inter, Poppins, or Lato — article only; the interface stays in Inter.
  - *Size* (S/M/L), *Line spacing*, *Measure* (also sets the paragraph line length), *Theme*
    (light, sepia, dark, auto = follow the OS; print is always light). Only the controls you
    change are saved, so a page rebuilt with new defaults keeps showing them.
- **GitHub-flavored Markdown** via [marked](https://marked.js.org/), syntax highlighting via
  [highlight.js](https://highlightjs.org/), output sanitized with
  [DOMPurify](https://github.com/cure53/DOMPurify).
- **Front matter** — a leading `---` block sets title, subtitle, category, date, author.
- **Auto table of contents** from `h2`/`h3` headings (3+), with scroll-spy; Unicode-aware anchors
  (`#ćwiczenia`). The panel's × button hides it and the top-bar *Contents* button brings it
  back (remembered across pages). Below 1100 px the sidebar becomes a drawer behind the same
  button, and below 760 px the top-bar buttons collapse to icons - nothing is hidden on phones.
- **Local images inlined** by the build (`![..](img/x.png)`, `<img src>`; up to 8 MB each), so a
  built page is genuinely self-contained.
- **Live reload** — `build.mjs --watch` (and the desktop "Open with" launcher) rebuilds the page
  on every save and the open window refreshes itself, keeping your scroll position. Unsaved
  in-page edits are never overwritten: a toast offers *Reload* instead.
- **PDF export** — native print → "Save as PDF" with A4 layout and a repeating md2web header;
  or headless from the CLI with `--pdf`.

## Usage

```bash
# Interactive viewer — just open it
xdg-open app/index.html

# Build a single-file page (and a PDF) from any Markdown file
node scripts/build.mjs notes.md
node scripts/build.mjs notes.md --pdf --accent emerald --font inter
node scripts/build.mjs notes.md --watch    # keep rebuilding; the open page reloads itself

# Register "Open with md2web" for .md files in the file manager (Linux)
scripts/install-desktop.sh            # add --default to make it the default app
```

Format → Editor (or Ctrl+E, Cmd+E on macOS) opens a live Markdown editor pane on the right of the article:
typing re-renders after 150 ms, the article scrolls in step with the editor (anchored on
headings, interpolated between them) and follows the caret while you type, edits are kept in
localStorage keyed by document content (so a rebuilt or same-named file never shows a stale
draft; drafts of older builds are pruned), "Download .md" saves them and "Revert" restores the
original (with Undo in the toast). Tab inserts two spaces without breaking native undo. Long
lines wrap by default; the bar's wrap button switches to horizontal scrolling. The pane's open
state and wrap choice are remembered globally, separately from formatting. See `SKILL.md` for all flags. Built pages inline marked, DOMPurify and highlight.js from
`app/vendor/`, so they render offline; only Google Fonts still load from the network (the
dev app in `app/index.html` keeps the CDN tags with Subresource Integrity).

## Front matter

```markdown
---
title: My Document
subtitle: An optional standfirst
category: Engineering
date: 6 Sep 2026
author: Jane Doe
---
```

One `key: value` per line, quotes stripped. Lists and nested objects are not supported.

## Project layout

| Path | Purpose |
|------|---------|
| `app/index.html` | App shell and markup |
| `app/app.js` | Render pipeline (front matter, marked, DOMPurify, ToC, PDF, embedded docs) |
| `app/md-styles.css` | Markdown / article / print styling |
| `app/tokens.css` | Design tokens (brand blue, accent palette, type scale, spacing) |
| `app/sample.md` | Demo document |
| `scripts/build.mjs` | Markdown → single-file HTML, optional `--pdf` via headless Chrome |
| `scripts/md2web-open` | "Open with" launcher (builds to `~/.cache/md2web`, opens a Chrome app window, starts a `--watch` rebuilder per file) |
| `scripts/md2web.desktop`, `scripts/install-desktop.sh` | Linux desktop integration |
| `assets/md2web.svg` | App icon |

## Maintenance notes

- The custom renderer in `app.js` uses marked's **object-argument** API (marked v14+, tested on
  v18). CDN URLs carry SRI hashes; bumping a version means regenerating the hash AND
  re-downloading the same file into `app/vendor/` - the build verifies each vendored file
  against the SRI hash in `index.html` and refuses to inline a mismatch.
- There is no highlight.js theme stylesheet: every `.hljs-*` class is mapped to design tokens
  in `md-styles.css`, so code follows the accent and light/sepia/dark theme.
- `build.mjs` inlines `tokens.css` + `md-styles.css` + `app.js`, embeds the Markdown as
  `window.MD2WEB.source` and local images as `window.MD2WEB.assets` (path → data URI), and
  replaces the three CDN `<script>` tags with the vendored sources. The inlined app runs on
  `DOMContentLoaded` so the libraries are ready first. `--pdf` uses a throwaway Chrome profile
  that is removed after the run.
- Heading slugs never reuse an id owned by the app shell (`toast`, `editor`, ...); raw-HTML ids
  that clash are suffixed. Highlighted code is memoised across editor re-renders.
- Document `<style>` tags and inline `style` attributes are stripped. GFM table alignment
  uses controlled CSS classes, so left/center/right alignment is preserved.
- With wrapping on, editor → article scroll sync maps the textarea's scroll offset back to source
  lines through a hidden mirror (`#editor-mirror`, same class and width as the textarea, one block
  per line) whose line tops are cached until the text, width or type changes.
- PDF export flushes pending editor changes before printing, including browser-initiated print.
  Headless Chrome runs with its sandbox enabled; the host must support Chrome sandboxing.
- The `<!-- MD2WEB_CONFIG -->` marker and the `<title>md2web</title>` / stylesheet link lines in
  `app/index.html` are build anchors — keep them.

## Regression tests

Run from the project root with Node 18+; no npm packages are required:

```bash
node --test tests/annotation.test.mjs tests/build.test.mjs tests/watch.test.mjs tests/launcher.test.mjs
node --test tests/browser.test.mjs
```

The browser suite requires Google Chrome (`MD2WEB_CHROME` can select another Chromium binary)
and permission to run a sandboxed browser and a loopback HTTP server. It builds a temporary
offline page, checks the real DOM and editor/print behavior, and removes its browser profile
and server afterward. Annotation tests check source-line accuracy and linear scan work;
build tests cover CLI format options, bounded Chrome discovery, and sandboxed PDF arguments.
Watch tests drive `--watch` as a child process (rebuild on save, sidecar version, owner-gone
exit); the launcher test runs `md2web-open` against a fake `google-chrome` on `PATH` and checks
that one watcher is started per file and reused on reopen. The browser suite's second test
opens a watched page over `file://` and verifies the reload, the scroll restore and the
unsaved-edits toast.

## License

MIT — see [LICENSE](LICENSE).
