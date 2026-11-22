# Gemini and OpenRouter Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Gemini and OpenRouter as their own API agents that run on the existing OpenAI-style agent loop next to Ollama.

**Architecture:** A pure module, `src/main/llmproviders.ts`, describes each API provider (address, key secret, model filtering, default model, context budget, error wording, headers). `main.ts` changes from one hardcoded `'local'` config to one config per provider id, and every place that special-cases `'local'` uses `isLlmAgent(id)` instead. The renderer draws one API card per provider, scoped by `data-llm-card`.

**Tech Stack:** Electron, TypeScript compiled by `tsc` to `.js` next to each `.ts`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-22-gemini-openrouter-agents-design.md`

## Global Constraints

- Agent ids: `local` (Ollama, unchanged), `gemini`, `openrouter`.
- Gemini base URL `https://generativelanguage.googleapis.com/v1beta/openai`; key page `https://aistudio.google.com/apikey`.
- OpenRouter base URL `https://openrouter.ai/api/v1`; key page `https://openrouter.ai/keys`; headers `HTTP-Referer: https://breezecode.site/`, `X-Title: Breeze Code`.
- Cloud context budget cap: 128000 tokens. OpenRouter uses min(model `context_length`, 128000).
- Ollama storage stays as is: state `llmUrl`, `llmModel`, `llmModels`, `llmOff`; secret `llmKey`. No migration.
- Cloud storage: state `llmProviders: { [id]: { model, models, contexts } }`; secrets `geminiKey`, `openrouterKey`.
- Commit fallback order: `antigravity`, `codex`, `claude`, then `local`, `gemini`, `openrouter`.
- A cloud agent is `found` when its key and model are saved; `sys:detect` makes no network call for it.
- Keys only go through `setSecret`. Never in state, logs or events.
- Card copy: Gemini sub "Free tier · needs a Google account"; OpenRouter sub "One key for hundreds of models · pay as you go". Usage line "Billed by Google" / "Billed by OpenRouter".

## Review Focus

1. **Existing Ollama user updates.** Saved server, model and key keep working with no reconnect (Task 2 test).
2. **Pasted key with spaces or a newline.** It is trimmed before saving and use (Task 2).
3. **Gemini free tier hits 429 mid-run.** The run ends with the friendly "free limit" text, not "status 429" (Task 1 test, Task 2 wiring).
4. **OpenRouter key with no credits (402)** or a model that drops tool support. The friendly credits text shows. Only tool-capable models are listed (Task 1 tests).
5. **Two API cards on one Setup screen.** Connecting Gemini doesn't bind or overwrite the Ollama card's key field (Task 4: each binding is scoped to its `data-llm-card`).

---

### Task 1: Provider registry module

**Files:**
- Create: `src/main/llmproviders.ts`
- Test: `test/llmproviders.test.js`

**Interfaces:**
- Produces (all exported):
  - `type LlmProviderId = 'local' | 'gemini' | 'openrouter'`
  - `LLM_PROVIDER_IDS: LlmProviderId[]` = `['local', 'gemini', 'openrouter']`
  - `interface LlmProvider { id: LlmProviderId; name: string; vendor: string; url: string | null; keyUrl: string | null; getUrl: string; keySecret: string; needsKey: boolean; sub: string; billedBy: string | null }`
  - `LLM_PROVIDERS: Record<LlmProviderId, LlmProvider>`. `local` keeps today's name, vendor and getUrl `https://ollama.com/download`, with url `null` (probed), keySecret `llmKey`, needsKey `false` and billedBy `null`.
  - `isLlmAgent(id: unknown): id is LlmProviderId`
  - `interface ModelList { models: string[]; contexts: Record<string, number> }`
  - `filterModels(provider: LlmProviderId, json: unknown): ModelList`. Throws `Error` when the list ends up empty. For `local`, keep today's message: "The server has no models yet. Download one first, for example: ollama pull llama3.1".
  - `defaultModel(provider: LlmProviderId, models: string[]): string`
  - `contextWindow(provider: LlmProviderId, o: { url: string; model?: string | null; contexts?: Record<string, number>; override?: number }): number`
  - `friendlyError(provider: LlmProviderId, status: number, body: unknown): Error`
  - `extraHeaders(provider: LlmProviderId): Record<string, string>`

