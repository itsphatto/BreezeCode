# Product

<!-- impeccable:product-schema 1 -->

Scope: the Breeze Code desktop app (`src/`). The marketing site has its own record in `BreezeCode-Web/PRODUCT.md`.

## Platform

web

(An Electron desktop app for Windows, macOS and Linux. Its UI is HTML/CSS in `src/renderer/` with its own design language, not native Windows controls.)

## Users

Beginners come first, but experienced developers have to be served too.

- **Primary:** new and hobby coders, such as students and people building their first projects. They describe what they want in plain words and let AI agents do most of the building, and they need the IDE to stay understandable while it does.
- **Also served:** working developers who want a lighter editor than the big IDEs, with agents built in and no lock-in to one provider.

## Product Purpose

Breeze Code is a lightweight desktop development environment where AI agents plan, build and show their work right next to your code. You can ask for a change in plain words, see exactly what the agent intends, approve it, and watch it happen. Success means a beginner ships something real without losing track of what changed, and an experienced developer keeps full control without having to put up with a heavy editor.

## Positioning

These four points are equally weighted and should not be traded against each other:

1. **Plan → approve → build.** A prompt runs in one of three modes. Ask: an Assistant answers without changing files. Build: a Builder makes the changes. Plan: a Planner proposes a numbered plan, you approve it or ask for changes, and a Builder carries it out. Every file read, edit and command streams into the agents panel as it happens, and each role wears the name and logo of the agent doing the work.
2. **Bring your own agent.** Breeze detects Claude Code, Codex, GitHub Copilot, Antigravity, OpenCode and DeepSeek CLI (a developer preview) on the machine and signs in with their own accounts. It also runs Gemini, OpenRouter and DeepSeek API from a pasted API key, or a local model through Ollama, LM Studio or any OpenAI-compatible server, on its own agent loop. You can switch at any time, and @mention several agents in one prompt: each claims its files first, you settle any overlap, and they build side by side with every line tagged. If one touches another agent's file, Breeze puts it back and says so.
3. **Light, local and free.** It is meant to have a small footprint. There are no plans or credits; you only pay if you pick a paid agent. Files stay on the machine, API keys are encrypted with the OS keychain, and with a local model nothing leaves the computer.
4. **Fun while you wait.** Vibe Code Mode, sound effects and personality are part of the product's character, not decoration.

## Operating Context

- Windows 10/11 x64, macOS on Apple Silicon (`.dmg`, `.zip`) and Linux x64 (`.AppImage`, `.deb`). Windows is built locally with `npm run dist`. macOS and Linux are built by `.github/workflows/release.yml` on a `v*` tag. The builds are unsigned, so SmartScreen (Windows) and Gatekeeper (macOS) warn on first open. The Windows installer is about 110 MB.
- First-run setup scans for coding agents, Git, Node.js and compilers, lets the user pick a theme and an agent, and takes an API key for Gemini, OpenRouter, DeepSeek or a local LLM.
- Main surfaces:
  - **Home:** New File, Open Folder or Clone Repository, recent projects, GitHub contributions, and an Agent tab with 30 days of token use and what it would have cost at API prices (an estimate).
  - **Breeze Code:** explorer, tabbed and split editor, terminal (can pop out into its own window with the same sessions), live preview, full-page Source Control, and an agents panel with agent cards.
  - **Agent Board:** agents side by side in boxes, each with its own agent, model and prompt, a live file pane and a small browser. A file belongs to the first box that edits it, and changes from other boxes are relayed to the owner. The side bar lists Breeze, Claude Code and Codex chats, and opens the **Second brain**: a project's memory (facts, decisions, tasks and the files they name, taken from agents' chat summaries) as a searchable graph or a list.
  - **Vibe Code Mode:** the IDE fades and an Instagram or Facebook feed plays while the agents work, and a card announces when the code is ready.
  - **Skills:** browse the skills and plugins the agents load, share skills across agents, and connect MCP servers for Claude Code without editing its own config.
  - **Settings:** themes (dark, light, high contrast, with matching window chrome), agents with each one's plan usage (Claude Code: tokens this month plus live 5-hour and weekly limits; Codex: tokens plus its plan window; API agents: tokens and who bills them; Antigravity, OpenCode and Copilot report none), instructions every agent gets before the message, sounds with a volume slider. Sign-in with GitHub or Google, with more than one account.
- Ctrl+R reloads any Breeze window.
- Agents run for minutes at a time, so waiting, progress and "it's done" moments are core states.

## Capabilities and Constraints

