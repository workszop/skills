#!/usr/bin/env bash
# Read-only health check of live events after a deploy: GET /api/e/<slug>/event for every
# <dir>/.event-*.secret that holds slug=..., skipping files with a deleted= line.
# Prints names, date line and guest count; never prints codes. Exit 1 if any event is missing.
# usage: bash event-check.sh <api-base, e.g. https://x.workers.dev> <dir with .event-*.secret>
set -euo pipefail
api="${1:?api base url}"; dir="${2:?directory with .event-*.secret files}"; api="${api%/}"; bad=0; n=0; seen=" "
for f in "$dir"/.event-*.secret; do
  [ -e "$f" ] || { echo "no .event-*.secret files in $dir"; exit 1; }
  grep -q '^deleted=' "$f" && continue
  slug=$(sed -n 's/^slug=//p' "$f" | head -1); [ -n "$slug" ] || continue
  case "$seen" in *" $slug "*) continue ;; esac; seen="$seen$slug "   # a backup copy of the same event
  n=$((n + 1))
  out=$(curl -s -m 15 "$api/api/e/$slug/event" || true)
  if line=$(printf '%s' "$out" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"{d['names']} | {d.get('dateLine','')} | guests: {d['guests']}\")" 2>/dev/null); then
    echo "OK   $(basename "$f"): $line"
  else
    echo "FAIL $(basename "$f"): $(printf '%s' "$out" | head -c 120)"; bad=1
  fi
done
[ "$n" -gt 0 ] || echo "no live events listed"
exit $bad