- [ ] **Step 1: Write the failing tests** in `test/llmproviders.test.js`. Use the style of `test/agentbrain.test.js` (`require('../src/main/llmproviders')`).
  - `filterModels gemini keeps chat models and strips models/`: input `{ data: [{id:'models/gemini-2.5-flash'},{id:'models/gemini-2.5-pro'},{id:'models/text-embedding-004'},{id:'models/gemini-2.5-flash-preview-tts'},{id:'models/gemini-2.5-flash-image'},{id:'models/gemini-live-2.5-flash'}] }`. Expected `.models` is `['gemini-2.5-flash','gemini-2.5-pro']`.
  - `filterModels openrouter keeps tool models with their context`: input `{ data: [{id:'google/gemini-2.5-flash', context_length: 1048576, supported_parameters:['tools','temperature']},{id:'x/no-tools', context_length: 8000, supported_parameters:['temperature']}] }`. Expected models `['google/gemini-2.5-flash']` and contexts `{ 'google/gemini-2.5-flash': 1048576 }`.
  - `filterModels local reads data or models`: `{ models: [{name:'llama3.1'}] }` gives `['llama3.1']`.
  - `filterModels throws on an empty list`: `assert.throws(() => filterModels('gemini', { data: [] }))`.
  - `defaultModel gemini picks the newest flash`: `['gemini-2.0-flash','gemini-2.5-pro','gemini-2.5-flash','gemini-2.5-flash-lite']` gives `'gemini-2.5-flash'`. `['gemini-2.5-pro']` gives `'gemini-2.5-pro'`.
  - `defaultModel openrouter takes the first`: `['a/b','c/d']` gives `'a/b'`.
  - `contextWindow`:
    - local `http://127.0.0.1:11434/v1` gives 4096; local `http://127.0.0.1:1234/v1` gives 8192; local with `override: 32000` gives 32000.
    - gemini gives 128000; gemini with `override: 32000` still gives 128000.
    - openrouter with contexts `{m: 1048576}` gives 128000; `{m: 32768}` gives 32768; a missing model gives 128000.
  - `friendlyError`, each with `.message` matching:
    - gemini 429: `/free limit/i`
    - gemini 401 and 403: `/rejected the key/i` and `/aistudio\.google\.com\/apikey/`
    - openrouter 402: `/credits/i` and `/openrouter\.ai\/credits/`
    - openrouter 401: `/rejected the key/i`
    - any provider 500 with body `{error:{message:'boom'}}`: `'boom'`
    - 500 with an empty body: `'The server answered with status 500'`
  - `extraHeaders openrouter`: deep-equals `{ 'HTTP-Referer': 'https://breezecode.site/', 'X-Title': 'Breeze Code' }`. `extraHeaders('gemini')` deep-equals `{}`.
  - `isLlmAgent`: `'gemini'` is true; `'claude'`, `undefined` and `'__proto__'` are false.

- [ ] **Step 2: Run the tests to confirm they fail.** Run `npx tsc && node --test test/llmproviders.test.js`. Expected: FAIL, "Cannot find module '../src/main/llmproviders'".

- [ ] **Step 3: Implement `src/main/llmproviders.ts`** with the exports above and no Electron imports.
  - Gemini filter: keep ids matching `/gemini/i`, drop `/(embed|tts|image|live|audio|aqa)/i`, strip `^models\//`.
  - OpenRouter filter: keep `supported_parameters?.includes('tools')`.
  - Newest flash: parse `/^gemini-(\d+(?:\.\d+)?)-flash$/` and take the highest number.
  - `friendlyError` reads `body.error.message`, `body.error` (string) or `body[0].error.message` (Gemini sometimes wraps errors in an array).
  - The Ollama budget rule moves here unchanged from `llmBudget` in `main.ts`.

- [ ] **Step 4: Run the tests to confirm they pass.** Run `npx tsc && node --test test/llmproviders.test.js`. Expected: all pass.

