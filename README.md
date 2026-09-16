# skills
collection of useful skills

| Skill | What it does |
|---|---|
| [md2web](md2web/) | Turns a Markdown file into a polished, self-contained HTML page or an A4 PDF, with a live editor, formatting panel, live reload on save (`--watch`) and Linux "Open with md2web" desktop integration. |
| [desktop-app](desktop-app/) | Makes a script, CLI or local web tool feel like a Linux desktop app: `.desktop` launcher, "Open with" for a file type, custom panel icon for Chrome `--app` windows on Wayland, plus `wl-toplevels.py` to read window app_ids. |
| [page-agent](page-agent.md) | Adds a PageAgent-style in-browser AI assistant panel to static or app-backed websites. |

## Install

Copy or symlink a skill folder into `~/.claude/skills/`, e.g.

```bash
git clone https://github.com/workszop/skills.git
ln -s "$PWD/skills/md2web" ~/.claude/skills/md2web
```
