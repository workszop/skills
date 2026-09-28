---
name: md2web
description: Use when turning a Markdown (.md) file into a polished, self-contained HTML web page or an A4 PDF with the md2web viewer. Triggers on "md2web", "markdown to html", "markdown to website", "render this md", "make a web page from this markdown", "md to pdf", "export markdown as pdf", "open with md2web", "zamień markdown na stronę / pdf".
---

# md2web: Markdown → single-file web page or PDF

md2web is a zero-build, brand-agnostic Markdown viewer (blue interface, "md2web" wordmark,
Raleway article font by default). The skill wraps it in a build script so an agent can produce
files without a browser session.

## Quick start

```bash
SKILL=~/.claude/skills/md2web
node $SKILL/scripts/build.mjs notes.md                     # → notes.html next to the source
node $SKILL/scripts/build.mjs notes.md --out site/notes.html
node $SKILL/scripts/build.mjs notes.md --pdf               # → notes.html + notes.pdf
node $SKILL/scripts/build.mjs notes.md --pdf out/notes.pdf --accent "#0F766E" --font inter --theme dark
```

The HTML is the **full md2web app** with the document embedded: it opens from `file://`, still
has Open / Format / Export PDF, and the reader can restyle it. Format → Editor (or Ctrl+E, Cmd+E on macOS)
opens a live Markdown editor on the right; edits re-render instantly, the article follows
the editor's scroll position (heading-anchored), persist in localStorage keyed by the
document's content (a rebuilt or same-named file never inherits a stale draft), and can be
saved with "Download .md" or discarded with "Revert" (undo from the toast). The format flags
set that page's baked defaults; only the controls the reader actually changed are remembered
per document in localStorage, so rebuilding with new flags still shows them. The editor
open/closed state, the editor's line-wrap toggle and whether the Files/Contents panel is
hidden (× in the panel, top-bar Contents button to restore) are remembered globally and are
not touched by Format > Reset.

Local images referenced by the Markdown (`![..](img/x.png)` or `<img src="img/x.png">`, up to
8 MB each) are embedded as data URIs, so the page shows them from any location, including the
desktop "Open with" cache. CRLF files and a UTF-8 BOM are normalised on load.

## Options

| Flag | Values | Default |
|------|--------|---------|
| `--accent` | `blue` `indigo` `violet` `pink` `emerald` `amber` `ink` or `#RRGGBB` | blue |
| `--font` | `raleway` `inter` `poppins` `lato` | raleway |
| `--size` | `sm` `md` `lg` | md |
| `--spacing` | `compact` `normal` `relaxed` | normal |
| `--measure` | `narrow` `default` `wide` | default |
| `--theme` | `light` `sepia` `dark` `auto` (follows the OS; PDF always prints light) | light |
| `--pdf [file]` | render A4 PDF with headless Chrome after the HTML | off |
| `--chrome PATH` | Chrome/Chromium binary (auto-detected otherwise) | auto |
| `--watch` | keep running and rebuild on every save; the open page reloads itself (see below) | off |

Accent colours the article (headings rule, links, code keywords, table header, task ticks).
The interface stays blue regardless. Custom hex accents get hover and wash variants derived
automatically with `color-mix()`.

### Live reload (`--watch`)

`--watch` builds once, then polls the source (so editors that replace the file on save are
fine) and rewrites the page plus a sibling `<page>.html.ver.js` holding the source hash. The
page polls that sidecar with a `<script>` tag every second (the one thing a `file://` page may
load from its own folder) and reloads when the hash moves, restoring the scroll position. If the
reader has unsaved in-page edits it does not reload; a toast offers *Reload* instead. The page
exposes `data-md2web-live="on"` while polling. `--watch-owner <substring>` makes the watcher exit
once no process with that text in its command line is alive; it also stops after 12 hours.
`--watch` cannot be combined with `--pdf`.

## Front matter

An optional YAML block at the top of the `.md` fills the article header:

```markdown
---
title: My Document
subtitle: An optional standfirst
category: Engineering
date: 6 Sep 2026
author: Jane Doe
---
```

One `key: value` per line; no lists or nesting. Without front matter the file name is used.
The table of contents appears automatically when there are 3+ `h2`/`h3` headings.

## Page breaks

A line holding only `\pagebreak`, `\newpage` or `<!-- pagebreak -->` forces a new PDF page
(a dashed "Page break" rule on screen; literal inside code blocks). Breaks that would only
print an empty page (at the end, doubled, or before any content without a front-matter title)
are ignored in print, and a trailing `---` is not printed. A break right after the front-matter
title gives a cover page. The page reports active breaks as `data-md2web-pagebreaks="<n>"`.

## Workflow for the agent

1. Run `build.mjs` with the user's file. Put the output next to the source unless told otherwise.
2. For HTML, verify the file exists and contains `window.MD2WEB` (the embedded document). To see
   it, serve the directory with `python3 -m http.server` and open it in Chrome, or open the
   `file://` path directly.
3. For PDF, check the page count with `pdfinfo` and rasterise a page with `pdftoppm -r 40 -png`
   to eyeball the layout. The PDF has a repeating "md2web · title" header on every page; code
   blocks of 30+ lines and tables of 20+ rows are allowed to break across pages.
   The rendered page exposes a DOM contract on `<html>`: `data-md2web-ready="true"`,
   `data-md2web-docs="<n>"`, `data-md2web-editor="on|off"`, `data-md2web-sidebar="on|off"`,
   `data-md2web-pagebreaks="<n>"` plus
   the `data-md-*` format attributes.
4. Report both paths as full links.

Requirements: Node 18+ (the build inlines marked, DOMPurify and highlight.js from `app/vendor/`,
so the page works offline; only Google Fonts need network), Google Chrome or Chromium for `--pdf`.

## Desktop integration (Linux)

`scripts/install-desktop.sh` registers an "Open with md2web" entry for `.md` files in the file
manager (COSMIC Files, Nautilus, etc.). It builds the page into `~/.cache/md2web/` and opens
it as a Chrome app window. Add `--default` to make md2web the default for `text/markdown`,
`--remove` to uninstall.

The launcher also starts one `build.mjs --watch` per opened file (pid file next to the build,
log in `<page>.watch.log`), so saving the `.md` from any editor refreshes the window within
about a second. The watcher exits on its own once the md2web Chrome profile has closed.
`MD2WEB_NO_WATCH=1` opens without it.

## Layout

| Path | Purpose |
|------|---------|
| `app/index.html`, `app/app.js` | Viewer shell and render pipeline |
| `app/tokens.css` | Design tokens (`--brand` blue, accent palette, type, spacing) |
| `app/md-styles.css` | Article, chrome and A4 print styles |
| `app/sample.md` | Demo document |
| `app/vendor/` | Pinned marked / DOMPurify / highlight.js copies inlined by the build |
| `scripts/build.mjs` | md → single-file HTML (+ `--pdf`) |
| `scripts/md2web-open`, `scripts/md2web.desktop`, `scripts/install-desktop.sh` | Linux "Open with" integration |
| `assets/md2web.svg` | App icon |

If a rendering bug shows up in generated output, fix it in `app/` (the skill is the source of
truth), then rebuild.
