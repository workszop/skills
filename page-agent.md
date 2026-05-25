---
name: add-page-agent
description: "Add a PageAgent-style in-browser AI assistant panel to static or app-backed websites. Use when Codex needs to embed, adapt, theme, or troubleshoot a browser agent like github.com/workszop/agent: self-hosted page-agent bundle, OpenAI-compatible LLM proxy, DOM-reading/clicking/form-filling behavior, floating assistant panel, optional silent/collapsible history UI, or page-agent verification."
---

# Add Page Agent

## Workflow

1. Inspect the target site first.
   - Find the served static asset location, main HTML entry, app shell, and build tooling.
   - Preserve existing user edits and site styling.
   - Prefer inserting the agent near the end of `<body>` after the site's own UI.

2. Provide or build `page-agent.bundle.js`.
   - If the source repo already has a vetted bundle, copy it into the target site's public/static asset path.
   - If rebuilding, use an IIFE bundle so it exposes `window.PageAgent` and works from a plain `<script>` tag.
   - Keep API credentials out of frontend code. Use a proxy that exposes an OpenAI-compatible chat completions endpoint and injects provider secrets server-side.

3. Add the minimal bootstrap.
   - Load the bundle before the initializer.
   - Create the agent on `DOMContentLoaded`.
   - Store the instance on `window` when useful for debugging or custom triggers.
   - Call `agent.panel.show()` if the panel should be visible immediately.
   - The `workszop/agent` site used this Cloudflare Worker endpoint for the OpenAI-compatible proxy: `https://agent.andrzey-jankowski.workers.dev/`. Reuse it only when the user explicitly wants that existing proxy; otherwise replace it with the target project's proxy endpoint.

```html
<script src="./page-agent.bundle.js"></script>
<script>
  window.addEventListener('DOMContentLoaded', () => {
    const agent = new PageAgent({
      model: 'gemini-3.1-flash-lite-preview',
      baseURL: 'https://agent.andrzey-jankowski.workers.dev/',
      apiKey: 'unused-by-proxy',
      language: 'en-US',
    });

    window.pageAgent = agent;
    agent.panel.show();
  });
</script>
```

4. Theme only after the minimal load works.
   - Prefer stable selectors first: `#page-agent-runtime_agent-panel` and `#playwright-highlight-container`.
   - Treat hashed class selectors from the bundle as version-specific. Recheck them in the browser or bundle before relying on them.
   - Avoid changing the target site's own controls into accidental agent controls.

Place a `<style id="page-agent-theme">` block **before** the bundle `<script>` tag:

```html
<style id="page-agent-theme">
  #playwright-highlight-container { display: none !important; }

  #page-agent-runtime_agent-panel {
    font-family: 'Inter', sans-serif !important;
    --color-1: #F97316 !important;
    --color-2: #EA670D !important;
    --color-3: #F97316 !important;
    --color-4: #FB923C !important;
    --border-radius: 0px !important;
    --height: 48px !important;
  }

  /* hashed class — re-verify after any bundle upgrade */
  ._wrapper_gtdpc_1 {
    border: 1px solid rgba(249,115,22,0.3) !important;
    border-radius: 0 !important;
    background: rgba(15,23,42,0.95) !important;
    backdrop-filter: blur(16px) !important;
  }
</style>
```

Keep `!important` scoped to agent selectors — the bundle injects its own CSS. Adapt `--color-*` and `font-family` to the target site's design system. If a hashed selector breaks after a bundle upgrade, open DevTools → Elements, find `#page-agent-runtime_agent-panel`, and read the new class from the DOM; or search `page-agent.bundle.js` for `var N={` to find the CSS module map.

5. Add optional product behavior.
   - Use `agent.execute('task')` from site buttons to launch preset tasks.
   - Mark custom overlays or non-content wrappers with `data-page-agent-not-interactive="true"` when they should not be considered page controls.
   - Add the quiet feedback pattern when the product should suppress PageAgent's constant step-by-step feedback: hide history by default, remove the stop/close button, block auto-expansion, and expose a small "steps" toggle with a badge.

## Quiet Feedback Pattern

Use this after `agent.panel.show()` when the PageAgent panel should stay compact during execution:

