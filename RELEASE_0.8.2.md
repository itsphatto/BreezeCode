## Breeze Code 0.8.2

DeepSeek joins your agents, every folder gets a second brain, and Breeze runs and debugs more languages.

### New

- **DeepSeek agents.** Use DeepSeek with an API key, or through the DeepSeek CLI (developer preview, needs Node.js 24.9 or newer). The CLI works on its own for now, not in teams or on the Agent Board.
- **Second brain.** Breeze saves what your agents learn as they compact and summarize, and they can look it up later. Open it from the Agent Board side bar to see a folder's memories as a graph or a list.
- **In-app browser** in Agent Board boxes, with tabs and an address bar.
- **Subagent chats.** Claude's subagents show their work in a chat of their own.
- **Answer buttons.** When an agent ends with a question, its suggested answers show as buttons.
- **Go debugging** with Delve.
- **Run and debug `.jsx` and `.tsx`**, and debug `.cts`.
- **Run shell, PowerShell and batch scripts.**
- **Java expressions** in watches, breakpoint conditions and logpoints. *(by @Sapfire151)*

### Improved

- **Your instruction files.** API and local agents now follow your `CLAUDE.md` and `AGENTS.md`. *(by @Sapfire151)*
- **API keys in Settings.** Remove saved keys from Settings → Agents. *(by @Sapfire151)*
- **Fable** is offered only when your Claude plan includes it. *(by @Sapfire151)*
- **Setup** moves more smoothly between steps. *(by @Sapfire151)*
- **Git graph.** Lanes keep their line weight and stay compact when there are many. *(by @Sapfire151)*
- **Power saver** keeps the glass blur and only pauses looping animations and idle work. *(by @Sapfire151)*
- **New chats on the board** open with a centered greeting and the agent's logo.

### Removed

- **Friends.** The Friends page, its settings and activity sharing are gone. Discord presence still works.
- **The Code / Agent Board switch** in the title bar. Use the Agent Board icon in the activity bar, or Ctrl+Shift+B.

### Thanks

Thanks to **@Sapfire151** for the Java expressions, agent instructions, setup and git graph work.

**Full changelog:** https://github.com/itsphatto/BreezeCode/compare/v0.8.1...v0.8.2