- [ ] **Step 5: Commit**
```bash
git add src/main/llmproviders.ts test/llmproviders.test.js
git commit -m "feat(llm): provider registry for Ollama, Gemini and OpenRouter"
```
(The compiled `.js` files are not tracked. Don't add them.)

### Task 2: Per-provider config, IPC and requests in the main process

**Files:**
- Modify: `src/main/main.ts`:
  - LLM section 2169-2238: `llmModels`, `llmConfig`, `llmReachable`, `llmFind`, the `llm:*` handlers
  - `llmPost` and `llmStream` (about 4081-4110)
  - `llmBudget` (4156)
  - `runLocal` (4176)
  - `localCommitMsg` (4790)
- Modify: `src/main/preload.ts:139-143`
- Modify: `src/renderer/breeze/core.ts:315` (the `llm` type)

**Interfaces:**
- Consumes: everything from Task 1.
- Produces:
  - `interface LlmConfig { provider: LlmProviderId; url: string; model?: string | null; models: string[]; contexts: Record<string, number>; key: string | null }`
  - `llmConfig(provider: LlmProviderId, probe?: boolean): Promise<LlmConfig | null>`. Probing only applies to `local`. For a cloud provider it returns `null` when there is no key or model.
  - `llmModels(provider: LlmProviderId, url: string, key: string | null | undefined, timeout?: number): Promise<ModelList>`
  - `llmReachable(cfg: LlmConfig): Promise<string[]>`. Its error names the provider: for cloud, "Couldn't reach Gemini. Check your internet connection."; Ollama keeps today's text.
  - IPC: `llm:connect(provider, url, key)`, `llm:setModel(provider, model)`, `llm:disconnect(provider)`. Each handler rejects a provider where `!isLlmAgent(provider)` with `Error('Unknown model provider')`.
  - Renderer type: `llm: { connect(provider: string, url: string, key: string): Promise<{ url?: string; model: string; models: string[] }>; setModel(provider: string, model: string): Promise<void>; disconnect(provider: string): Promise<void>; }`
  - `runLocal(runId, run, params, provider: LlmProviderId)`
  - `localCommitMsg` gains a leading `provider: LlmProviderId` argument. `COMMIT_WRITERS` binds `local`, `gemini` and `openrouter` to it.

- [ ] **Step 1: Refactor `llmModels` to call `filterModels`.**
  - Send `{ ...llmHeaders(key), ...extraHeaders(provider) }`.
  - Build `!r.ok` errors with `friendlyError(provider, r.status, j)`.

- [ ] **Step 2: Split `llmConfig` by provider.**
  - `local`: today's body, returning `contexts: {}`.
  - Cloud: read `loadState().llmProviders?.[id]` and `getSecret(LLM_PROVIDERS[id].keySecret)`, with url `LLM_PROVIDERS[id].url`.
  - Update `llmReachable` to use the new signature.

- [ ] **Step 3: Rework the `llm:*` handlers.**
  - Trim the key. A cloud provider with an empty key throws `Error('Paste your ${name} API key first')`.
  - Cloud connect uses the fixed URL, `llmModels`, then `setSecret(keySecret, key)` and saves `llmProviders[id] = { model: defaultModel(id, models), models, contexts }`. Save via `saveState({ llmProviders: { ...loadState().llmProviders, [id]: … } })` so other providers' entries survive.
  - Cloud disconnect deletes only that entry and its secret.
  - `local` keeps today's behaviour exactly.
  - Update `preload.ts` and the `core.ts` type.

- [ ] **Step 4: Make requests provider-aware.**
  - `llmPost` and `llmStream` add `extraHeaders(cfg.provider)` and throw `friendlyError(cfg.provider, r.status, j)`.
  - `llmBudget` uses `contextWindow(cfg.provider, { url: cfg.url, model: cfg.model, contexts: cfg.contexts, override: Number(loadState().llmContext) || undefined })`.
  - `runLocal` takes `provider` and calls `llmConfig(provider, false)`. Its "connect first" error names the provider.
  - Check `llmRequest`'s "retry without tools / without streaming" fallback: it must not retry on 401, 402 or 429. Gate the retry so it never fires for those statuses (keep the status on the error, e.g. `err.status`).

- [ ] **Step 5: Build and run the full suite.** Run `npm test`. Expected: `tsc` has no errors and all tests pass.

- [ ] **Step 6: Commit** with `feat(llm): one saved config per API provider`.

### Task 3: Wire the new agents through detection, teams, runs, board and commits

**Files:**
- Modify: `src/main/main.ts`:
  - `agentInstallCmd` 1799, `sys:detect` 1845-1849, the install list 1907
  - `teamAgents` 2724-2729, `boardPick` 2787, the run dispatch 3175
  - the written-file check 3520, `defaultCommitAgent` 4719-4722, `COMMIT_WRITERS` 4876

**Interfaces:**
- Consumes: Task 2's `llmConfig(provider, probe)`, `runLocal(..., provider)` and `localCommitMsg(provider, ...)`.
- Produces: `sys:detect` returns one agent per `LLM_PROVIDER_IDS` entry in the form `{ id, name, vendor, url: getUrl, api: true, found, path: url|null, version: model|null, models, install }`. Cloud entries add `keyUrl`, `sub` and `billedBy`. The renderer relies on these fields.

- [ ] **Step 1: Replace each `'local'` special case** with `isLlmAgent(agent)` or a loop over `LLM_PROVIDER_IDS`, at every line listed above.
  - Cloud `found` = `!!cfg?.model`, with no `llmReachable` call during detect.
  - `agentInstallCmd` returns `null` for cloud ids.
  - `defaultCommitAgent` checks `local`, then `gemini`, then `openrouter`, using `llmConfig(id, id === 'local')`.

- [ ] **Step 2: Build and run the full suite.** Run `npm test`. Expected: passes. Also run `rg -n "'local'" src/main/main.ts`. Expected: only the `.local/bin` path, the Ollama-specific lines in the LLM section, and `LLM_PROVIDERS` lookups remain.

- [ ] **Step 3: Commit** with `feat(agents): Gemini and OpenRouter join detection, teams, board and commits`.

### Task 4: Setup cards, picker, names, logos and the browser demo

**Files:**
- Modify: `src/renderer/breeze/setup.ts`:
  - `AGENT_STYLE` 98-105, `localAgentHtml` 152-167, `bindLocalLlm` 210-247
  - the model switch 424-430, `modelMark` 484-490, `AGENT_SHORT_NAMES` 554
- Modify: `src/renderer/breeze/core.ts:108`: add optional `keyUrl?: string; sub?: string; billedBy?: string | null` to `DetectedAgent`
- Modify: `src/renderer/breeze/platform.ts`: `BRAND_ICONS` 872-880, demo agents 403-410, demo `llm` 442-449
- Modify: `src/renderer/breeze/settings.ts:903`
- Modify: `src/renderer/breeze/git.ts:157-160`
- Modify: `src/renderer/breeze.css`: `.tint-gemini` and `.tint-openrouter` next to `.tint-local` (11543), and `.model-mark.mm-gemini` next to `.mm-openai` (2821)
- Create: `assets/icons/gemini.svg`, `assets/icons/openrouter.svg` (the official marks)

**Interfaces:**
- Consumes: Task 3's detect fields and Task 2's `api.llm.*(provider, …)`.

- [ ] **Step 1: Scope each API card.** Every `localAgentHtml` card carries `data-llm-card="${a.id}"` in both states.
  - Not connected, cloud: a "Get a key" button with `data-get="${a.keyUrl}"`, the `a.sub` text, and a key field with placeholder `${a.name} API key`.
  - Not connected, Ollama: unchanged.
  - Connected: same as today. The toast and Remove title use `a.name`.

- [ ] **Step 2: Bind per card.** `bindLocalLlm` loops over `[data-llm-card]` and binds the key field, Connect, the model select and Remove inside that card only.
  - Each call passes `card.dataset.llmCard`, e.g. `api.llm.connect(id, '', key.value)`.
  - Toasts say `${a.name} model · …`.
  - The model switch at 424-430 calls `api.llm.setModel(a.id, model)` and toasts `${a.name} model set to ${model}`.

- [ ] **Step 3: Add names, styles, logos and labels.**
  - `AGENT_STYLE`: `gemini: { letter: 'Ge', tint: 'gemini' }`, `openrouter: { letter: 'Or', tint: 'openrouter' }`.
  - `AGENT_SHORT_NAMES`: `['gemini','Gemini']`, `['openrouter','OpenRouter']`.
  - `BRAND_ICONS`: `gemini: 'gemini.svg'`, `openrouter: 'openrouter.svg'`.
  - `modelMark`: return `mm-gemini` when `a.id === 'gemini'`, the path matches `/(^|\/)~?google\//`, or the last segment starts with `gemini`. Put this check before the agent-logo fallback.
  - `settings.ts:903`: `a.billedBy ? \`Billed by ${a.billedBy}\` : 'No limit · runs on this computer'`.
  - `git.ts:158`: add `lite|flash` to the low-cost regex.

- [ ] **Step 4: Update the browser demo** (`platform.ts`). Add gemini and openrouter demo agents (not connected) with the same fields as `sys:detect`. Demo `llm.connect(provider, …)` stores `breeze.demoLlm.${provider}` and returns `gemini-2.5-flash` / `google/gemini-2.5-flash` for cloud.

- [ ] **Step 5: Build and run the full suite.** Run `npm test`. Expected: passes.

- [ ] **Step 6: Check in the app.** Run `npm start`.
  1. Open Settings → Run Setup Again. Three API cards show: Ollama, Gemini and OpenRouter.
  2. Gemini's "Get a key" opens aistudio.google.com/apikey in the system browser.
  3. Connect with an empty key. The card shows "Paste your Gemini API key first" and the Ollama card is untouched.
  4. The **user** pastes a real Gemini key and connects. The model select shows Gemini models, with a Flash model selected.
  5. Ask Gemini "list the files in this folder". The run streams and calls `list_files`.
  6. Type `@gemini` in a prompt. It appears in the mention list.
  7. Remove Gemini. Ollama stays connected.

- [ ] **Step 7: Commit** with `feat(setup): Gemini and OpenRouter cards, logos and model marks`.
