---
name: pages-subdomain
description: Use when a GitHub repo's web app should be served at its own subdomain (repo.domain.com, default domain warsztaty-ai.com) via GitHub Pages behind Cloudflare - "serve this repo on a subdomain", "put it on warsztaty-ai.com", "custom domain for GitHub Pages", "Cloudflare CNAME to github.io", "podepnij repo pod subdomenę". Also when such a site shows ERR_TOO_MANY_REDIRECTS, a GitHub Pages certificate stuck or "not yet available", 404 on assets after moving off github.io/repo/, or the subdomain needs removing.
---

# pages-subdomain

## Overview

GitHub Pages serves, Cloudflare masks: `sub.domain` is a CNAME to `<owner>.github.io`, first
**DNS-only** so GitHub can issue its Let's Encrypt cert, then **proxied** once the cert is
approved. `scripts/pages-subdomain.sh` does every API step idempotently from live state; your
job is the repo audit and the judgment calls around it.

## Prerequisites

- `gh` logged in as the repo owner/admin; `jq`, `curl`.
- Cloudflare **API token** (40+ chars, NOT the 32-char token ID) in `CF_DNS_API_TOKEN` (the script
  also reads the `export` line from `~/.bashrc`, since agent shells are non-interactive). Custom
  token, zone-scoped: **Zone:Read, DNS:Edit, Zone Settings:Read**. Never name it
  `CLOUDFLARE_API_TOKEN` – wrangler picks that up and stops using its OAuth login.
- Never print, echo or paste the token.

## Workflow

1. **Audit the app for sub-path assumptions.** On github.io it lived at `/<repo>/`; on the
   subdomain it lives at `/`. Use the user's local clone if there is one (`git pull` first), else
   `gh repo clone owner/repo <scratchpad>/repo -- --depth 1`. Then:
   `bash scripts/audit-paths.sh <dir> <repo>` → exit 2 = hits. Fix each one: `/<repo>/x` → `/x` or
   relative `x`, `<base href="/">`, bundler `base: '/'`, manifest `start_url`/`scope` → `/`, SW
   scope, `og:url`/canonical → the new URL. Commit + push **before** step 2, and if a build step
   exists confirm the Actions run succeeded (`gh run list -L1`).
2. **Run the script** (≈2-20 min, mostly waiting for GitHub's cert; run it in the background):
   `bash scripts/pages-subdomain.sh owner/repo [--sub name] [--domain d]`
   Exit **3** = cert still pending → re-run the same command later; it resumes.
3. **Verify in a browser** (the script already checks 200, `server: cloudflare`, http→https,
   github.io → subdomain redirect): open `https://sub.domain`, check the console for 404s.
4. Report the URL and any repo commits the script made (CNAME, `.nojekyll`) so the user pulls.

## Quick reference

| Need | Command |
|---|---|
| Current state, no changes | `pages-subdomain.sh owner/repo --status` |
| Preview mutating calls | `... --dry-run` |
| Keep grey cloud (no proxy) | `... --no-proxy` |
| Undo (Pages cname + DNS + CNAME file) | `... --remove` |
| Other zone | `... --domain example.org` (token must cover it) |
| Change the default zone | `export PAGES_SUBDOMAIN_DOMAIN=example.org` |

## What the script decides for you

- Pages off → enables legacy build from default branch `/` (or `/docs`); no `index.html` → stops
  (build-step apps need an Actions Pages workflow first).
- Existing record for the name that is not `CNAME → owner.github.io` → stops, never overwrites.
- Repo already has a different custom domain → stops (one domain per Pages site; switching takes
  the old one offline). `--replace-domain` only after the user confirms.
- Zone SSL mode `off`/`flexible` + proxy → stops: proxied + GitHub's HTTPS redirect loops forever.
  Tell the user to set **Full (strict)** in the dashboard (zone-wide – ask, it affects other sites),
  or use `--no-proxy`. The token can't change it, by design.
- Cert `errored`/`bad_authz`, or still `none` after 10 min (`CERT_STALL_SEC`) → re-adds the custom
  domain once to restart issuance. GitHub sometimes never starts issuing until this nudge.

## Common mistakes

| Symptom | Cause / fix |
|---|---|
| `Invalid format for Authorization header` | Saved the token ID (32 chars), not the secret. Roll the token. |
| `/user/tokens/verify` → "Invalid API Token" | Account-owned token (`cfat_…`); verify at `/accounts/<id>/tokens/verify`. |
| `ssl mode: unknown` | Token lacks Zone Settings:Read; script continues, the live check catches a loop. |
| `ERR_TOO_MANY_REDIRECTS` | Zone SSL mode Flexible. Full (strict). |
| Cert never issues | Record was proxied while GitHub validated. `--status`; the script unproxies until approved. |
| Page loads, assets 404 | Skipped the audit; hardcoded `/<repo>/` paths. |
| Old content after setup | Not DNS – see the GitHub Pages stale-build checklist (`pages/builds/latest`). |
| Cert renewal fails months later | Re-run the script with `--no-proxy`, wait for approval, re-run without it. |

Optional hardening: verify the apex in GitHub (Settings → Pages → Verified domains, TXT
`_github-pages-challenge-<owner>.<domain>`) so no other account can claim a subdomain.
