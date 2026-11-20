# Backend: Cloudflare Worker + one Durable Object per event

## Layout

```
index.html  admin.html  demo.js  sw.js  manifest.webmanifest  icons/
wrangler.jsonc        # site Worker: { "name": "<app>", "assets": { "directory": "." } }
.assetsignore         # .git, worker, *.secret, .dev.vars, mockups, plans, ... (same list as .gitignore)
worker/
  wrangler.jsonc      # API Worker: main src/index.js, durable_objects binding ROOM -> class EventRoom,
                      # migrations [{tag:"v1", new_sqlite_classes:["EventRoom"]}], vars APP_URLS, ALLOWED_ORIGINS
  src/index.js
  .master-key.secret  .event-<name>.secret        # gitignored, chmod 600
```

- Workers Builds is connected to the **site** Worker only. Connected to the API Worker, the build reads
  the root `wrangler.jsonc` and offers a rename that would deploy the site over the API; only the user can
  change that in the dashboard.
- `APP_URLS` lists every address the app is served from (first = default for links). Their origins are
  the CORS allowlist; a new domain that is not listed fails silently on every API call.
- Login tokens are per origin: guests who joined on github.io must re-join on the custom domain.

## Routes (all under `/api/e/:slug`)

| Route | Who | Notes |
|---|---|---|
| `GET /event` | anyone | names, date line, guest count, photo version: the read-only health check |
| `POST /join {name, answers, token, role?, code?}` | phone | the phone generates `token` and repeats the same join until confirmed, so a lost reply never makes a second guest |
| `GET/PUT/DELETE /me` | guest token | delete = erase my data |
| `POST /me/role {role, code}` | guest token | 409 `role_taken` while someone else holds it |
| `POST /me/restore` -> `{code}`, `POST /restore` | installed app | one-day code for the manifest `start_url`; the token never goes in a URL |
| `GET /manifest?r=` | anyone | per-event manifest so the installed app opens this event |
| `GET /ws` | guest token in `Sec-WebSocket-Protocol` | hibernating; `setWebSocketAutoResponse('ping','pong')` keeps it alive without waking the object |
| `GET/PUT/DELETE /admin`, `DELETE/PUT /admin/guests/:id`, `PUT/DELETE /admin/photo` | host code (Bearer) | the host sees who joined, never private messages |
| `POST /api/admin/events {names, dateLine, adminCode?}` | operator `MASTER_KEY` | returns slug + host code once; `adminCode` reuses a chosen code |
| `POST /api/admin/events/:slug/code {adminCode?}` | operator | rotates the host code; old code and links with it stop working |

## Auth details that mattered

- Host code: store only `sha256(code)`; normalise (uppercase, strip non-alphanumerics) before hashing.
- **The right code always works**; count only wrong codes per IP and answer 429 after the limit. The
  whole venue shares one IP, so a lockout lets any guest shut the hosts out.
- Join limit per IP above the guest cap (shared Wi-Fi). Guest cap enforced in `/join` (`event_full`).
- Accept only JSON objects as bodies; validate names with a Unicode-letter regex and length cap.
- `announce(guest)` broadcasts a changed card to everyone except that guest; that guest's own phone
  learns its new role on the next `/me` (app reopen).

## Data lifecycle

- Purge alarm: the DO sets an alarm (e.g. 60 days after creation) that runs `deleteAll()`; the panel shows
  the date as plain text by the delete button.
- Removing a guest deletes their messages, sessions, restore codes and avatar, then broadcasts `gone`
  and closes their sockets (`ws.close(4002)`); the phone gets 401 and starts a fresh join.
- Schema changes: `CREATE TABLE IF NOT EXISTS` in an `extraTables()` run from `ready()`, so events made
  before the change gain the table on first touch. Unused columns stay (comment why).

## Local test recipe

```bash
cd worker
npx wrangler dev --port 8799 --var MASTER_KEY:testkey --persist-to "$SCRATCH/wr-$RANDOM" &
# create a throwaway event, join with curl, exercise the new route, check refusals (bad role, bad code, unknown id)
ps -eo pid,args | rg '[w]orkerd serve' | awk '{print $1}' | xargs -r kill   # cleanup by PID; never pkill -f in the same shell
```
