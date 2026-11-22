# Gemini and OpenRouter as agents — design

Date: 2026-11-22

## Intent

Breeze Code's only API agent today is "Ollama" (`id: 'local'`). It works with Ollama, LM Studio or any OpenAI-compatible server, but it needs a model running on the user's own computer. Add **Gemini** (Google, has a free API tier) and **OpenRouter** (one key, hundreds of models) as their own agents. People without a strong PC then get a free or cheap option, and the "bring your own agent" pillar covers cloud APIs too.

## Goals

- Gemini and OpenRouter each show as a separate agent: Setup card, model picker, @mentions, teams, Agent board, commit messages.
- Each has its own key and model list. Connecting one never disconnects another, Ollama included.
- They run on the existing OpenAI-style agent loop (`runLocal` in `src/main/main.ts`), not on a new one.
- A beginner can get from "no key" to a working Gemini agent from the Setup card alone.

## Non-goals

- Gemini CLI as a CLI agent (possible later).
- A Grok preset (OpenRouter covers Grok).
- A custom-URL field in the UI.
- Changes to the website copy (a separate follow-up in `BreezeCode-Web`).

## Anti-goals (a failure even if it works)

- Existing Ollama users lose their saved server, model or key after updating.
- A key is stored anywhere except the OS-encrypted secrets file (`setSecret`).
- Gemini's free quota gets used up quietly because Breeze sends the whole 1M-token window on every turn.
- Cloud agents are labelled "runs on this computer".

## Approaches considered

1. **Separate agents sharing one loop (picked).** A small provider registry tells the loop which address, key, headers and context size to use. Each provider is its own agent id. Costs more wiring (about 10 places hardcode `'local'`), but it is the only option that supports @mentioning two providers at once and shows "Gemini" to beginners by name.
2. **Presets inside the Ollama agent.** A dropdown fills in the address. Cheapest (2 to 3 hours), but only one provider at a time, switching means pasting the key again, and the agent stays named "Ollama".
3. **Separate loop per provider.** Rejected: both providers speak the OpenAI API, so a second loop would only duplicate code.

## Design

### Provider registry (new pure module `src/main/llmproviders.ts`, no Electron, unit-tested)

| id | name | vendor | base URL | key | context budget |
|---|---|---|---|---|---|
| `local` | Ollama | Ollama, LM Studio or any OpenAI-compatible server | probed (`LLM_DEFAULTS`) | optional | today's rule (4096 on :11434, else 8192, `llmContext` overrides) |
| `gemini` | Gemini | Google | `https://generativelanguage.googleapis.com/v1beta/openai` | required | 128K |
| `openrouter` | OpenRouter | OpenRouter | `https://openrouter.ai/api/v1` | required | min(model's `context_length`, 128K) |

The module also holds:
- `filterModels(provider, json)`:
  - Gemini: keep chat models (ids containing `gemini`, dropping embedding, TTS, image and live models) and strip a leading `models/`.
  - OpenRouter: keep models whose `supported_parameters` includes `tools`, and keep each one's `context_length`.
  - Ollama: unchanged.
- `defaultModel(provider, models)`: Gemini prefers the newest `gemini-*-flash` (free-tier friendly). OpenRouter and Ollama take the first model.
- `friendlyError(provider, status, body)`:
  - 401/403: "Gemini rejected the key. Check it at aistudio.google.com/apikey."
  - 429: "Gemini's free limit is used up for now. Wait a minute, or add billing in Google AI Studio."
  - 402 (OpenRouter): "OpenRouter needs credits. Add them at openrouter.ai/credits."
- `extraHeaders(provider)`: OpenRouter gets `HTTP-Referer: https://breezecode.site/` and `X-Title: Breeze Code`.

### Storage

- Ollama keeps its current keys (`llmUrl`, `llmModel`, `llmModels`, `llmOff`, secret `llmKey`). There is no migration.
- Cloud providers save state as `llmProviders: { gemini: { model, models }, openrouter: { model, models, contexts } }`, with secrets `geminiKey` and `openrouterKey`.

### Main process (`src/main/main.ts`)

- `llmConfig(provider, probe)` returns `{ provider, url, model, models, key }`. Probing applies only to `local`.
- `sys:detect`, `teamAgents()`, and the run dispatch (`if (agent === 'local') return runLocal…`) loop over the registry instead of hardcoding `'local'`. The same goes for `boardPick`, `defaultCommitAgent` (order: CLIs → Ollama → Gemini → OpenRouter) and `localCommitMsg`.
- A cloud agent is "found" when its key and model are saved. `sys:detect` does no network call for cloud agents, so being offline doesn't hide them. Reachability is checked when a run starts, and failures go through `friendlyError`.
- `llmBudget` reads the provider's context budget.
- IPC changes to `llm:connect(provider, key)`, `llm:setModel(provider, model)` and `llm:disconnect(provider)`. Update `preload.ts` and every renderer caller; Ollama's callers pass `'local'`.

### Renderer

- **Setup card** (`setup.ts` `localAgentHtml`), not-connected state for a cloud agent:
  - "Get a key" button opening aistudio.google.com/apikey or openrouter.ai/keys, then the key field and Connect.
  - Subtitles: Gemini "Free tier · needs a Google account". OpenRouter "One key for hundreds of models · pay as you go".
  - The connected state is the same as Ollama's: model select and Remove.
- **Names, logos and tints**: `AGENT_STYLE`, `AGENT_SHORT_NAMES`, `assets/icons/gemini.svg` and `openrouter.svg`, plus matching CSS tints.
- **Model picker** `modelMark`: add a Gemini mark for `google/` or `gemini` models. The existing path-segment grouping and search already handle OpenRouter's long list.
- **Settings usage line** (`settings.ts:903`): cloud API agents show "Billed by Google" / "Billed by OpenRouter", not "runs on this computer".
- **Browser demo** (`platform.ts` demoApi): list both agents as not connected, so the website hero shows them.

## Left to the builder

- Check the live Gemini `/models` response shape and the exact filter list against the real API before finalizing `filterModels`.
- Pick the CSS tint colours and source the official marks.
- Decide whether the Ollama card's "Ollama" label needs any wording change now that it sits next to cloud agents.
- Tests: `test/llmproviders.test.js` covering the model filtering, default model, error mapping and budget logic. Run `npm test` in the end.

## Calls made without asking (check these)

1. 128K context cap for cloud models, to protect free quota and cost.
2. Cloud agents count as "found" from the saved key, with no network check on scan.
3. Commit-message fallback order: CLIs → Ollama → Gemini → OpenRouter, so a local model is preferred over a paid one.
4. Gemini defaults to a Flash model.
5. No custom URL field. Ollama's storage is left untouched.
