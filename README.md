# Breeze Code

<div align="center">

<img src="assets/brand/Icon.png" height="96" alt="">
<br>
<img src="assets/brand/BreezeCode.png" height="44" alt="Breeze Code">

<br>

**Your AI agents plan, build and show their work, right next to your code.**
<br>
A lightweight desktop IDE for Windows. Free and open source.

<br>

[**⬇ Download for Windows**](https://github.com/itsphatto/BreezeCode/releases/latest)  ·  [Website](https://usebreezecode.itsphatto.site)  ·  [Source](https://github.com/itsphatto/BreezeCode)  ·  [Report a bug](https://github.com/itsphatto/BreezeCode/issues)

<br>

![Version](https://img.shields.io/badge/version-0.5.3-005EFF?style=for-the-badge)
![Platform](https://img.shields.io/badge/platform-Windows-1c1c21?style=for-the-badge)
![License](https://img.shields.io/badge/license-MIT-1c1c21?style=for-the-badge)
<br>
![Electron](https://img.shields.io/badge/Electron-44-1c1c21?style=flat-square&logo=electron&logoColor=9feaf9)
![TypeScript](https://img.shields.io/badge/TypeScript-7-1c1c21?style=flat-square&logo=typescript&logoColor=3178c6)

<sub>[Why](#why-breeze-code) · [Features](#features) · [Getting started](#getting-started) · [Configuration](#configuration) · [Installer](#building-the-installer) · [Layout](#project-layout)</sub>

<br>

<img src="docs/screenshots/ide-hero.jpg" alt="Breeze IDE: explorer, editor, live preview and the agents panel after a plan was approved and built" width="900">

</div>

## Why Breeze Code

- **Agents that show their work.** A Planner writes a plan, you approve it, and a Builder carries it out. Every file read, edit and command streams into the agents panel as it happens.
- **Bring the agent you already use.** Breeze finds Codex on your computer, or connects to a local model through Ollama, LM Studio or any OpenAI-compatible server.
- **Light and local.** Your files stay on your machine, API keys are encrypted with the OS keychain, and a local model runs without the cloud.
- **Stay in the flow.** Vibe Mode plays a short-video feed while the agents work, then tells you when your code is ready.

## Features

<table>
<tr>
<td width="50%" valign="top">

### Plan, approve, build

Ask in plain words. The Planner reads the project and proposes a numbered plan; approve it or ask for changes, then the Builder implements it. Agent cards show who is working and on what.

</td>
<td width="50%"><img src="docs/screenshots/ide-plan.jpg" alt="A plan waiting for approval in the agents panel"></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/setup-agents.jpg" alt="Choosing an AI agent during setup"></td>
<td width="50%" valign="top">

### Your agent, detected

Setup scans for installed coding agents and for Git and Node.js. Pick one, or paste an API key to use a local LLM. Change it any time from Settings.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Checkpoints with Git

Stage, discard, commit and push from the Source Control view, with a graph of your checkpoints and branches. Files an agent is editing are marked in the explorer and tabs.

</td>
<td width="50%"><img src="docs/screenshots/ide-git.jpg" alt="Source control with staged changes and a checkpoint graph"></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/box.jpg" alt="Breeze Box chat with a code artifact"></td>
<td width="50%" valign="top">

### Breeze Box

Just a prompt and a chat, no editor. Code in a reply becomes an artifact card you can copy or download in one click.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Vibe Mode

While an agent works, the IDE fades and an Instagram or Facebook feed plays. A notification tells you when the code is ready; leaving is up to you.

</td>
<td width="50%"><img src="docs/screenshots/vibe.jpg" alt="Vibe Mode with a feed and the code-ready card"></td>
</tr>
</table>

### And also

| | |
| --- | --- |
| **Editor** | Tabs you can reorder, go to file or line, find, and syntax checking for JavaScript and TypeScript |
| **Terminal and Run** | Integrated terminal; press F5 to run C, C++, C# and Python files with the compilers Breeze finds. C# uses the .NET SDK (10 or newer for a single `.cs` file; any version inside a `.csproj` project), and Breeze tells you how to install anything that's missing |
| **Live preview** | Open `index.html` next to your code and reload as you go |
| **Local LLM** | A token-efficient agent loop: a project map, ranged file reads and snippet edits keep requests small |
| **Accounts** | Sign in with GitHub or Google, with several accounts |
| **Discord** | Rich Presence shows what you're working on |
| **Security** | API keys are encrypted with the OS keychain |

## Getting started

Requires [Node.js](https://nodejs.org/) 20 or newer.

```bash
npm install
npm start
```

`npm start` compiles the renderer's TypeScript (`src/renderer/breeze/*.ts`, `editcore.ts`, `codeview.ts`) and launches the app. The compiled `.js` files are build output and aren't committed, so run `npm run build` once before opening `src/renderer/breeze.html` in a browser for a demo of the UI with a sample project and canned agent runs.

| Script | What it does |
| --- | --- |
| `npm start` | Compile and run the app |
| `npm run build` | Compile TypeScript only |
| `npm run watch` | Compile on change |
| `npm test` | Syntax-check the main process and run the tests |
| `npm run dist` | Build the Windows installer into `dist/` |

## Configuration

Sign-in and Discord presence need client ids. Copy the example file and fill in your own:

```bash
cp breeze.config.example.json breeze.config.json
```

Or put them in a `.env` file next to `main.js`:

```env
BREEZE_GITHUB_CLIENT_ID=
BREEZE_GOOGLE_CLIENT_ID=
BREEZE_GOOGLE_CLIENT_SECRET=
BREEZE_DISCORD_CLIENT_ID=
```

Environment variables override the config file. Both `breeze.config.json` and `.env` are gitignored; never commit them.

- **GitHub:** create an OAuth App and enable *Device Flow* (no secret needed).
- **Google:** create a *Desktop app* OAuth client.
- **Discord:** create an application and use its Application ID.

> [!TIP]
> Breeze assumes a local LLM has a 4k-token context on Ollama and 8k elsewhere. If you raised your server's context size, set `llmContext` in Breeze's saved state so the agent can use the extra room.

## Building the installer

```bash
npm run dist
```

This runs `scripts/write-config.js`, which writes `breeze.config.json` from your `.env` so the packaged app has its client ids, then builds `dist/Breeze Code Setup <version>.exe` with electron-builder.

> [!WARNING]
> The installer is unsigned, so Windows SmartScreen may warn on other machines. Values bundled into an installer can be extracted by anyone who has it, so only put public client ids (and Google's desktop-app secret, which is not confidential) in `.env` when building.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/main/main.js` | Electron main process: files, terminal, agents, Git, auth |
| `src/main/agentbrain.js` | The local LLM agent's context budget, project map and file-tool formats |
| `src/main/preload.js` | Bridge between the main process and the UI |
| `src/main/toolchains.js` | Compiler and tool detection |
| `src/main/discord.js` | Discord Rich Presence client |
| `src/main/guard.js`, `pathguard.js` | Path and command safety checks |
| `src/renderer/breeze.html`, `breeze.css` | UI |
| `src/renderer/breeze/` | Renderer logic, one file per feature (settings, git, terminal and so on), loaded in order by `breeze.html` |
| `src/renderer/editcore.ts`, `codeview.ts` | The code editor's position logic and its virtualized text surface |
| `assets/brand/` | App icon, logos and wordmarks |
| `assets/fonts/` | Bundled fonts |
| `assets/icons/` | Agent and feed logos |
| `runtime/` | C runtime helpers |
| `scripts/` | Build helpers |
| `docs/screenshots/` | Screenshots used in this README |
| `test/` | Tests |
