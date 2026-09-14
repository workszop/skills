#!/usr/bin/env bash
# install-desktop.sh — register "Open with md2web" for Markdown files (per user).
#   scripts/install-desktop.sh            install / refresh
#   scripts/install-desktop.sh --default  also make md2web the default for text/markdown
#   scripts/install-desktop.sh --remove   uninstall
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"
DESKTOP="$APPS_DIR/md2web.desktop"

refresh() {
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t "${ICON_DIR%/scalable/apps}" 2>/dev/null || true
}

if [[ "${1:-}" == "--remove" ]]; then
  rm -f "$DESKTOP" "$ICON_DIR/md2web.svg"
  refresh
  echo "removed md2web desktop entry"
  exit 0
fi

command -v node >/dev/null 2>&1 || { echo "node is required (build.mjs)"; exit 1; }
mkdir -p "$APPS_DIR" "$ICON_DIR"
chmod +x "$SKILL_DIR/scripts/md2web-open"
NODE_BIN="$(command -v node)"
# Plain string substitution (not sed): paths may contain '#', '&' or spaces
entry="$(<"$SKILL_DIR/scripts/md2web.desktop")"
entry="${entry//__SKILL_DIR__/"$SKILL_DIR"}"
entry="${entry//__NODE_BIN__/"$NODE_BIN"}"
# Wayland app_id Chrome gives md2web-open's windows (verified on COSMIC via
# ext_foreign_toplevel_list): "chrome-" + host ("" for file://) + "_" + the stub path with
# "/" and " " turned into "_" + "-" + profile name, e.g. chrome-__home_me_.cache_md2web_open.html-Default
stub="${XDG_CACHE_HOME:-$HOME/.cache}/md2web/open.html"
stub="${stub//\//_}"; stub="${stub// /_}"
entry="${entry//__WM_CLASS__/"chrome-_${stub}-Default"}"
printf '%s\n' "$entry" > "$DESKTOP"
cp "$SKILL_DIR/assets/md2web.svg" "$ICON_DIR/md2web.svg"
refresh

if [[ "${1:-}" == "--default" ]]; then
  xdg-mime default md2web.desktop text/markdown text/x-markdown
  echo "md2web is now the default app for text/markdown"
fi

echo "installed: $DESKTOP"
echo "right-click a .md file in Files → Open with → md2web"
