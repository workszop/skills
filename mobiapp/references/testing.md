# Testing a phone-first live app

## Order for any change

1. Local static server: `python3 -m http.server 8791` in the repo (any free port).
2. Browser probe from [../scripts/probe-template.mjs](../scripts/probe-template.mjs): copy it to the
   scratchpad, add checks, run with `node probe.mjs http://localhost:8791/`.
3. API change: local `wrangler dev` on a fresh `--persist-to` dir, throwaway event, curl the new route and
   its refusals (see [backend.md](backend.md)).
4. Re-run earlier probes (non-demo login still shows, demo app <-> demo panel sync, original feature).
5. Ship (`/ship`), then `scripts/event-check.sh` against production.

## Probe rules

- Playwright: the template imports `playwright` (or the absolute path in `PLAYWRIGHT=/…/playwright/index.mjs`,
  so no project install is needed) and launches the system Chrome given in `CHROME` (default
  `/usr/bin/google-chrome`; an empty `CHROME=` uses Playwright's own browser).
- **Two contexts per UI feature**: desktop (`viewport 1280x900`, mouse) and phone (`390x844`,
  `hasTouch: true, isMobile: true, deviceScaleFactor: 3`). Use `page.touchscreen.tap()` on the phone.
- Pinch: `context.newCDPSession(page)` + `Input.dispatchTouchEvent` with two touch points moving apart.
- Fake every API call with `context.route(/<api-host>/, ...)`; log the bodies you receive so the probe
  can assert what the app sent (e.g. join without a role after `role_taken`).
- Read state through the page's globals (`page.evaluate(() => ({ Z, demoRole, ... }))`) and DOM classes
  (`#sheet.open`), not screenshots; screenshot only for layout questions (one line or two, does it fit
  at 320 px).
- Click targets: compute a node's screen point from world coords (`r.left + (n.x*Z+PX)*r.width/W`).
- Collect `pageerror` and fail on any.

## Debugging a "tap does nothing"

1. Reproduce with mouse and with touch; if only touch fails, suspect the follow-up click.
2. Log `pointerdown/pointerup/click` on the element and a `MutationObserver` on the overlay's class:
   "open" followed by "closed" within one tap = the click landed on the scrim.
3. Check `touch-action`, pointer capture, and leftover entries in any pointer `Map` (a stale pointer
   turns every tap into a pinch).

## Local API pitfalls

- A previous `wrangler dev` left `workerd` running: the health check answers, but with old code and a
  deleted state folder (`SQLITE_CANTOPEN`, `internal_error`). `ps -eo pid,args | rg '[w]orkerd'`, kill by
  PID, start again on a fresh `--persist-to` directory.
- `pkill -f <pattern>` inside the same Bash call matches its own shell and kills it (exit 144). Bracket the
  first character (`[w]orkerd`) and run cleanup last.
