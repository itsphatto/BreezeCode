# Breeze Code 0.8.4

GitHub Copilot joins your agents, board boxes can tag in other agents, chats survive a reload, and Gemini 3 works properly.

## New
- **GitHub Copilot agent.** Use the GitHub Copilot CLI as an agent, and install it from Breeze. VS Code's stub `copilot` launcher is not mistaken for the real CLI. (by @Sapfire151)
- **@tag agents on the Agent Board.** Mention other agents in a board box's prompt and they join its chat, answering the last message one after another. The agent answering now shows as a guest chip in the box header, and its model chip sets that agent's own model.
- **Chats survive reloads and crashes.** A reloaded or crashed window reattaches to the chats that were still running. After a crash the window reloads itself, at most once every 10 seconds. File → Exit closes the window instead of quitting while an agent is still working. (by @Sapfire151)
- **Live chat artifacts.** Ask the built-in agent for a demo, chart, diagram or mockup and it answers with one self-contained HTML, SVG or Mermaid artifact, checked before it replies. Tools can now return several pictures at once. (by @Sapfire151)
- **Search from the title bar.** The project pill opens into a search for files and commands, right where it sits.
- **Moved folders keep their data.** Rename or move a project folder and its second brain, agent memory, chats, sessions, tasks and settings follow it to the new path.
- **Gemini effort.** Pick how hard Gemini thinks. Low and Medium map straight across; Extra and Max run as High, Gemini's top setting. (by @Sapfire151)

## Improved
- **Faster Gemini 3 agent steps.** Gemini thinks at low effort for each tool step unless you pick another effort, and keeps its own temperature.
- **Launch intro** stays inside the app window, with a bubbling light instead of a fly-in across the desktop.
- **Resize sounds** for windows and panels.
- `.env.example` and other `.env` templates can be read by agents; real `.env` files stay blocked.
- Google's newer `AQ.` API keys are recognised as secrets.

## Fixed
- Gemini 3 tool calls no longer break on the next step (each call's thought signature is now sent back).
- A saved Gemini model that Google stops offering switches to the newest Flash instead of failing.
- **Windows debugging:** breakpoints bind in scripts loaded from short (8.3) paths; GDB no longer exits at once with WinLibs builds or a foreign `PYTHONHOME`; a failed Rust build hints `rustup target add` when the windows-gnu target is missing.
- The new-chat button in the Agent Board side bar can be dragged.

## Removed
- Tips for new users.
- Gemini 1.x and 2.x models, which Google refuses for new users.

## Thanks

Thanks to @Sapfire151 for the GitHub Copilot agent, chats that survive reloads, live artifacts and the Gemini effort setting.

**Full changelog**: https://github.com/itsphatto/BreezeCode/compare/v0.8.3...v0.8.4
