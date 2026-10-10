#!/usr/bin/env bash
# audit-paths – find things that assume the app lives at <owner>.github.io/<repo>/ instead of a domain root.
# Usage: audit-paths.sh <repo-dir> <repo-name>      Exit 0 = clean, 2 = findings to review.
set -euo pipefail

# ─── Constants ───
dir=${1:?usage: audit-paths.sh <repo-dir> <repo-name>}
repo=${2:?usage: audit-paths.sh <repo-dir> <repo-name>}
RG=(rg -n --hidden -g '!.git' -g '!node_modules' -g '!*.min.*' -g '!*.map' -g '!package-lock.json' -g '!pnpm-lock.yaml' -g '!yarn.lock')
found=0

# ─── Helpers ───
check() { # label pattern [extra rg args...]
  local label=$1 pattern=$2 out; shift 2
  out=$("${RG[@]}" "$@" -e "$pattern" "$dir" 2>/dev/null || true)
  [[ -z $out ]] && return 0
  found=1; printf '\n\033[1;33m%s\033[0m\n%s\n' "$label" "$out"
}

# ─── Checks ───
esc=$(sed 's/[.[\*^$()+?{|]/\\&/g' <<<"$repo")
check "Hardcoded /$repo/ sub-path (breaks at the domain root)" "[\"'(=\` ]/$esc(/|[\"'\`)])"
check "<base href> (must be / at the domain root)" '<base[[:space:]][^>]*href'
check "Bundler base path (vite/astro base, next basePath/assetPrefix, webpack publicPath)" \
  "(^|[^a-zA-Z])(base|basePath|assetPrefix|publicPath)[[:space:]]*:[[:space:]]*[\"'\`]/$esc" \
  -g '*.{js,mjs,cjs,ts,mts,json}'
check "package.json homepage / PUBLIC_URL" "(\"homepage\"[[:space:]]*:|PUBLIC_URL)" -g 'package.json' -g '.env*' -g '*.yml'
check "Web manifest start_url / scope with an absolute non-root path" '"(start_url|scope)"[[:space:]]*:[[:space:]]*"/[^"]' -g '*.webmanifest' -g 'manifest*.json'
check "Service worker registration / scope" "serviceWorker\.register" -g '*.{js,mjs,ts,html}'
check "Absolute github.io links to this repo (canonical, og:url, sitemap, fetch)" "[a-z0-9-]+\.github\.io/$esc(/|[\"'\`)]|$)"

if (( found )); then
  printf '\nReview each hit: paths under /%s/ become / on the subdomain.\n' "$repo"; exit 2
fi
echo "clean: nothing assumes the /$repo/ sub-path"
