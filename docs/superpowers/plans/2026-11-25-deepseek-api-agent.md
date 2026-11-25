# DeepSeek API Agent Implementation Plan

> Carried out natively in one session (superpowers:executing-plans).

**Goal:** DeepSeek as an API agent beside Gemini and OpenRouter.
**Architecture:** one more entry in the provider registry, plus reasoning kept on assistant messages for DeepSeek only.
**Tech Stack:** TypeScript, Electron, node:test. No new dependencies.
**Spec:** `docs/superpowers/specs/2026-11-25-deepseek-api-agent-design.md`

## Review Focus
- A 400 mid-run because one assistant message lost its reasoning after compaction or reload.
- A stopped or older session with messages that never had reasoning.
- Reasoning left out of the token count, so long runs overflow the budget.
- A reply that isn't streamed (reasoning on `message`, not `delta`).
- A LiteLLM-style `sk-1234` local key mistaken for DeepSeek's.

### Task 1: Provider (`src/main/llmproviders.ts`, `test/llmproviders.test.js`)
- [ ] Failing tests: filterModels, defaultModel, contextWindow, friendlyError 401/402/429, isLlmAgent, `chatExtras`.
- [ ] Add the provider, `keepsReasoning(provider)` and `chatExtras(provider, think)`.

### Task 2: Thinking round trip (`src/main/agentbrain.ts`, `src/main/main.ts`, `test/agentbrain.test.js`)
- [ ] Failing tests: replyReader returns `reasoning_content`; `historyTokens` counts it; settle and compactHistory keep it;
      `withReasoning(messages)` fills in the missing ones on assistant messages only.
- [ ] Implement; use in `runLocal` and `localCommitMsg`.

### Task 3: App wiring (`main.ts` COMMIT_WRITERS, `setup.ts`, `settings.ts`, `platform.ts`, `breeze.css`)
- [ ] Failing test for `keyProvider` (moved to a testable place or read from the built file).
- [ ] Wire ids, tint, demo, copy.

### Task 4: Verify
- [ ] `npm test`: no failures beyond the baseline's.
- [ ] A fake DeepSeek server that answers 400 when reasoning is missing; browser demo check.
