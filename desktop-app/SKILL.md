---
name: desktop-app
description: Use when turning a script, CLI or local HTML/web tool into a Linux desktop app - .desktop launcher, "Open with" for a file type, custom app icon, app-like Chrome --app window, live reload of a file:// page from a background watcher - or when the panel/dock shows a generic gear or Chrome icon instead of the app's own, or a launcher does nothing when clicked but works from a terminal (COSMIC, GNOME, KDE, Wayland).
---

# Desktop App (Linux launcher + panel icon)

## Overview
A desktop app on Linux is three pieces that must agree: a launcher script, a `.desktop` entry,
and an icon. The panel shows the entry's icon only when the **running window's app_id** equals
the entry's file name (minus `.desktop`) or its `StartupWMClass`. Everything else is detail;
that match is what breaks.

Reference implementation: `~/git-claude/skills/md2web/scripts/` (`md2web-open`,
`md2web.desktop`, `install-desktop.sh`).

## Core rules
1. **Measure the app_id, never guess.** On Wayland run `scripts/wl-toplevels.py <filter>` with
   the window open. Put that exact string in `StartupWMClass`.
2. **X11 results do not transfer to Wayland.** Chrome's X11 WM_CLASS instance trims a leading
   `_` that the Wayland app_id keeps (`tmp_..._open.html` vs `chrome-__tmp_..._open.html-Default`).
   Test in the session type the user runs (`echo $XDG_SESSION_TYPE`).
3. **Make the app_id constant.** Chrome ignores `--class` for `--app` windows on Wayland and
   builds `chrome-<host>_<path with / -> _>-<profile dir>` from the *start URL*. A URL per
   document means an app_id per document, which no entry can claim. Fix: always start at one
   fixed stub page that redirects.
4. **Own Chrome profile.** Without `--user-data-dir`, the launch is handed to the user's running
   Chrome (flags ignored, window grouped under Chrome, profile name unknown). Side effect to
   tell the user: localStorage for `file://` pages starts empty in the new profile.
5. **Desktop sessions have a minimal PATH.** No nvm, no `~/.bashrc`. Bake absolute interpreter
   paths into `Exec=` at install time (`Exec=env APP_NODE=/abs/node ...`) with a glob fallback
   (`~/.nvm/versions/node/*/bin/node`), and `notify-send` failures - otherwise a click "does nothing".
6. **The installer computes machine-specific values** (node path, cache path, app_id) from a
   template with plain bash substitution (`${entry//__KEY__/"$val"}`, not sed - paths contain
   `&`, `#`, spaces), then runs `update-desktop-database` and `gtk-update-icon-cache`.

