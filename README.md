# skills
collection of useful skills

| Skill | What it does |
|---|---|
| [md2web](md2web/) | Turns a Markdown file into a polished, self-contained HTML page or an A4 PDF, with a live editor, formatting panel, live reload on save (`--watch`) and Linux "Open with md2web" desktop integration. |
| [desktop-app](desktop-app/) | Makes a script, CLI or local web tool feel like a Linux desktop app: `.desktop` launcher, "Open with" for a file type, custom panel icon for Chrome `--app` windows on Wayland, live reload of a `file://` page from a background watcher, plus `wl-toplevels.py` to read window app_ids. |
| [page-agent](page-agent.md) | Adds a PageAgent-style in-browser AI assistant panel to static or app-backed websites. |
| [mobiapp](mobiapp/) | Phone-first web apps for live events (guests join by QR, see each other, chat; a host panel manages the event): installable PWA on iPhone/Android, Cloudflare Worker + one Durable Object per event, demo mode, host roles and links, touch pitfalls, and rules that keep live event data safe across deploys. Includes a desktop+phone Playwright probe template and a read-only post-deploy event check. |

## Install

Copy or symlink a skill folder into `~/.claude/skills/`, e.g.

```bash
git clone https://github.com/workszop/skills.git
ln -s "$PWD/skills/md2web" ~/.claude/skills/md2web
```
