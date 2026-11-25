# DeepSeek as an API agent — design

Date: 2026-11-25. A small change, following `2026-11-22-gemini-openrouter-agents-design.md`.
The DeepSeek Harness (`dsh`) CLI agent is a separate piece of work with its own design.

## Intent
Let people connect DeepSeek with their own API key and use it like Gemini and OpenRouter.

## Approaches
1. **Another provider on the existing loop, sending DeepSeek's thinking back (picked).**
2. Thinking turned off: a smaller change, weaker on harder coding tasks.
3. DeepSeek's Anthropic-style API: needs a second agent loop for no clear gain.

## Design
- **Provider** `deepseek` in `src/main/llmproviders.ts`: `https://api.deepseek.com`, secret `deepseekKey`, key page
  `platform.deepseek.com/api_keys`, last in `LLM_PROVIDER_IDS` (so last for automatic commit messages), context
  min(model's `context_window`, 128K), default model `deepseek-flash`. `/models` needs a key, so it also checks it.
- **Thinking.** DeepSeek thinks by default. On requests with `tools` it needs every earlier `reasoning_content`
  back or answers 400 (api-docs.deepseek.com/guides/thinking_mode). Breeze keeps it on the assistant messages for
  DeepSeek only, sends it back, counts it in the context budget, and never shows it. Messages without one (an older
  session) go with an empty string. Commit messages turn thinking off.
- **Errors.** 401/403 names the key page, 402 links platform.deepseek.com/top_up, 429 says to wait.
- **Key field.** `sk-` plus 32 hex characters is DeepSeek. Other `sk-` keys still go to the local server.
- **UI.** Picker, model menu, Settings, @mentions, teams, board, browser demo. A "Ds" letter tile until a logo is added.

## Anti-goals
- A local server's key sent to DeepSeek.
- `reasoning_content` sent to any other provider.

## Not verified without a key
A live run against api.deepseek.com, and the key format (from memory).
