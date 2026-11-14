# Explain with Agents — design (small change)

## Intent
Select code in the editor, right-click, pick **Explain with Agents**, and read a plain-English explanation right there,
next to the code. The explanation must not land in the Agents tab: it is a quick look, not a conversation.

## Goals / non-goals
- Goal: one right-click to an explanation of the selected code, without leaving the file.
- Non-goal: follow-up questions, chat history, edits to the code. (Asking more is what the Agents tab is for.)
- Anti-goal: anything appearing in, or switching to, the Agents tab; the agent changing files.

## Approaches
1. **Floating card under the selection** — picked. Fastest to build, attached to the code, gone on Esc or click outside.
2. Panel docked under the editor — stays while you edit, but takes editor height for a quick look.
3. Inline block between the lines (peek view) — most attached, but the editor is a custom virtualized surface: most work and risk.

## Design
- **Menu:** right-click in the main editor (`#editor .code`) opens the app's own `popupMenu` with
  **Explain with Agents**. It is disabled when nothing is selected.
- **Agent:** the active agent (`currentActiveAgent()`) with the user's model for it (`chosenModelFor`), the same pick
  the conflict Duel uses. No agent found → the agent picker opens.
- **Call:** the existing one-shot `api.agent.ask` (main `agent:ask`): read-only, no tools that write, nothing added to
  the Agents tab or its history.
- **Prompt:** file path, language, line numbers, the selected code (cut at 12,000 characters) and up to 20 lines
  around it for context. Asks for a short explanation: what it does, how, and anything surprising.
- **Card:** fixed-position, placed at the right-click point (flipped above when there is no room below), glass style
  like the LSP hover. Header: agent name, "Explain · lines a–b", Copy, close. Body: "Explaining…" while waiting, then
  the reply through the agents' `md()` renderer, or the error with Retry.
- **Closes on:** Esc, ✕, a click outside, or switching files. A newer request replaces an older one; a stale reply is
  dropped.

## Left to the builder
Exact spacing and colours (follow `.lsp-hover` and the existing glass tokens); copy toast wording.