- Editor: reorderable tabs, split editors, minimap, auto save, go to file or line, find, word suggestions and a next-line hint that counts numbers on. Text files open in the Rust engine (`engine/`), which also runs find and the quick error checks; only the lines on screen are drawn, so files up to 2 GB stay fast.
- Language servers: completions, hover, go to definition, references, rename, and errors and warnings underlined as you type (red and amber). JavaScript and TypeScript work out of the box; Python, Rust, Go and C/C++ use pyright, rust-analyzer, gopls or clangd when installed.
- Jupyter notebooks: a `.ipynb` file opens as cells. Code cells run in a Python kernel Breeze ships (standard library only, so no Jupyter install), with text, tables, images and matplotlib plots as outputs; Markdown cells show formatted. View → Notebook View switches to the JSON.
- Run with F5: C, C++, C# (.NET SDK), Python, Java (JDK 11+) and Rust (rustc, or cargo inside a Cargo project), plus Go, Ruby, PHP, Lua, Kotlin, Swift, Dart, Zig, Scala, Elixir, Haskell, R, Perl, Groovy, SQLite and shell scripts, using compilers Breeze finds on the machine. It explains how to install anything that's missing. JavaScript runs on Node in the terminal.
- Live preview: HTML/CSS open beside the code and refresh as you go; right-click an element to inspect its tag, id and classes. Markdown files preview as rendered pages.
- Debugger: step through Python, JavaScript, TypeScript, C, C++, C#, Rust, Java and Go in a full-page view with breakpoints, a call stack, variables, a watch list and your program's output (and input). Python needs the free `debugpy` helper (Breeze offers to install it) and TypeScript needs Node 22.18 or newer. C, C++ and Rust need GCC and GDB 14+ (MinGW-w64 from MSYS2 or WinLibs). C# needs the .NET SDK (10+ for a lone .cs file) and netcoredbg, which Breeze downloads on request (a pinned release, checked by hash) into its data folder on Windows x64, Apple Silicon Macs and Linux x64/arm64. Go needs Go and Delve (`dlv dap`). Java needs a JDK. Breeze works out Java expressions itself (`javaexpr.ts`) for the console, watches, breakpoint conditions, hit counts and logpoints: arithmetic, comparisons, `&&`/`||`/`!`, `?:`, fields, `arr[i]`, `arr.length` and String's side-effect-free methods. It doesn't call other methods. One debug session runs at a time, and it stops when you close the folder.
- Command Palette (Ctrl+Shift+P or F1): type a few letters to find any menu command; recently used commands come first.
- Multi-cursor editing (Alt+Click, Ctrl+D, Ctrl+Shift+L, Shift+Alt+drag for a column) and Emmet shortcuts (press Tab on something like `ul>li*3` in HTML, JSX or CSS). Emmet is off while several cursors are active.
- Git: a full-page Source Control to stage, discard, commit and push, with a graph of checkpoints and branches. Files an agent is editing are marked in the explorer and tabs.
- Pull requests: read, comment on, merge or close GitHub PRs from Source Control. Merge conflicts are resolved in a separate worktree so the user's checkout is never touched. **Conflict Duel** has an agent argue for each side, then a judge proposes a merged block you accept, edit or reject.
- Image attachments: drop or paste images into a prompt. Dropped files are used where they are and pasted ones go to a temp folder, so nothing lands in the project.
- Breeze's own agent loop (local models, Gemini, OpenRouter, DeepSeek API) is token-efficient (project map, ranged reads, snippet edits). For a local server it assumes a 4k-token context on Ollama and 8k elsewhere (`llmContext` in saved state overrides it).
- DeepSeek CLI runs alone: it can't join a multi-agent prompt or the Agent Board, and it needs Node.js 24.9 or newer.
- A renamed or moved project folder is recognised (`.breezecode/project.json`), so its chats, agent sessions and second brain follow it.
- Discord Rich Presence. Small synthesized sounds for clicks, typing and agents. Auto-updates via electron-updater, which asks before downloading. API keys and sign-in tokens are encrypted with the OS keychain (Windows DPAPI, macOS Keychain, the Linux secret store); expiring GitHub tokens renew themselves.
- The agents are optional: the editor, terminal, Git and preview all work without one.
- Stack: Electron 44, TypeScript 7 (`src/renderer/breeze/*.ts`, one file per feature, plus `editcore.ts` and `codeview.ts` for the editor, compiled to JS), plain HTML/CSS, and a Rust document engine. Current version 0.8.4. Windows, macOS (Apple Silicon) and Linux (x64); no Intel Mac build yet.

## Brand Commitments

- Name: **Breeze Code**. Sub-surface names in use: Breeze Code, Agent Board, Second brain, Vibe Code Mode, Home, Planner, Builder, Assistant, Conflict Duel.
- Brand assets: `assets/brand/` (Icon, BreezeCode wordmark, Agent).
- Voice (inferred from the README and in-app copy, not confirmed by the owner): plain words, short sentences, friendly but not cute, with no jargon a beginner would trip on.
- Source available under the Breeze Code Source-Available License (view and use, including commercially; no copying or redistribution), © Breeze Code authors. Versions before November 7, 2026 were MIT.

## Evidence on Hand

- Product screenshots: `docs/screenshots/` and `BreezeCode-Web/assets/screens/`.
- Agent and language logos: `assets/icons/`, `BreezeCode-Web/assets/agents/`, `BreezeCode-Web/assets/langs/`.
- **Measured benchmark (2026-11-23, README → Benchmarks, `reports/bench-2026-11-23.json`).** Windows, i5-12500H, clean profiles, no extensions, no agent running. With a TypeScript project open, Breeze used 522 MB against VS Code's 1,589 MB (about 3× less) and Antigravity's 1,900 MB (about 3.6× less). With a 500 MB file, Breeze used 841 MB and VS Code 881 MB, so they were about the same. VS Code started a project faster (2.27 s vs 4.76 s), and Breeze opened the 500 MB file faster (5.70 s vs 8.52 s). Claims may say "about 3× less memory than VS Code with a project open"; always name the comparison and the scenario.
- **The old "up to 12× less memory" line is contradicted by that measurement.** Don't use it. `BreezeCode-Web/FAQ.html` still says it.
- There are no user testimonials, usage numbers or press. Don't make any up.

## Product Principles

1. **Show the work.** Whatever an agent does should be visible and attributable while it happens, never hidden behind a spinner.
2. **The human approves.** Plans are proposed, not imposed, and changes stay reviewable and reversible (checkpoints).
3. **Beginner-legible, expert-capable.** Plain language and clear defaults come first, without taking power away from people who know what they're doing.
4. **Light by default.** Every feature has to justify its weight in memory, startup time and visual noise.
5. **Waiting can be pleasant.** Long agent runs are a moment for personality, as long as progress and the done state stay unmistakable.
