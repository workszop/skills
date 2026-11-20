---
name: mobiapp
description: Use when building, extending or fixing a phone-first web app that real people use live - guests or participants join by QR or link, see each other, chat, and an organiser or host panel manages the event - especially an installable PWA on iPhone/Android with a Cloudflare Worker + Durable Object backend, a demo mode, and live events that must not lose data. Also when a tap does nothing on a phone but works with the mouse, an install banner/manifest misbehaves on iOS, a role or admin link leaked, or a deploy could touch live event data. Triggers on "mobiapp", "mobile app", "aplikacja na telefon", "apka na wydarzenie", "event app", "wedding app", "guest app", "PWA", "install on iPhone", "panel organizatora".
---

# mobiapp – phone-first live event apps

## Overview

Learned from Bee Talk (bee-talk.app): a wedding guest app that went from mockup to a live product with
real guests in three days, while features kept shipping.

**Core principle: once a real event exists, every change is a change to a live system.** The app's look
can change freely; event data, guest logins and role ownership must survive every deploy, and that is
checked after every deploy, not assumed.

Start a new app with your general web-app conventions (and `webapp` / brand skills if installed); this skill
adds what is specific to phones, live backends and live events. Use `/ship` for "commit, deploy" if you have it.

## Architecture that worked

| Part | Choice | Why |
|---|---|---|
| App | one `index.html` (+ `admin.html` panel, shared sibling `demo.js`) | no build step; shared code in a sibling file, never copied between pages |
| Hosting | Cloudflare Worker with static assets on a custom domain, Workers Builds on push to main (GitHub Pages as a second origin is fine) | ~30 s deploy, one domain for cookies/storage |
| API | separate Worker, **one Durable Object per event** (SQLite), REST + one hibernating WebSocket per phone | no polling: 200 phones stay inside the free tier; "delete event" = `deleteAll()` |
| Modes | no `?e=` = demo (fake backend on localStorage); `?e=<slug>` = live backend | same UI, swappable backend object |
| Panel | `admin.html?e=<slug>` + host code; `admin.html` alone = operator form; `admin.html?demo=1` = demo panel | one page, three audiences, decided by the URL |

Details, routes and auth: [references/backend.md](references/backend.md).

## Live-data rules (non-negotiable once an event exists)

1. **Additive server changes only.** New routes and nullable columns with defaults; never rename or drop a
   column, storage key, DO class name, binding or migration tag. Never rename the phone's login keys in
   localStorage (`tt_token_<slug>`-style); demo code touches only demo keys.
2. **After every deploy**, run the read-only check and report names and guest counts:
   `bash <skill-dir>/scripts/event-check.sh <api-base> <dir-with-.event-*.secret>`.
   Checks of a live event only read (GET). No "hidden test guest", no test messages: anything written to
   a real event shows up on the guests' phones. Writes are tested on a local or throwaway event.
3. **Destructive actions** (delete event, remove guest, rotate a code) only when the user asked for that
   specific item; re-read its name and guest count in the same command, right before the DELETE, and abort
   on mismatch.
4. **Secrets** live in gitignored, mode 600 `worker/.event-<name>.secret` files (slug, host code). Never
   print a host code or a link that contains it in chat: put it on the clipboard (`wl-copy`) and in a
   `.secret` file. A backup copy must also end in `.secret` or git will see it.
5. **API deploys are manual** (`cd worker && npx wrangler deploy`) and need the user's explicit "deploy";
   the permission classifier blocks a production deploy the user did not ask for. Commit and push first.

## Roles and links

- Exactly one holder per special role (bride, groom, host). A held role **cannot be taken** with the role
  link (409 `role_taken`); only the panel moves a role (`PUT /admin/guests/:id {role}`). The earlier
  "link takes the role over" design let a forwarded link make the wrong person groom.
- Role links put the host code in the **hash** (`#role=groom&code=…`), stripped with
  `history.replaceState` on load. Anyone holding one can open the panel, so it goes to one person
  privately; if it leaks, rotate the code (operator route) and send a new link.
- Link shapes: guest `https://<site>/?e=<slug>`; host role `https://<site>/?e=<slug>#role=groom&code=<url-encoded host code>`;
  panel `https://<site>/admin?e=<slug>` (code typed at login). Build them from the event's `.secret` file.
- The guest link (`?e=<slug>`) never changes when the host code is rotated. Rotation logs out open panels
  (next request answers `bad_code`) and kills old role links; tell the hosts the new code.
- Moving or removing a role, removing a guest and rotating a code count as destructive (rule 3): only on an
  explicit request for that person or event, re-read just before.
- Delivering a secret link: `wl-copy` plus a `.secret` file. No `wl-copy` (remote, non-Wayland): write only
  the `.secret` file and give its path.

## Phone UX that real users hit

Full list with code: [references/phone-ux.md](references/phone-ux.md). The ones that cost a fix:

- **A tap that opens a sheet on `pointerup` closes it at once on touch**: the synthetic click lands on the
  scrim that just appeared. Ignore scrim clicks for 400 ms after opening. Mouse tests never show it.
- iPhone Safari cannot hide its address bar; only the Home Screen app can. Show an install guide on every
  launch (dismissible), with "open in Safari/Chrome first" for in-app browsers (WhatsApp, Instagram,
  Messenger) and Android's `beforeinstallprompt` when present.
- The installed iOS app has **its own storage**: serve the manifest from the API with a `start_url` that
  carries the event and a one-day restore code, never the login token.
- Background refreshes (focus, storage, WebSocket) must not overwrite a field the user is typing in.
- No "demo/mockup" wording on the real product; link-preview (`og:`) tags describe the app.
- A date-like value styled as a stat reads as the event date; secondary facts (auto-erase date) go as one
  plain line next to the action they belong to.

## Testing

[references/testing.md](references/testing.md) and the template
[scripts/probe-template.mjs](scripts/probe-template.mjs):

- Headless Playwright with **two contexts: desktop mouse and phone `hasTouch`**; a feature is done only
  when both pass. Pinch via CDP `Input.dispatchTouchEvent`.
- Fake the API with `context.route()` so browser tests never write to the live server.
- API changes: `wrangler dev --persist-to <fresh dir> --var MASTER_KEY:test` on a throwaway event. A
  leftover `workerd` from an earlier run keeps the port and serves old code: check `ps`/`ss -ltnp` first
  and kill by PID.
- Demo app + demo panel in **one** browser context (they share localStorage).
- After a feature, re-run the earlier probes (original behaviour, non-demo login).

## Common mistakes

| Mistake | Instead |
|---|---|
| Copying helpers or demo data into the second page | shared `demo.js` / `app.js` both pages load; add it to the service worker list and bump the cache |
| "Deployed" after `git push` when the API changed | push deploys the site only; the API Worker needs `wrangler deploy` |
| Verifying a touch feature with mouse clicks | phone context with `hasTouch`, real `touchscreen.tap` |
| Role takeover by link | role lock + panel route |
| Operator "create event" form visible in the host's panel | show it only on bare `admin.html` with no event open |
| Deleting test events from memory notes | an event the user once called a testing ground is deleted only on an explicit request for it |
