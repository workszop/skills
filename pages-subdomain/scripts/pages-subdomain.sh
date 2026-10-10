#!/usr/bin/env bash
# pages-subdomain – serve a GitHub Pages repo at https://<sub>.<domain> behind Cloudflare.
# Idempotent: every run reads live state (Cloudflare DNS + GitHub Pages) and does only what is missing,
# so after a timeout you simply re-run the same command.
set -euo pipefail

# ─── Constants ───
DEFAULT_DOMAIN="${PAGES_SUBDOMAIN_DOMAIN:-warsztaty-ai.com}"
CF_API="https://api.cloudflare.com/client/v4"
CERT_TIMEOUT_SEC="${CERT_TIMEOUT_SEC:-1800}"
CERT_STALL_SEC="${CERT_STALL_SEC:-600}"   # issuance that never starts is restarted once after this
POLL_SEC=20
DOH_URL="https://cloudflare-dns.com/dns-query"   # bypass stale local resolver caches when verifying
TAG="pages-subdomain"

usage() {
  cat <<EOF
Usage: pages-subdomain.sh [owner/]repo [options]

Serve a GitHub Pages site at https://<sub>.<domain>, proxied by Cloudflare.

Options:
  --domain D     Cloudflare zone (default: $DEFAULT_DOMAIN, env PAGES_SUBDOMAIN_DOMAIN)
  --sub S        subdomain label (default: repo name, lowercased, _ and . -> -)
  --no-proxy     leave the record DNS-only (grey cloud)
  --no-wait      do not wait for the GitHub certificate; re-run later to finish
  --status       report current state only, change nothing
  --remove       remove the custom domain from Pages + delete the DNS record
  --replace-domain  allow replacing a different custom domain already on the repo
  --dry-run      print mutating calls instead of running them
  -h, --help     this help

Token: \$CF_DNS_API_TOKEN, else the 'export CF_DNS_API_TOKEN=' line in ~/.bashrc.
Needs Zone:Read, DNS:Edit, Zone Settings:Read.  Exit codes: 0 ok, 1 error, 3 cert still pending.
EOF
}

# ─── State ───
mode=setup domain=$DEFAULT_DOMAIN sub="" proxy=1 wait=1 dryRun=0 replaceDomain=0 repoArg=""
owner="" repo="" fqdn="" target="" zoneId="" sslMode="" recId="" recProxied="" CF_TOKEN=""
pagesJson="{}" pagesOn=0 kicked=0 buildType="" srcBranch="" srcPath=""

