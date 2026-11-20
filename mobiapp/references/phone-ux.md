# Phone UX checklist (with the fix for each)

## Feels native

- Installable PWA: `manifest.webmanifest` (standalone, maskable 512 icon, apple-touch-icon 180), service
  worker with **network-first HTML** (a deploy shows up at once) and cache-first assets; cache only the app
  shell as `index.html` (not `admin.html` or error pages). Every new shared JS file goes into the precache
  list with a `?v=N` and the cache name is bumped.
- Bottom tab bar with badges, iOS-style large titles, sheets with a dimmed scrim and swipe-down to close,
  press feedback, a light haptic tick (`navigator.vibrate(8)` where allowed), no text selection on chrome,
  `overscroll-behavior: none`.
- Fill the screen in portrait and landscape; desktop gets a landing page (phone frame + big QR + steps)
  that prints on one A4 landscape sheet.

## Install

| Situation | What to show |
|---|---|
| iPhone Safari | banner on every launch (dismissible) + step guide "Share -> Add to Home Screen"; a tiny install link stays under the main button |
| In-app browser (WhatsApp, Instagram, Messenger, Facebook) | "Open in Safari / Chrome first" + Copy link button |
| Android Chrome with `beforeinstallprompt` | native prompt from the button |
| Android other browsers | per-browser steps (Chrome, Samsung Internet, Firefox, Edge) |
| Installed iOS app | separate storage: manifest `start_url` carries `?e=` + a one-day restore code |

## Touch

- **Tap opens an overlay on `pointerup` -> the click that follows lands on the new scrim and closes it.**
  Record `sheetAt = performance.now()` when opening and ignore scrim clicks within 400 ms (or open on
  `click`). Desktop mouse never reproduces it.
- Canvas graph: `touch-action: none` on the canvas; track pointers in a `Map`; two pointers = pinch (keep
  the world point between the fingers fixed); one pointer on empty space pans when zoomed; double tap on
  empty space toggles zoom; wheel zooms on desktop. Hit-test in world coordinates with the drawn radius.
- When zooming a dense graph, spread nodes apart (distances x Z, circles x Z^0.25) and push apart
  circles that still overlap on screen, so taps hit one person.

## Photos

- Avatar: crop to a square in the browser and save a 320 px JPEG at quality 0.8 (15-30 KB).
- Hero/couple photo: a cropper where the user drags and pinches inside a fixed 4:3 window; the window is
  always filled, part of the photo may stay outside; the saved image is exactly what shows. Offer
  "no photo" as a real choice.
- Demo mode keeps photos as data URLs in localStorage; when storage is full, drop photos, keep people.

## Forms and live updates

- Background refreshes (window focus, `storage` events, WebSocket) keep what the user is typing: remember
  the last value shown and skip fields whose value differs from it.
- Errors show next to the form that caused them; a message area hidden in some mode is a silent failure.
- Saves are idempotent and retried on no connection, 429 and 5xx with backoff; unsent chat text returns
  to the input on failure.
- New-message pill stays until tapped, closed, or the chats open; also for messages already waiting at
  registration.

## Words

- Polish first, `T = { pl, en }` with a `tr()` helper (a file full of local `t` variables breaks `t()`).
- Required fields only where the product needs them (name + two core answers); the rest optional and
  skippable; hosts skip the questions that make no sense for them (the bride is not asked whose guest
  she is) and get their side filled in.
- The real product never says demo or mockup; the demo says what it is once, in one note, with a way out.
