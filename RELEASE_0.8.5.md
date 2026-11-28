# Breeze Code 0.8.5

Talk to your agents with offline voice typing, tool steps fold into tidy groups, and git, the preview server and Live Share stop trusting the repos you open.

## New
- **Voice typing, offline.** The composer mic records your voice and turns it into text on your PC with whisper.cpp. Click to talk, click or press Enter to type it, Escape to cancel. The speech model downloads once and is checked against a pinned SHA-256. It replaces Windows dictation.
- **Collapsible tool steps.** Consecutive tool calls in an agent's reply fold into one "N steps" dropdown with a live count. Notes stay visible.
- **API key field in Agents settings.** Paste a key and Breeze works out which agent it belongs to. Leave it empty and Breeze looks for Ollama or LM Studio.
- **Discord status words.** With "Show file and project name" off, the status shows a neutral verb such as "Baking" instead of your work.

## Improved
- Agent Board image attachments show as large rounded tiles, with a ✕ on hover.
- The composer `+` button has no border.
- Agent and commit-message CLIs start with `PWD` set to the project folder, so OpenCode no longer picks up the folder Breeze was launched from.

## Security
- A repo's own `.git/config` and hooks can no longer run code during Breeze's stage, commit, fetch and push.
- `breeze-preview://` no longer serves `.env` and `.git` files.
- Live Share and the preview server have tighter checks.
- `SECURITY_AUDIT.md` is re-checked: findings 4, 8 and 9 are fixed, and finding 3 stays open.

## Fixed
- A toast now appears in Agents settings when a key isn't recognised or agents are still being scanned.

## Removed
- BreezeSpace. The Agent Board replaces it.
- Windows dictation.

**Full changelog**: https://github.com/itsphatto/BreezeCode/compare/v0.8.4...v0.8.5
