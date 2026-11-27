<div align="center">

<img src="assets/brand/Icon.png" height="96" alt="Breeze Code">

<br>

### Blazing-fast, Rust Engine Code editor with Multi AI-Integration

Ask for a change in plain words. Claude Code, Codex, Antigravity, Gemini, OpenCode or a local model makes it,<br>
and you see every file it reads, every edit and every command while it works.

[**Download for Windows, macOS or Linux**](https://github.com/itsphatto/BreezeCode/releases/latest) &nbsp;·&nbsp; [Website](https://breezecode.site) &nbsp;·&nbsp; [FAQ](https://breezecode.site/FAQ.html) &nbsp;·&nbsp; [Report a bug](https://github.com/itsphatto/BreezeCode/issues)

<br>

![Version](https://img.shields.io/badge/version-0.8.3-007AFF?style=for-the-badge)
![Windows](https://img.shields.io/badge/Windows_10_%26_11-x64-1d1d1f?style=for-the-badge&logo=windows&logoColor=f5f5f7)
![macOS](https://img.shields.io/badge/macOS-Apple_Silicon-1d1d1f?style=for-the-badge&logo=apple&logoColor=f5f5f7)
![Linux](https://img.shields.io/badge/Linux-x64-1d1d1f?style=for-the-badge&logo=linux&logoColor=f5f5f7)
![Price](https://img.shields.io/badge/price-free-1d1d1f?style=for-the-badge)
![License](https://img.shields.io/badge/license-source--available-1d1d1f?style=for-the-badge)
<br>
![Electron](https://img.shields.io/badge/Electron-44-1d1d1f?style=flat-square&logo=electron&logoColor=9feaf9)
![TypeScript](https://img.shields.io/badge/TypeScript-7-1d1d1f?style=flat-square&logo=typescript&logoColor=3178c6)
![Rust](https://img.shields.io/badge/Rust-document_engine-1d1d1f?style=flat-square&logo=rust&logoColor=f74c00)
![Size](https://img.shields.io/badge/installer-~110_MB-1d1d1f?style=flat-square)

<sub>[Agents](#agents) · [Several agents at once](#several-agents-in-one-prompt) · [Agent Board](#agent-board) · [The editor](#the-editor) · [Git](#git-and-pull-requests) · [Breeze Space](#breeze-space) · [Settings](#settings-and-usage) · [Everything else](#everything-else) · [Benchmarks](#benchmarks) · [Getting started](#getting-started) · [Project layout](#project-layout) · [License](#license)</sub>

<br>

<img src="docs/screenshots/hero.jpg" alt="Breeze Code with app.js open. Claude is editing it in the agents panel on the right, and the files it is working on are tagged Builder in the explorer" width="100%">

</div>

<br>

## What it is

- **An editor first.** Tabs, split editors, a terminal, Git, a debugger, live preview and language servers. All of it works with no agent connected.
- **Agents you already have.** Breeze finds Claude Code, Codex, Antigravity and OpenCode on your PC and uses their own sign-in. Or point it at a local model.
- **Free.** No plans or credits. You only pay for an agent if you pick a paid one, and a local model needs no internet at all.
- **Local.** Your files stay on your PC. API keys and sign-in tokens are encrypted with the system keychain (Windows DPAPI, macOS Keychain, or the Linux secret store). Updates ask before they download.
- **Windows, macOS and Linux.** Every release ships a Windows installer, a macOS `.dmg` and `.zip` for Apple Silicon, and a Linux `.AppImage` and `.deb` for x64.

## Agents

| Agent | How Breeze talks to it | Usage shown in Settings |
| --- | --- | --- |
| <img src="assets/icons/claude.svg" height="16" alt=""> **Claude Code** | The `claude` CLI | Tokens this month, plus the 5-hour, weekly and weekly Fable limits |
| <img src="assets/icons/codex.png" height="16" alt=""> **Codex** | The `codex` CLI | Tokens this month, plus its live plan window |
| <img src="assets/icons/antigravity.png" height="16" alt=""> **Antigravity** | Antigravity's agent service | Antigravity doesn't report usage |
| <img src="assets/icons/opencode.svg" height="16" alt=""> **OpenCode** | The `opencode` CLI | OpenCode doesn't report usage |
| <img src="assets/icons/ollama.svg" height="16" alt=""> **Local model** | Ollama, LM Studio or any OpenAI-compatible server | None, it runs on your PC |

Each prompt runs in one of three modes:

- **Ask** answers questions and doesn't change files.
- **Build** makes the changes.
- **Plan** writes a numbered plan first. You approve it in the chat or ask for changes, then it gets built.

While an agent works:

- **Thinking steps.** A **Thinking** header with the agent's logo and a live timer opens into each step it took and how long it took. Tool calls are listed too.
- **Every read, edit and command** shows up in the agents panel as it happens.
- **Steer mid-task.** Send a new message to a running Claude Code agent to change its course without stopping it.
- **Questions you can click.** An agent can ask you a question as a card with buttons instead of guessing.
- **Pictures and test results.** Agents can show you an image or a preview screenshot. Test runs (node:test, Jest, Vitest, pytest, cargo test) appear as a card with the pass and fail counts and each failure.
- **Image attachments.** Drop or paste images into a prompt. Pasted images go to a temp folder, so nothing is added to your project.

Pick each agent's model and effort from its chip. Effort goes up to **Max** for Claude Code, OpenCode and Antigravity; Codex uses its highest level, `xhigh`. By default agents stay inside the project and keep out of `.env` and `.git`; the **Full access** switch in the agent menu lifts that.

The **plan usage meter** in the prompt box opens every plan window (5-hour, weekly) with a bar and a percentage, and turns to a warning colour when usage runs high.

Past chats are saved per project. **New chat** files the current one away and the clock button brings it back.

## Several agents in one prompt

@mention agents from different companies in one prompt and each takes a part of the job. Before they start, each one claims the files it will touch. If two claim the same file, you choose who gets it. Then they work at the same time, and every line in the chat says which agent wrote it. If an agent edits a file it didn't claim, Breeze undoes that edit and tells you.

```mermaid
flowchart LR
    P["Your prompt<br/>@Claude frontend<br/>@Codex backend"] --> S{"Breeze splits<br/>the task"}
    S --> C["Claude claims<br/>src/ui/, index.html"]
    S --> X["Codex claims<br/>server/, package.json"]
    C & X --> O{"Overlap?"}
    O -- "yes" --> Y["You pick<br/>who gets it"]
    O -- "no" --> B
    Y --> B["Both work<br/>at the same time"]
    B --> L["One chat,<br/>every line tagged"]
    B -. "edits another<br/>agent's file" .-> G["Breeze undoes it<br/>and tells you"]
```

<img src="docs/screenshots/multi-agent.jpg" alt="Claude and Codex working from one prompt, with a Who does what card showing each agent's files and who owns the overlap" width="100%">

## Agent Board

Run agents side by side. Open the board with `Ctrl+Shift+B`, the board button in the activity bar, or the **Code / Agent Board** switch in the title bar.

- **Boxes.** Click the empty box to pick an agent, or drag a chat in from the side bar. Each box has its own agent, model, effort and prompt, and the boxes run at the same time. Resize the tiles, or give a box a live file pane with its **Code** switch to watch what it writes.
- **File ownership.** A file belongs to the first box that edits it. If another box edits it, Breeze puts the file back and relays the change to the owner. The owner's answer goes back to the asker.
- **Relay limits.** After three relays between the same two boxes Breeze pauses the loop. The **Auto-relay** switch turns relaying off.
- **Chats in the side bar.** The board's side bar lists your Breeze chats and your earlier Claude Code and Codex chats (read from their own logs). Any of them can be carried on in a box, and **History** reopens older ones.

## The editor

<img src="docs/screenshots/live-preview.jpg" alt="styles.css open with colour swatches next to each hex value, and the live preview of index.html on the right" width="100%">

<sub>A stylesheet with colour swatches, and the page it styles in the live preview.</sub>

- **Tabs and splits.** Drag tabs to reorder them or drop one to the side to split the editor. Minimap, auto save, go to file or line, find and replace.
- **Huge files.** Text files open and save through a small Rust engine that runs next to the app. Only the lines on screen are drawn, so files up to 2 GB open and edit without loading the whole thing into the editor.
- **Language servers.** Completions, hover, go to definition, find references, rename, and errors underlined as you type. JavaScript and TypeScript work out of the box. Python, Rust, Go and C/C++ use pyright, rust-analyzer, gopls or clangd if you have them installed.
- **Colour swatches.** Every hex colour gets a small box of that colour. Click it to open a picker; each change is one undo step.
- **Multi-cursor.** Alt+Click adds a cursor. Ctrl+D picks the next match, Ctrl+Shift+L picks all of them, Shift+Alt+drag selects a column.
- **Emmet.** Type `ul>li*3` in HTML, JSX or CSS and press Tab.
- **Live preview.** Open `index.html` beside your code and it refreshes as you type. Right-click an element to see its tag, id and classes, or edit its text in place. Markdown files preview as formatted pages and can be edited there too.
- **Word, Excel, PowerPoint and PDF.** `.docx`, `.xlsx`, `.pptx` and `.pdf` files open in the editor and save back, with pictures and other binary parts kept as they were.
- **Explain with Agents.** Select code, right-click, and your agents give you an explanation card.
- **Command Palette.** Ctrl+Shift+P or F1, then type a few letters of any command. The ones you used last come first.
- **Super Error Alert.** Optional (Settings → Miscellaneous). When a file you run or compile fails, the window's corners flash red and a siren sounds for 3 seconds.

### Run and debug

- **Run with F5.** Python, C, C++, C#, Java and Rust run on the compilers already on your PC (Cargo projects too). If one is missing, Breeze tells you what to install. JavaScript runs on Node in the terminal.
- **Debugger.** Step through Python, JavaScript, TypeScript, C, C++, C#, Rust and Java. Click a line number (or press F9) to set a breakpoint, then watch variables, the call stack and your program's output.
- **Notebooks.** `.ipynb` files open as cells you can edit and run in Python. Text, tables, images and matplotlib plots show as outputs.

<details>
<summary>What each debugger needs</summary>

| Language | Needs |
| --- | --- |
| Python | `debugpy` (Breeze offers to install it) |
| JavaScript, TypeScript | Node. TypeScript needs Node 22.18 or newer |
| C, C++, Rust | GCC and GDB 14 or newer (MinGW-w64 from MSYS2 or WinLibs) |
| C# | The .NET SDK. Breeze downloads the netcoredbg debugger when you ask (Windows x64, Apple Silicon Macs, Linux x64 and arm64) |
| Java | A JDK. Conditions, hit counts, logpoints and watches all work. Breeze works out expressions itself (arithmetic, comparisons, `&&`/`||`, `?:`, fields, `arr[i]`, `arr.length` and String methods such as `equals()` and `startsWith()`). It doesn't call other methods, since that would run your program's code while it's paused |

</details>

<table>
<tr>
<td width="50%"><img src="docs/screenshots/debugger.jpg" alt="The debugger paused on a breakpoint, with the call stack, variables, watches and program output"><br><sub>The debugger stopped at a breakpoint</sub></td>
<td width="50%"><img src="docs/screenshots/palette.jpg" alt="The Command Palette filtering commands by the word toggle"><br><sub>The Command Palette</sub></td>
</tr>
</table>

## Git and pull requests

<img src="docs/screenshots/source-control.jpg" alt="Source Control with three changed files, a commit message typed in, a list of checkpoints, and the diff of app.js" width="100%">

- Stage, discard, commit and push from Source Control. Commits are listed as checkpoints, with the branch graph.
- Click a changed file to see its diff.
- Files an agent is editing are marked in the explorer and on their tabs.
- Commit messages can be written for you from the staged changes.
- **Pull requests.** Read, comment on, merge or close GitHub pull requests without leaving Breeze.
- **Merge conflicts** are resolved in a separate worktree, so your own checkout is never touched. **Conflict Duel** has one agent argue for each side, then a third proposes a merged version you can accept, edit or reject.

## Breeze Space

<img src="docs/screenshots/space-chat.jpg" alt="Breeze Space with a question about converting miles to kilometres and Claude's reply as a snippet.py code card" width="100%">

A chat-only view with no editor. The conversation runs edge to edge, scrolling behind the title bar and the floating prompt. Code in a reply becomes a card you can copy or save in one click. You can open a terminal beside the chat, and chats are grouped by the folder they started in. Switch between Breeze Space and the editor with the button at the top right.

**Tasks.** Breeze Space reads each message with plain rules, so there is no extra AI call. A question stays a normal reply. A message with several jobs, a list of steps, a chore on a connected service (email, Discord, Slack) or a schedule such as "every morning" or "when tests fail" becomes a task. You approve a plan, it runs step by step in the same chat, and Stop cancels it. Start a message with `/task` or `/chat` to choose yourself, and send `/stop` to remove the chat's tasks. Tasks run on Claude Code or Codex.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/space-terminal.jpg" alt="Breeze Space with a terminal panel open beside the chat"><br><sub>A terminal beside the chat</sub></td>
<td width="50%"><img src="docs/screenshots/vibe.jpg" alt="Vibe Code Mode over the dimmed editor, with a feed card and the agent's live status"><br><sub>Vibe Code Mode</sub></td>
</tr>
</table>

## Settings and usage

<table>
<tr>
<td width="50%"><img src="docs/screenshots/settings-agents.jpg" alt="Settings, Agents page, with the installed agents, Claude's 5-hour and weekly limits, and a tokens per day chart"></td>
<td width="50%"><img src="docs/screenshots/appearance.jpg" alt="Settings, Appearance page, with theme cards, the Glass switch, syntax colour presets and custom colours"></td>
</tr>
<tr>
<td valign="top"><b>Agents.</b> Install and sign in to agents, set the default, and see how much of each plan you've used.</td>
<td valign="top"><b>Appearance.</b> Dark, high contrast and light themes. Glass makes the window see-through, or set your own background picture. Pick a syntax colour preset or your own colours, and the font size. Settings also has a search box and a **Performance** option: the power saver drops blur and looping motion on battery or slower machines.</td>
</tr>
</table>

<img src="docs/screenshots/home-agent.jpg" alt="Home, Agent tab, showing tokens this month, plan limits, and a tokens per day chart with an estimated API cost" width="70%">

<sub>Home → Agent: 30 days of token use per agent and what it would have cost at API prices (an estimate). Pick a year on the GitHub contribution graph, and drag the graph into the left, right or bottom dock.</sub>

## Everything else

| | |
| --- | --- |
| **Home** | New file, open folder or clone a repository, your recent projects and your GitHub contributions |
| **First launch** | Looks for coding agents, Git, Node.js and your compilers, and lets you pick a theme and an agent |
| **Terminal** | A built-in terminal. Pop it out into its own window (with a system info banner) and the same sessions keep running. Glass and your background picture reach it too |
| **Skills, Plugins and MCP** | A pop-up from the chats side bars: browse the skills and plugins your agents load, share skills between agents, and connect MCP servers for Claude Code without editing its config |
| **Workspace sync** | Move workspaces between computers signed in to the same account, stored in a private GitHub repo or Google Drive's hidden app folder |
| **Image attachments** | Drop or paste images into a prompt. Pasted images go to a temp folder, so nothing is added to your project |
| **Local models** | Requests stay small (a project map, ranged file reads and snippet edits) so they fit a small context window |
| **Accounts** | Sign in with GitHub or Google, with more than one account |
| **Vibe Code Mode** | Dims the editor and plays an Instagram or Facebook feed while an agent works, then a card tells you when the code is ready. Works in Breeze Space too |
| **Tips** | The first time you open each screen, a blue tip points at where to start |
| **What's new** | After an update, a blue **What's new** in the title bar opens that release's notes |
| **Reopens where you left off** | Breeze starts in the view you last used |
| **Discord** | Rich Presence shows what you're working on |
| **Sounds** | Small sounds for clicks, typing and agents, with a volume slider |

## Benchmarks

Measured with [`scripts/bench.js`](scripts/bench.js) (`npm run bench`) on November 23, 2026. Each editor had its own clean profile with no extensions. It opened the same TypeScript project (Breeze's own `src/main`, 55 files) or one 500 MB log file. Times run from launch until the file's first line is drawn, read over the Chrome DevTools Protocol. Memory is the whole process tree's private working set (Task Manager's Memory column) 20 seconds later. Each number is the median of 3 warm starts after one warm-up run that isn't counted.

| Editor | TypeScript project: start-up | TypeScript project: memory | 500 MB file: start-up | 500 MB file: memory |
| --- | ---: | ---: | ---: | ---: |
| **Breeze Code 0.8.1** | 4.76 s | **522 MB** | 5.70 s | **841 MB** |
| VS Code 1.146 | **2.27 s** | 1,589 MB | 8.52 s | 881 MB |
| Antigravity IDE 1.1.3 | 3.60 s | 1,900 MB | 5.70 s | 1,271 MB |

<sub>Windows 10 22H2, Intel Core i5-12500H, 16 GB RAM. Raw runs: [`reports/bench-2026-11-23.json`](reports/bench-2026-11-23.json).</sub>

- **Memory:** with a project open, Breeze used about **3× less** than VS Code and **3.6× less** than Antigravity. With the 500 MB file the three are much closer, and Breeze and VS Code are within 5%.
- **Start-up:** VS Code opens a project about 2.5 s sooner than Breeze. Breeze opens the 500 MB file about 2.8 s sooner than VS Code.
- These are one machine's numbers with no agents running. An agent session adds its own CLI process (Claude Code, Codex and so on), which these numbers leave out. Run `npm run bench` on your own machine to compare; it finds VS Code, Cursor, Windsurf and Antigravity if they're installed.

## Getting started

You need [Node.js](https://nodejs.org/) 20 or newer. To build the document engine you also need [Rust](https://rustup.rs/).

```bash
npm install
npm run build:engine
npm start
```

`npm start` compiles the TypeScript (main process and renderer) and opens the app. The compiled `.js` files are build output and aren't committed.

> [!TIP]
> Run `npm run build` once, then open `src/renderer/breeze.html` in a browser for a demo of the UI with a sample project and canned agent runs. No Electron needed.

| Script | What it does |
| --- | --- |
| `npm start` | Compile and run the app |
| `npm run build` | Compile TypeScript only |
| `npm run watch` | Compile on change |
| `npm run build:engine` | Build the Rust document engine |
| `npm test` | Compile, syntax-check the main process and run the tests |
| `npm run test:engine` | Run the engine's Rust tests |
| `npm run dist` | Build the Windows installer into `dist/` |
| `npm run dist:mac` | Build the macOS `.dmg` and `.zip` (run on a Mac) |
| `npm run dist:linux` | Build the Linux `.AppImage` and `.deb` (run on Linux) |
| `npm run bench` | Time start-up and measure memory against other editors installed on this machine (see [Benchmarks](#benchmarks)) |

### Configuration

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

Environment variables override the config file. Both `breeze.config.json` and `.env` are gitignored; don't commit them.

- **GitHub:** create an OAuth App and enable *Device Flow* (no secret needed).
- **Google:** create a *Desktop app* OAuth client.
- **Discord:** create an application and use its Application ID.

> [!TIP]
> Breeze assumes a local model has a 4k-token context on Ollama and 8k elsewhere. If you raised your server's context size, set `llmContext` in Breeze's saved state so the agent can use the extra room.

### Building the installer

```bash
npm run dist
```

This writes `breeze.config.json` from your `.env` (`scripts/write-config.js`), builds the engine, then builds `dist/Breeze-Code-Setup-<version>.exe` with electron-builder. `npm run dist:mac` and `npm run dist:linux` do the same for macOS and Linux. They have to run on that system, because the Rust engine is compiled for the machine it's built on.

Pushing a `v*` tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml), which builds the macOS (Apple Silicon) and Linux builds on GitHub's runners and attaches them to the release. Linux builds need `libxdo-dev libxkbcommon-dev libxcb1-dev libx11-dev libxtst-dev` for the `hands/` helper; the workflow installs them.

> [!WARNING]
> The builds are unsigned unless you set the `CSC_LINK` signing secrets, so Windows SmartScreen and macOS Gatekeeper may warn on other machines (on a Mac, right-click the app and choose Open the first time). Anything bundled into an installer can be extracted by whoever has it, so only put public client ids (and Google's desktop-app secret, which isn't confidential) in `.env` when building.

## Project layout

```mermaid
flowchart TB
    subgraph R["Renderer · src/renderer"]
        UI["breeze.html + breeze.css"]
        F["breeze/*.ts<br/>one file per feature"]
        E["editcore.ts + codeview.ts<br/>the code editor"]
    end
    PL["preload.ts<br/>the bridge"]
    subgraph M["Main process · src/main"]
        MJ["main.ts<br/>files, terminal, Git, auth, runs"]
        T["team.ts + mentions.ts<br/>multi-agent prompts"]
        G["guard.ts + pathguard.ts<br/>path and command safety"]
        TC["toolchains.ts<br/>compilers for F5"]
        AB["agentbrain.ts<br/>local model context"]
        EN["engine.ts<br/>engine client"]
    end
    RE["Rust engine · engine/<br/>opens, edits and saves text"]
    subgraph A["Agents"]
        CL["Claude Code CLI"]
        CX["Codex CLI"]
        AG["Antigravity"]
        LL["Local model server"]
    end
    R <--> PL <--> M
    EN <--> RE
    MJ --> CL & CX & AG
    AB --> LL
```

| Path | Purpose |
| --- | --- |
| `src/main/main.ts` | Electron main process: files, terminal, agent runs, usage, Git, auth |
| `src/main/team.ts`, `mentions.ts` | Splitting one prompt between several agents, file claims and crossings |
| `src/main/agentbrain.ts` | The local model's context budget, project map and file-tool formats |
| `src/main/antigravityAgentService.ts` | Talks to Antigravity's agent service |
| `src/main/engine.ts`, `docregistry.ts` | Starts the Rust engine and tracks the documents open in it |
| `src/main/preload.ts` | Bridge between the main process and the UI |
| `src/main/toolchains.ts` | Compiler and tool detection for Run |
| `src/main/lsp.ts` | Language servers |
| `src/main/debug*.ts`, `dap.ts`, `cdp.ts`, `jdwp.ts` | Debugger backends (Python, Node, GDB, .NET, Java) |
| `src/main/kernel.ts` | Python kernels for notebooks |
| `src/main/github.ts`, `prconflict.ts` | Pull requests and conflict resolution in a throwaway worktree |
| `src/main/board.ts`, `agentlogs.ts` | The Agent Board's file ownership and relays, and reading Claude Code and Codex chat logs |
| `src/main/agentintent.ts`, `agentcore.ts`, `agentmemory.ts` | Breeze Space tasks: reading a message, plans, schedules and triggers, and task memory |
| `src/main/breezemcp.ts`, `askuser.ts` | The MCP server Breeze hosts so CLI agents can ask you questions, get a plan approved or show a picture |
| `src/main/officefile.ts` | Word, Excel, PowerPoint and PDF files as editable text |
| `src/main/power.ts` | The power saver |
| `src/main/skills.ts`, `mcp.ts` | Skills, plugins and MCP servers |
| `src/main/sync.ts` | Workspace sync |
| `src/main/previewServer.ts`, `previewInspector.ts` | The live preview and its element inspector |
| `src/main/pricing.ts` | API-price estimates for Home's Agent tab |
| `src/main/discord.ts` | Discord Rich Presence |
| `src/main/guard.ts`, `pathguard.ts` | Path and command safety checks |
| `src/renderer/breeze.html`, `breeze.css` | UI |
| `src/renderer/breeze/` | Renderer logic, one file per feature, loaded in order by `breeze.html` |
| `src/renderer/editcore.ts`, `codeview.ts` | The editor's position logic and its virtualized text surface |
| `engine/` | The Rust document engine (opening, editing, undo journal, search, saving) |
| `assets/brand/` · `fonts/` · `icons/` | App icon and wordmarks · bundled fonts · agent and feed logos |
| `runtime/` | C runtime helpers |
| `hands/` | A Rust mouse and keyboard helper. Nothing in the app calls it yet |
| `scripts/` | Build helpers |
| `docs/screenshots/` | Screenshots used in this README |
| `test/` | Tests |

## Team

| Member | Role |
| --- | --- |
| [@itsphatto](https://github.com/itsphatto) | Founder and Lead Software Engineer |
| [@sapfire151](https://github.com/sapfire151) | Co-Founder, Lead Frontend Developer and UI/UX Designer |
| [@LangZab](https://github.com/LangZab) | Contributor |
| [@esrazti](https://github.com/esrazti) | Contributor |

## License

Breeze Code is free, source-available software under the [Breeze Code Source-Available License](LICENSE). You can read the source and use Breeze Code for anything, including commercial work. You can't copy its code into other projects or redistribute it, changed or not. Versions published before November 7, 2026 stay under the MIT License.
