## Breeze Code 0.7.9

Switch between Code and the Agent Board in one click, see what your agents are thinking, and keep an eye on your plan usage.

### New

- **Code / Agent Board switcher.** A pill switch in the title bar moves you between the editor and the Agent Board. The board has its own matching switch.
- **Agent thinking steps.** While an agent works, a **Thinking** header (with the agent's logo and a live timer) opens into each step it has taken and how long it took. Tool calls are listed too. Breeze remembers whether you keep it open.
- **Max reasoning effort.** A new **Max** level for Claude Code, OpenCode and agy. Codex uses its highest level, `xhigh`.
- **Claude Code and Codex chats in the board side bar.** The Agent Board side bar now lists your earlier Claude Code and Codex chats, read from their own logs.
- **Plan usage menu.** A usage meter in the prompt box opens every plan window (5-hour, weekly) with a bar, percentage and note. It turns to a warning colour when usage runs high. *(by @Sapfire151)*
- **Super Error Alert.** Turn it on in Settings > Miscellaneous. When a file you run or compile fails, the window's corners flash red and a siren sounds for 3 seconds. Runs you stop yourself do not trigger it.

### Improved

- **Breeze Space, edge to edge.** The conversation now scrolls behind the title bar and under the floating prompt, with fades that blur more toward each edge. User messages get a light frost. *(by @Sapfire151)*
- **Stop button.** The send button fades from blue to red while the agent works. *(by @Sapfire151)*
- **Dashboard motion.** Chart bars glide to their new size when you change the range, and usage numbers roll their changed digits like a clock. *(by @Sapfire151)*
- **Preview Edit Manually on Markdown.** Breeze now finds the exact words you changed on a Markdown page, even when the same text appears more than once.
- **Consistent styling.** Menus, suggestions, hover cards and the find bar share one frosted glass look. Inline rename and edit fields match across the Explorer, tabs and debugger. *(by @Sapfire151)*

### Changed

- **Agentic tasks run in the background.** The separate menus, task lists and settings for agentic tasks are gone. Tasks now run backend-only. *(by @Sapfire151)*

### Thanks

Big thanks to **@Sapfire151** for the Breeze Space redesign, plan usage menu, stop-button animation, and the design token cleanup in this release.

**Full changelog:** https://github.com/itsphatto/BreezeCode/compare/v0.7.8...v0.7.9