```js
let historyOpen = false;

function setupQuietAgentPanel() {
  const wrapper = document.getElementById('page-agent-runtime_agent-panel');
  if (!wrapper) return false;
  if (wrapper.dataset.paSetup) return true;
  wrapper.dataset.paSetup = 'true';

  const controls = wrapper.querySelector('._controls_gtdpc_188');
  const historyWrap = wrapper.querySelector('._historySectionWrapper_gtdpc_246');
  const historySection = wrapper.querySelector('._historySection_gtdpc_246');
  if (!controls || !historyWrap) return true;

  historyWrap.style.setProperty('visibility', 'collapse', 'important');
  historyWrap.style.setProperty('padding-top', '0', 'important');
  if (historySection) historySection.style.setProperty('max-height', '0', 'important');

  const stopBtn = wrapper.querySelector('._stopButton_gtdpc_212');
  if (stopBtn) stopBtn.remove();

  const expandedClass = '_expanded_gtdpc_278';
  const expandObserver = new MutationObserver(() => {
    if (!historyOpen && wrapper.classList.contains(expandedClass)) {
      historyWrap.style.setProperty('visibility', 'collapse', 'important');
      historyWrap.style.setProperty('padding-top', '0', 'important');
      if (historySection) historySection.style.setProperty('max-height', '0', 'important');
    }
  });
  expandObserver.observe(wrapper, { attributes: true, attributeFilter: ['class'] });

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'pa-toggle-btn';
  toggleBtn.type = 'button';
  toggleBtn.title = 'Show or hide agent steps';
  toggleBtn.innerHTML = 'Steps<span class="pa-badge" id="paStepBadge" data-count="0"></span>';
  controls.insertBefore(toggleBtn, controls.firstChild);

  toggleBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    historyOpen = !historyOpen;
    toggleBtn.classList.toggle('pa-active', historyOpen);
    if (!wrapper.classList.contains(expandedClass)) wrapper.classList.add(expandedClass);
    historyWrap.style.setProperty('visibility', historyOpen ? 'visible' : 'collapse', 'important');
    historyWrap.style.setProperty('padding-top', historyOpen ? '8px' : '0', 'important');
    if (historySection) historySection.style.setProperty('max-height', historyOpen ? '400px' : '0', 'important');
  });

  const badge = document.getElementById('paStepBadge');
  const countObserver = new MutationObserver(() => {
    const count = historyWrap.querySelectorAll('._historyItem_gtdpc_297').length;
    if (badge) {
      badge.textContent = count || '';
      badge.dataset.count = count;
    }
  });
  countObserver.observe(historyWrap, { childList: true, subtree: true });

  return true;
}

if (!setupQuietAgentPanel()) {
  const bodyObserver = new MutationObserver(() => {
    if (setupQuietAgentPanel()) bodyObserver.disconnect();
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true });
}
```

Add `.pa-toggle-btn` styles near the PageAgent theme overrides. Recheck the hashed selectors if `page-agent.bundle.js` changes.

**Hashed selector fallback.** If `_controls_gtdpc_188`, `_historySectionWrapper_gtdpc_246`, etc. are missing after a bundle upgrade, `setupQuietAgentPanel` will silently bail at the `if (!controls || !historyWrap) return true` guard. To refresh: open DevTools → Elements, expand `#page-agent-runtime_agent-panel`, and read the new class names from the DOM; or search `page-agent.bundle.js` for `var N={` and map the new hash. Update the selectors in this function before deploying.

## Proxy Setup Pattern

Use when the target project needs its own OpenAI-compatible proxy (e.g. to use Gemini, Claude, or any provider that doesn't natively speak `/v1/chat/completions`, or to keep the API key server-side).

**Cloudflare Worker** (minimal, works for Gemini):

```js
// worker.js — deploy with: wrangler deploy
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    const body = await req.json();
    const upstream = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.GEMINI_API_KEY}`,
        },
        body: JSON.stringify(body),
      }
    );
    const data = await upstream.text();
    return new Response(data, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
```

Set the secret: `wrangler secret put GEMINI_API_KEY`

Then point PageAgent at the Worker URL:
```js
new PageAgent({ model: 'gemini-2.0-flash', baseURL: 'https://your-worker.workers.dev/', apiKey: 'unused' })
```

For OpenAI, Anthropic, or Ollama behind a backend: LiteLLM is the simplest compatibility layer — `litellm --model gemini/gemini-2.0-flash --port 4000` exposes a local `/v1/chat/completions` endpoint.

## Bundle Build Pattern

Use this when the target project does not already have a `page-agent.bundle.js`:

```bash
npm install page-agent zod esbuild
printf 'import { PageAgent } from "page-agent"; window.PageAgent = PageAgent;\n' > entry.js
npx esbuild entry.js --bundle --format=iife --outfile=page-agent.bundle.js --minify
```

Commit or deploy only the generated bundle and the site changes unless the target repo wants to own the build tooling.

## Verification

Run the target site through its normal local server when possible.

Check in the browser:
- `page-agent.bundle.js` returns 200 in Network.
- `typeof window.PageAgent === 'function'`.
- `document.getElementById('page-agent-runtime_agent-panel')` exists after `DOMContentLoaded`.
- The panel input accepts a task and does not overlap key site controls on desktop and mobile.
- With a working proxy, a simple page task can read visible content and interact with a demo button, input, or form.

If the panel loads but tasks fail, check console and network errors first: CORS, missing `model`/`baseURL`/`apiKey`, proxy shape, auth failures, model context limits, and oversized/hidden DOM.

**CSP-restricted sites.** If the panel never appears and DevTools Console shows `Content Security Policy` errors, add these directives to the site's HTTP headers (not a `<meta>` tag — CSP `<meta>` ignores `connect-src`):

```
Content-Security-Policy:
  script-src 'self' 'unsafe-inline';
  connect-src 'self' https://your-proxy.example.com;
  style-src 'self' 'unsafe-inline';
```

`unsafe-inline` is required because the bundle injects `<style>` tags at runtime. If the site uses nonces, the bundle cannot participate — `unsafe-inline` on the agent's origin is the practical path. Scope the rule to `'self'` only; don't open it globally. If the site is third-party and CSP cannot be changed, there is no workaround — page-agent cannot be embedded there.

## Reference

For source-derived selectors, customization snippets, and evidence from `github.com/workszop/agent`, read `references/workszop-agent-page-agent.md` when implementing or troubleshooting.
