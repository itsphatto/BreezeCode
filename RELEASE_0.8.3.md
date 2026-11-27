## Breeze Code 0.8.3

Every folder keeps its own agent board and second brain, the linter moves to Rust, and new users get tips to find their way.

### New

- **An agent board for each folder.** Opening another folder leaves the last folder's agents working. Each box runs on its own folder's board.
- **The second brain lives in your project.** Each folder keeps it in `.breezecode/` (`brain.json`, plus `brain.md` for any agent to read). It stays private to your computer: `.breezecode/` is added to the repository's `.git/info/exclude`. A brain saved in app data moves into its project the first time you open it.
- **Agents without Breeze's tools** are pointed to `.breezecode/brain.md` when the folder has memories.
- **Tips for new users** show you around on first run.
- **Pictures in agent chats.** API and local agents can take images. *(by @Sapfire151)*
- **A new launch.** The light flies in across the screen before the window opens.

### Improved

- **The linter runs in Rust**, in Breeze's engine, for code, CSS, JSON, markup, Python and Rust, with a fix for wrong results.
- **Agent edits** can replace every match at once, and search results show the lines around each hit. *(by @Sapfire151)*
- **Second brain links are unlimited.** Each memory keeps all its links. Before, its last link was dropped.
- **UI sounds** are crisper and drier.
- **Preview** handles whitespace in text better.

### Removed

- **The Full access button** in Settings.

### Thanks

Thanks to **@Sapfire151** for images and edits in agent chats.

**Full changelog:** https://github.com/itsphatto/BreezeCode/compare/v0.8.2...v0.8.3
