# Product

<!-- impeccable:product-schema 1 -->

Scope: the Breeze Code desktop app (`src/`). The marketing site has its own record in `BreezeCode-Web/PRODUCT.md`.

## Platform

web

(An Electron desktop app for Windows. Its UI is HTML/CSS in `src/renderer/` with its own design language, not native Windows controls.)

## Users

Beginners come first, but experienced developers have to be served too.

- **Primary:** new and hobby coders, such as students and people building their first projects. They describe what they want in plain words and let AI agents do most of the building, and they need the IDE to stay understandable while it does.
- **Also served:** working developers who want a lighter editor than the big IDEs, with agents built in and no lock-in to one provider.

## Product Purpose

Breeze Code is a lightweight desktop development environment where AI agents plan, build and show their work right next to your code. You can ask for a change in plain words, see exactly what the agent intends, approve it, and watch it happen. Success means a beginner ships something real without losing track of what changed, and an experienced developer keeps full control without having to put up with a heavy editor.

## Positioning

These four points are equally weighted and should not be traded against each other:

1. **Plan → approve → build.** A Planner proposes a numbered plan and you approve it or ask for changes. A Builder then carries it out, and every file read, edit and command streams into the agents panel as it happens.
2. **Bring your own agent.** Breeze detects Codex and Antigravity on the machine, or connects to a local model through Ollama, LM Studio or any OpenAI-compatible server. You can switch at any time.
3. **Light and local.** It is meant to have a small footprint. Files stay on the machine, API keys are encrypted with the OS keychain, and with a local model nothing leaves the computer.
4. **Fun while you wait.** Vibe Mode, sound effects and personality are part of the product's character, not decoration.

## Operating Context

- Windows 10/11 64-bit desktop. The unsigned NSIS installer is about 110 MB, so SmartScreen shows a warning on first install.
- First-run setup scans for coding agents, Git and Node.js, and offers to use a local LLM with an API key.
- Main surfaces:
  - **Breeze IDE:** explorer, tabbed editor, terminal, live preview, Source Control, and an agents panel with agent cards.
  - **Breeze Box:** prompt and chat only, with no editor. Code in a reply becomes an artifact card you can copy or download.
  - **Vibe Mode:** the IDE fades and an Instagram or Facebook feed plays while the agents work, and a card announces when the code is ready.
  - **Settings**, plus sign-in with GitHub or Google (more than one account is supported).
- Agents run for minutes at a time, so waiting, progress and "it's done" moments are core states.

## Capabilities and Constraints

- Editor: reorderable tabs, go to file or line, find, and JS/TS syntax checking.
- Run with F5: C, C++, C# (.NET SDK) and Python, using compilers Breeze finds on the machine. It explains how to install anything that's missing. JavaScript runs on Node in the terminal, and HTML/CSS get a live preview.
- Java and Rust run support is planned, not shipped.
- Git: stage, discard, commit and push, with a graph of checkpoints and branches. Files an agent is editing are marked in the explorer and tabs.
- Local LLM loop is token-efficient (project map, ranged reads, snippet edits). It assumes a 4k-token context on Ollama and 8k elsewhere.
- Discord Rich Presence. Auto-updates via electron-updater, which asks before downloading.
- The agents are optional: the editor, terminal, Git and preview all work without one.
- Stack: Electron 44, TypeScript (`src/renderer/breeze/*.ts`, one file per feature, compiled to JS), and plain HTML/CSS. Windows is the only platform for now.

## Brand Commitments

- Name: **Breeze Code**. Sub-surface names in use: Breeze IDE, Breeze Box, Vibe Mode, Planner, Builder.
- Brand assets: `assets/brand/` (Icon, BreezeCode wordmark, BreezeIDE, BreezeBox, Agent).
- Voice (inferred from the README and in-app copy, not confirmed by the owner): plain words, short sentences, friendly but not cute, with no jargon a beginner would trip on.
- Open source under the MIT license, © Sataphat Phanichawong (@itsphatto).

## Evidence on Hand

- Product screenshots: `docs/screenshots/` and `BreezeCode-Web/assets/screens/`.
- Agent and language logos: `assets/icons/`, `BreezeCode-Web/assets/agents/`, `BreezeCode-Web/assets/langs/`.
- **"Up to 12× less memory than a typical code editor" is a rough estimate, not a measurement.** Don't build stronger claims on it, and don't present it as a benchmark.
- There are no user testimonials, usage numbers, press or benchmarks. Don't make any up.

## Product Principles

1. **Show the work.** Whatever an agent does should be visible and attributable while it happens, never hidden behind a spinner.
2. **The human approves.** Plans are proposed, not imposed, and changes stay reviewable and reversible (checkpoints).
3. **Beginner-legible, expert-capable.** Plain language and clear defaults come first, without taking power away from people who know what they're doing.
4. **Light by default.** Every feature has to justify its weight in memory, startup time and visual noise.
5. **Waiting can be pleasant.** Long agent runs are a moment for personality, as long as progress and the done state stay unmistakable.