## Fixed-stub launch (Chrome --app)
```bash
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/myapp"
STUB="$CACHE_DIR/open.html"
cat > "$STUB" <<'EOF'
<!doctype html><meta charset="utf-8"><title>myapp</title>
<script>
  var f = decodeURIComponent(location.hash.slice(1));
  if (/^[A-Za-z0-9._-]+\.html$/.test(f)) location.replace(f);   // same-dir files only
</script>
EOF
nohup google-chrome --user-data-dir="$CACHE_DIR/chrome-profile" --no-first-run \
  --class=myapp --app="file://$STUB#$page_name" >/dev/null 2>&1 &
```
Installer side (Chrome's rule, verified on COSMIC with Chrome 151):
```bash
stub="${XDG_CACHE_HOME:-$HOME/.cache}/myapp/open.html"
stub="${stub//\//_}"; stub="${stub// /_}"
entry="${entry//__WM_CLASS__/"chrome-_${stub}-Default"}"   # host "" + "_" + path
```
`--class=myapp` still helps X11/XWayland. Also inline the icon as the page favicon.

## Live reload from a file watcher (Chrome --app, file://)
The launcher exits right after starting Chrome, so "refresh the window when the file is saved"
needs a detached watcher plus a way for a `file://` page to notice the rebuild. Reference:
`md2web-open` + `build.mjs --watch` + the `initLiveReload` block in `app.js`.

1. **Poll with a `<script>` tag, not fetch.** `fetch()`/XHR between `file://` URLs is blocked
   in Chrome; a `<script src="<page>.ver.js?t=<now>">` from the page's own folder loads fine.
   The watcher rewrites the page **and** a sidecar `<page>.html.ver.js` that sets
   `window.__myappVersion = "<source hash>"`; the page compares it with the hash baked into
   itself and calls `location.reload()` (scroll position via sessionStorage first). No server,
   no `--allow-file-access-from-files`.
2. **Poll the source with `fs.watchFile`, not `fs.watch`.** Editors that save by replacing the
   file (vim, Obsidian, LibreOffice) break inotify watches on the old inode; stat polling
   (500 ms) survives them. Rebuild on content-hash change, not mtime, or every touch reloads.
3. **Watcher lifetime = the Chrome profile, not the document URL.** Every N polls scan
   `/proc/*/cmdline` for the `--user-data-dir=<profile>` path; exit after 3 consecutive misses
   (Chrome needs a few seconds to start) and after a hard cap (12 h). Do not match the
   per-document `--app=...#page.html`: the second document is handed to the already-running
   Chrome, its URL never appears in any cmdline, and that watcher would quit at once. **Skip `process.pid`**: the watcher's own
   argv carries the needle (same trap as `pkill -f`, see Verifying), so a self-match keeps it
   alive forever.
4. **One watcher per built page.** PID file next to the build (`<page>.watch.pid`); it is
   alive only if `/proc/<pid>/cmdline` still names that output path (pids get reused). Test
   `-r /proc/$pid/cmdline` before redirecting from it, or bash prints the ENOENT itself.
   `nohup "$NODE" build.mjs "$md" --out "$out" --watch --watch-owner "$profile" >/dev/null 2>"$log" </dev/null &`
5. **Never reload over unsaved in-page edits.** If the page has its own editor, compare current
   text with the embedded original; when they differ show a toast with a Reload action instead.

Testing the whole chain from a Claude/terminal session:
- **Emulate the desktop launch with `systemd-run --user --scope`**, not a service unit. A
  service (`systemd-run --user --collect ... launcher`) makes the launcher its main PID and
  kills every `nohup`'d child (Chrome, watcher) the moment it exits - silently, no log. A scope
  has no main PID and lives while any process does, which is how the file manager launches
  apps too. Then `wl-toplevels.py`, `ps` for the watcher, edit the file, check the sidecar.
- **Browser test over `file://`, not http.** Headless Chrome via CDP can `Page.navigate` to a
  `file://` page; that is the only way to prove the `<script>` poll works where fetch is blocked.
- **Owner-gone test**: run the watcher with `--watch-owner some-never-existing-needle` and
  assert it exits; it only passes once the self-pid skip is in.
- Chrome's crashpad helper outlives the browser and keeps writing into the profile, so a
  recursive `rmSync` in teardown hits `ENOTEMPTY`; loop the delete for up to ~15 s.

## Icon
- SVG in `~/.local/share/icons/hicolor/scalable/apps/<name>.svg`, `Icon=<name>` (no path, no extension).
- Draw letters as paths/strokes, not `<text>` - icon renderers may lack the font.
- Preview before installing: headless Chrome `--screenshot` of a page showing it at 256 and 32 px.

## Quick reference
| Symptom | Cause | Fix |
|---|---|---|
| Panel shows gear/Chrome icon | app_id != entry name / StartupWMClass | measure with `wl-toplevels.py`, set StartupWMClass |
| Different app_id per opened file | app_id derived from start URL | fixed stub page + hash |
| Flags like `--class` ignored | existing Chrome process took the launch | dedicated `--user-data-dir` |
| Click does nothing, terminal works | desktop PATH lacks nvm/node | absolute path baked in Exec |
| Not in "Open with" | missing MimeType or stale cache | `MimeType=text/markdown;`, `update-desktop-database` |
| Old windows keep old icon | launched before the change | close and reopen them |
| Page never notices a rebuild on file:// | fetch/XHR blocked between file:// URLs | poll a sidecar with `<script src>` |
| Watcher quits when a 2nd file is opened | it matched the per-document `--app` URL | match the `--user-data-dir` path |
| Watcher never exits after window close | owner needle matched its own argv | skip `process.pid` in the /proc scan |
| Children vanish in a `systemd-run` test | service unit reaps them when main PID exits | `systemd-run --user --scope` |

## Verifying
- Open via the real path (file manager / launcher) or the launcher script with the baked env.
- `wl-toplevels.py <name>` shows the app_id == `StartupWMClass` in the installed entry.
- Only then ask the user to glance at the panel; say explicitly if you could not see it yourself.
- Test launches open **real windows**: a bash function named `google-chrome` does not stub a
  binary started via `nohup`. Use `XDG_CACHE_HOME=<scratch>` for isolation and kill stray test
  windows by their `--user-data-dir` (bracket the pattern: `pkill -f "[s]cratch/prof"`).

## Common mistakes
- Declaring the icon fixed from the formula or an X11 test without reading the Wayland app_id.
- Editing the installed `~/.local/share/applications/*.desktop` instead of the template + installer.
- Forgetting `--remove` in the installer (delete entry + icon, refresh caches).
- Watching with inotify (`fs.watch`) - replace-on-save editors leave it watching a dead inode.