# ─── Helpers ───
log()  { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
ok()   { printf '  \033[32mok\033[0m %s\n' "$*" >&2; }
warn() { printf '  \033[33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

loadToken() {
  CF_TOKEN="${CF_DNS_API_TOKEN:-}"
  if [[ -z $CF_TOKEN && -r $HOME/.bashrc ]]; then
    # non-interactive shells skip ~/.bashrc, so read the export line directly (never echoed)
    CF_TOKEN=$(sed -nE "s/^[[:space:]]*export[[:space:]]+CF_DNS_API_TOKEN=['\"]?([^'\"[:space:]]+)['\"]?[[:space:]]*$/\1/p" "$HOME/.bashrc" | tail -n1)
  fi
  [[ -n $CF_TOKEN ]] || die "No Cloudflare token. Set CF_DNS_API_TOKEN (Zone:Read, DNS:Edit, Zone Settings:Read)."
  # API tokens are 40+ chars; 32 hex = the token's ID copied from the list, 37 = the Global API Key
  (( ${#CF_TOKEN} >= 40 )) || die "CF_DNS_API_TOKEN is ${#CF_TOKEN} chars, not an API token (40+). You likely saved the token ID. Copy the secret shown once after 'Create Token', or 'Roll' the token to get a new one."
}

# cf METHOD PATH [JSON] – prints response JSON; exits non-zero on API failure
cf() {
  local method=$1 path=$2 body=${3:-} out
  local args=(-sS -X "$method" -H "Content-Type: application/json")
  [[ -n $body ]] && args+=(--data "$body")
  # token goes in via a process-substitution header file, never on the command line
  out=$(curl "${args[@]}" -H @<(printf 'Authorization: Bearer %s\n' "$CF_TOKEN") "$CF_API$path") \
    || die "curl failed: $method $path"
  if [[ $(jq -r '.success' <<<"$out" 2>/dev/null) != true ]]; then
    die "Cloudflare $method $path -> $(jq -c '.errors // .' <<<"$out" 2>/dev/null || echo "$out")"
  fi
  printf '%s' "$out"
}

# cfWrite – same as cf, but honours --dry-run
cfWrite() {
  if (( dryRun )); then echo "[dry-run] cf $1 $2 ${3:-}" >&2; printf '{"success":true,"result":{"id":"dry-run"}}'; return; fi
  cf "$@"
}

# ghWrite METHOD PATH JSON – gh api with a JSON body, honours --dry-run
ghWrite() {
  if (( dryRun )); then echo "[dry-run] gh api -X $1 $2 $3" >&2; return; fi
  gh api -X "$1" "$2" --input - <<<"$3" >/dev/null
}

sanitizeLabel() {
  local s; s=$(tr '[:upper:]' '[:lower:]' <<<"$1" | tr '_.' '--' | tr -cd 'a-z0-9-' | sed -E 's/-+/-/g; s/^-+//; s/-+$//')
  printf '%s' "${s:0:63}"
}

refreshPages() {
  pagesOn=1
  pagesJson=$(gh api "repos/$owner/$repo/pages" 2>/dev/null) || { pagesJson="{}"; pagesOn=0; }
  if (( pagesOn )); then
    buildType=$(jq -r '.build_type // "legacy"' <<<"$pagesJson")
    srcBranch=$(jq -r '.source.branch // empty' <<<"$pagesJson")
    srcPath=$(jq -r '.source.path // "/"' <<<"$pagesJson")
  fi
}

certState() { jq -r '.https_certificate.state // "none"' <<<"$pagesJson"; }
certCovers() { jq -e --arg d "$fqdn" '(.https_certificate.domains // []) | index($d) != null' <<<"$pagesJson" >/dev/null; }

# repoFile PATH -> prints "sha<TAB>decoded content" or nothing
repoFile() {
  local json; json=$(gh api "repos/$owner/$repo/contents/$1?ref=$srcBranch" 2>/dev/null) || return 0
  printf '%s\t%s' "$(jq -r .sha <<<"$json")" "$(jq -r .content <<<"$json" | base64 -d 2>/dev/null)"
}

# ensureRepoFile PATH CONTENT MESSAGE – create/update a file on the Pages source branch
ensureRepoFile() {
  local path=$1 content=$2 msg=$3 cur sha body
  cur=$(repoFile "$path"); sha=${cur%%$'\t'*}; [[ $cur == *$'\t'* ]] || sha=""
  if [[ -n $sha && "${cur#*$'\t'}" == "$content" ]]; then ok "$path already correct"; return; fi
  body=$(jq -nc --arg m "$msg" --arg c "$(printf '%s' "$content" | base64 -w0)" --arg b "$srcBranch" --arg s "$sha" \
    '{message:$m, content:$c, branch:$b} + (if $s == "" then {} else {sha:$s} end)')
  ghWrite PUT "repos/$owner/$repo/contents/$path" "$body"
  ok "committed $path to $srcBranch (git pull your local clone)"
}

joinPath() { local base=${1#/}; [[ -n $base ]] && printf '%s/%s' "$base" "$2" || printf '%s' "$2"; }

# ─── Steps ───
resolveRepo() {
  if [[ -z $repoArg ]]; then
    repoArg=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null) || die "Pass [owner/]repo (not inside a GitHub clone)."
  fi
  if [[ $repoArg == */* ]]; then owner=${repoArg%%/*} repo=${repoArg#*/}
  else owner=$(gh api user --jq .login) repo=$repoArg; fi
  gh api "repos/$owner/$repo" --jq .full_name >/dev/null 2>&1 || die "Repo $owner/$repo not found or no access."
  [[ -n $sub ]] || sub=$(sanitizeLabel "$repo")
  [[ -n $sub ]] || die "Could not derive a subdomain from '$repo'; pass --sub."
  fqdn="$sub.$domain"
  target="$(tr '[:upper:]' '[:lower:]' <<<"$owner").github.io"
}

resolveZone() {
  zoneId=$(cf GET "/zones?name=$domain" | jq -r '.result[0].id // empty')
  [[ -n $zoneId ]] || die "Zone $domain not visible to the token (needs Zone:Read on it)."
  sslMode=$(cf GET "/zones/$zoneId/settings/ssl" 2>/dev/null | jq -r '.result.value') || sslMode="unknown"
}

readRecord() {
  local recs n
  recs=$(cf GET "/zones/$zoneId/dns_records?name=$fqdn")
  n=$(jq '.result | length' <<<"$recs")
  recId="" recProxied=""
  (( n == 0 )) && return 0
  if (( n == 1 )) && [[ $(jq -r '.result[0].type' <<<"$recs") == CNAME ]] &&
     [[ $(jq -r '.result[0].content | ascii_downcase' <<<"$recs") == "$target" ]]; then
    recId=$(jq -r '.result[0].id' <<<"$recs"); recProxied=$(jq -r '.result[0].proxied' <<<"$recs"); return 0
  fi
  die "$fqdn already has other DNS records: $(jq -c '[.result[] | {type, content}]' <<<"$recs"). Remove them or pick --sub."
}

setProxied() { # true|false
  [[ $recProxied == "$1" ]] && return 0
  cfWrite PATCH "/zones/$zoneId/dns_records/$recId" "{\"proxied\":$1}" >/dev/null
  recProxied=$1; ok "DNS record proxied=$1"
}

ensurePagesEnabled() {
  refreshPages
  if (( pagesOn )); then
    ok "Pages enabled ($buildType, ${srcBranch:-workflow}${srcBranch:+ $srcPath})"
    # a Pages site has exactly one custom domain: taking it over would take the other site offline
    local current; current=$(jq -r '.cname // empty' <<<"$pagesJson")
    if [[ -n $current && $current != "$fqdn" ]] && (( ! replaceDomain )); then
      die "$owner/$repo is already served at $current. Setting $fqdn would take $current offline. Re-run with --replace-domain only if that is intended."
    fi
    return
  fi
  local branch path=""
  branch=$(gh api "repos/$owner/$repo" --jq .default_branch)
  srcBranch=$branch
  if   [[ -n $(repoFile index.html) ]]; then path="/"
  elif [[ -n $(repoFile docs/index.html) ]]; then path="/docs"
  else die "Pages is off and there is no index.html at / or /docs on $branch. Build-step apps: add an Actions Pages workflow first."; fi
  ghWrite POST "repos/$owner/$repo/pages" "$(jq -nc --arg b "$branch" --arg p "$path" '{build_type:"legacy", source:{branch:$b, path:$p}}')" \
    || die "Could not enable Pages (private repo on a free plan?)."
  ok "enabled Pages from $branch $path"
  (( dryRun )) && { buildType=legacy srcPath=$path; return; }
  refreshPages
}

ensureDns() {
  readRecord
  if [[ -z $recId ]]; then
    local body
    body=$(jq -nc --arg n "$fqdn" --arg c "$target" --arg m "GitHub Pages: $owner/$repo ($TAG)" \
      '{type:"CNAME", name:$n, content:$c, proxied:false, ttl:1, comment:$m}')
    recId=$(cfWrite POST "/zones/$zoneId/dns_records" "$body" | jq -r .result.id); recProxied=false
    ok "created CNAME $fqdn -> $target (DNS-only)"
  else
    ok "CNAME $fqdn -> $target exists (proxied=$recProxied)"
  fi
  # GitHub can only issue its certificate while it sees its own IPs, so stay grey until approved
  if ! { [[ $(certState) == approved ]] && certCovers; }; then setProxied false; fi
}

ensureCname() {
  if [[ $(jq -r '.cname // empty' <<<"$pagesJson") != "$fqdn" ]]; then
    ghWrite PUT "repos/$owner/$repo/pages" "$(jq -nc --arg c "$fqdn" '{cname:$c}')"
    ok "Pages custom domain set to $fqdn"
    (( dryRun )) || refreshPages
  else
    ok "Pages custom domain already $fqdn"
  fi
  if [[ $buildType == legacy && -n $srcBranch ]]; then
    ensureRepoFile "$(joinPath "$srcPath" CNAME)" "$fqdn" "Serve at $fqdn"
    if [[ -z $(repoFile "$(joinPath "$srcPath" _config.yml)") ]]; then
      ensureRepoFile "$(joinPath "$srcPath" .nojekyll)" "" "Add .nojekyll (plain static site)"
    fi
  fi
}

# Removing and re-adding the custom domain is GitHub's only "retry issuance" button
kickCert() {
  (( kicked )) && die "certificate still '$1' after re-adding the domain. Check DNS-only + https://github.com/$owner/$repo/settings/pages"
  warn "certificate $2 – re-adding the custom domain to restart issuance"; kicked=1
  ghWrite PUT "repos/$owner/$repo/pages" '{"cname":null}'; sleep 5
  ghWrite PUT "repos/$owner/$repo/pages" "$(jq -nc --arg c "$fqdn" '{cname:$c}')"
}

waitForCert() {
  (( dryRun )) && return 0
  local start=$SECONDS since=$SECONDS last="" state
  kicked=0
  while :; do
    refreshPages; state=$(certState)
    if [[ $state != "$last" ]]; then log "certificate: $state"; last=$state; since=$SECONDS; fi
    if [[ $state == approved ]] && certCovers; then ok "certificate approved for $fqdn"; return 0; fi
    case $state in
      errored|bad_authz|authorization_revoked|destroy_pending) kickCert "$state" "is '$state'"; since=$SECONDS ;;
      none|new) (( SECONDS - since > CERT_STALL_SEC )) && { kickCert "$state" "never started ($state for $(( (SECONDS - since) / 60 )) min)"; since=$SECONDS; } ;;
    esac
    if (( ! wait )) || (( SECONDS - start > CERT_TIMEOUT_SEC )); then
      warn "certificate not ready yet ($state). Re-run the same command later to finish."; exit 3
    fi
    sleep "$POLL_SEC"
  done
}

ensureHttps() {
  if [[ $(jq -r '.https_enforced' <<<"$pagesJson") == true ]]; then ok "HTTPS already enforced"; return; fi
  local i
  for i in 1 2 3 4 5 6; do
    if ghWrite PUT "repos/$owner/$repo/pages" "$(jq -nc --arg c "$fqdn" '{cname:$c, https_enforced:true}')" 2>/dev/null; then
      ok "HTTPS enforced"; return
    fi
    sleep 20
  done
  die "GitHub refused https_enforced. Check the certificate in repo Settings > Pages."
}

verifyLive() {
  (( dryRun )) && return 0
  log "verifying https://$fqdn"
  local i res code headers
  for i in $(seq 1 12); do
    res=$(curl -sS -o /dev/null -L --max-redirs 5 --doh-url "$DOH_URL" -w '%{http_code}' "https://$fqdn/" 2>/dev/null) || res=000
    [[ $res == 200 ]] && break; sleep 10
  done
  [[ $res == 200 ]] || die "https://$fqdn/ returned $res (redirect loop? SSL mode is '$sslMode')."
  ok "https://$fqdn/ -> 200"
  headers=$(curl -sSI --doh-url "$DOH_URL" "https://$fqdn/")
  if (( proxy )); then
    grep -qi '^server: cloudflare' <<<"$headers" && ok "served through Cloudflare" || warn "no 'server: cloudflare' header yet (proxy propagating?)"
  fi
  code=$(curl -sS -o /dev/null --doh-url "$DOH_URL" -w '%{http_code}' "http://$fqdn/" 2>/dev/null) || code=000
  [[ $code =~ ^30[178]$ ]] && ok "http:// redirects to https ($code)" || warn "http:// returned $code"
  code=$(curl -sSI "https://$target/$repo/" 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')
  [[ $code == *"$fqdn"* ]] && ok "$target/$repo/ redirects to $fqdn" || warn "github.io URL redirect: ${code:-none yet}"
}

showStatus() {
  readRecord; refreshPages
  local pages="disabled"; (( pagesOn )) && pages="$buildType ${srcBranch:-} ${srcPath}"
  printf '%-15s %s\n' repo "$owner/$repo" fqdn "$fqdn" zone "$domain" ssl_mode "$sslMode" \
    dns "${recId:+CNAME -> $target, proxied=$recProxied}${recId:-none}" \
    pages "$pages" \
    pages_cname "$(jq -r '.cname // "none"' <<<"$pagesJson")" \
    certificate "$(certState)" \
    https_enforced "$(jq -r '.https_enforced // false' <<<"$pagesJson")"
}

removeAll() {
  refreshPages; readRecord
  if [[ $(jq -r '.cname // empty' <<<"$pagesJson") == "$fqdn" ]]; then
    ghWrite PUT "repos/$owner/$repo/pages" '{"cname":null}'; ok "removed Pages custom domain"
  fi
  if [[ $buildType == legacy && -n $srcBranch ]]; then
    local p cur; p=$(joinPath "$srcPath" CNAME); cur=$(repoFile "$p")
    if [[ -n $cur ]]; then
      ghWrite DELETE "repos/$owner/$repo/contents/$p" "$(jq -nc --arg s "${cur%%$'\t'*}" --arg b "$srcBranch" '{message:"Remove custom domain", sha:$s, branch:$b}')"
      ok "deleted $p"
    fi
  fi
  if [[ -n $recId ]]; then cfWrite DELETE "/zones/$zoneId/dns_records/$recId" >/dev/null; ok "deleted DNS record $fqdn"; fi
}

# ─── Args ───
while (( $# )); do
  case $1 in
    --domain) domain=${2:?}; shift ;;
    --sub) sub=$(sanitizeLabel "${2:?}"); shift ;;
    --no-proxy) proxy=0 ;;
    --no-wait) wait=0 ;;
    --status) mode=status ;;
    --remove) mode=remove ;;
    --replace-domain) replaceDomain=1 ;;
    --dry-run) dryRun=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) repoArg=$1 ;;
  esac
  shift
done

# ─── Init ───
for bin in gh jq curl base64; do command -v "$bin" >/dev/null || die "missing $bin"; done
gh auth status >/dev/null 2>&1 || die "gh is not authenticated (gh auth login)."
loadToken
resolveRepo
resolveZone

case $mode in
  status) showStatus; exit 0 ;;
  remove) log "removing $fqdn from $owner/$repo"; removeAll; exit 0 ;;
esac

log "$owner/$repo -> https://$fqdn (zone ssl mode: $sslMode)"
if (( proxy )) && [[ $sslMode == off || $sslMode == flexible ]]; then
  die "Zone SSL/TLS mode is '$sslMode': a proxied GitHub Pages site would redirect-loop. Set it to Full (strict) in the Cloudflare dashboard (SSL/TLS > Overview), or re-run with --no-proxy."
fi
[[ $sslMode == unknown ]] && warn "could not read SSL mode (token lacks Zone Settings:Read?); make sure it is Full or Full (strict)"

ensurePagesEnabled
ensureDns
ensureCname
waitForCert
ensureHttps
if (( proxy )); then setProxied true; else setProxied false; ok "DNS-only (--no-proxy)"; fi
verifyLive
log "done: https://$fqdn"
