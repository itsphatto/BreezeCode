# Grassroots demand signals for missing developer-tool features

Method note: GitHub numbers come from the GitHub Search API (`is:issue is:open`, sorted by reactions), fetched 2026-11-16. "Reactions" = total reactions; "+1" = thumbs-up only. Dates are issue creation dates. YouTrack numbers come from the YouTrack REST API (`#Unresolved sort by: votes desc`, project IDEA). Bugzilla numbers come from the Bugzilla REST API (`product=DevTools`, unresolved, sorted by votes). Counts are as returned by the API at fetch time and may be slightly stale. Reddit could not be accessed (see Gaps).

## 1. What are the most-upvoted open feature requests in VS Code, JetBrains, Zed, Neovim, Helix, Firefox/Chrome DevTools?

### Takeaway
The highest-reaction open requests are mostly long-standing (2015-2021) customization and workspace-model asks in VS Code (workbench font size at 4,844 reactions, mouse shortcuts, settings inheritance, multi-root windows). In the newer editors (Zed, Helix), top requests center on Git/diff/merge workflows, debugging/test integration, settings sync, and multi-window use. In 2025-2026 VS Code's newest high-reaction issues are about AI control (BYOK/local models, ACP) and pushback on forced UI/Copilot changes.

### Cited Findings

**VS Code (microsoft/vscode), open feature requests, top by reactions**
- "Allow to change the font size and font of the workbench" (#519), opened 2015-11-24, 604 comments, 4,844 reactions (3,803 +1) — [issue](https://github.com/microsoft/vscode/issues/519)
- "Allow customization of mouse shortcuts" (#3130), 2016-02-18, 453 comments, 2,565 reactions (1,935 +1) — [issue](https://github.com/microsoft/vscode/issues/3130)
- "Show all errors and warnings in project for all JavaScript and TypeScript files, not just opened ones" (#13953), 2016-10-18, 210 comments, 2,005 reactions (1,511 +1) — [issue](https://github.com/microsoft/vscode/issues/13953)
- "Visual Studio Code for ipad" (#70764), 2019-03-19, 285 comments, 2,100 reactions (1,348 +1) — [issue](https://github.com/microsoft/vscode/issues/70764); a newer duplicate-style request "Please bring native Visual Studio Code support to iPadOS" (#255717), 2025-07-14, 29 comments, 173 reactions — [issue](https://github.com/microsoft/vscode/issues/255717)
- "Add ability to extend from other settings files" (#15909), 2016-11-22, 161 comments, 1,732 reactions (1,371 +1) — [issue](https://github.com/microsoft/vscode/issues/15909)
- "Macro recording" (#4490), 2016-03-21, 280 comments, 1,680 reactions (1,229 +1) — [issue](https://github.com/microsoft/vscode/issues/4490)
- "VIM mode like sublime" (#114851), 2021-01-24, 26 comments, 1,640 reactions (1,370 +1) — [issue](https://github.com/microsoft/vscode/issues/114851)
- "Allow to scope settings by platform" (#5595), 2016-04-21, 187 comments, 1,609 reactions (1,152 +1) — [issue](https://github.com/microsoft/vscode/issues/5595)
- "Local Workspace settings" (#40233), 2017-12-14, 204 comments, 1,472 reactions — [issue](https://github.com/microsoft/vscode/issues/40233)
- "Allow diagnostics messages to have markdown (or formatted text) content" (#54272), 2018-07-13, 64 comments, 1,439 reactions (1,051 +1) — [issue](https://github.com/microsoft/vscode/issues/54272)
- "Allow to open multiple workspaces in the same window" (#43188), 2018-02-08, 220 comments, 1,227 reactions — [issue](https://github.com/microsoft/vscode/issues/43188)
- "Implement Google Chrome-like grouped tabs" (#100335), 2020-06-16, 164 comments, 1,187 reactions — [issue](https://github.com/microsoft/vscode/issues/100335)
- "Enable/disable extensions from config file" (#40239), 2017-12-15, 437 comments, 1,181 reactions — [issue](https://github.com/microsoft/vscode/issues/40239)
- "Extract the integrated terminal" (#34442), 2017-09-15, 149 comments, 1,186 reactions — [issue](https://github.com/microsoft/vscode/issues/34442)
- "Support variables when resolving values in settings" (#2809), 2016-02-09, 209 comments, 936 reactions — [issue](https://github.com/microsoft/vscode/issues/2809)
- "Support syntax highlighting with tree-sitter" (#50140), 2018-05-19, 124 comments, 929 reactions (739 +1) — [issue](https://github.com/microsoft/vscode/issues/50140)
- "Customizable status bar item locations" (#35744), 2017-10-06, 78 comments, 903 reactions — [issue](https://github.com/microsoft/vscode/issues/35744)

**VS Code, newest high-reaction open issues (created since 2023-11)**
- "Preserve option to keep current UI: The so-called Modern UI is disgusting and objectively inferior" (#326146), 2026-07-16, 143 comments, 376 reactions — [issue](https://github.com/microsoft/vscode/issues/326146); related "the new VSCode UI, looks cute, i don't like it." (#325240), 2026-07-10, 116 comments, 253 reactions — [issue](https://github.com/microsoft/vscode/issues/325240)
- "Add support in vscode for Agent Client Protocol (ACP)" (#265496), 2025-09-06, 49 comments, 348 reactions — [issue](https://github.com/microsoft/vscode/issues/265496)
- "Support BYOK/Custom Models for Inline Code Completions" (#318545), 2026-05-27, 83 comments, 332 reactions — [issue](https://github.com/microsoft/vscode/issues/318545); "Copilot Autocomplete with local / custom models" (#263535), 2025-08-27, 22 comments, 207 reactions — [issue](https://github.com/microsoft/vscode/issues/263535)
- "VS Code should default to Wayland when possible" (#207033), 2024-03-07, 84 comments, 239 reactions — [issue](https://github.com/microsoft/vscode/issues/207033)
- "Adding 'Copilot' menu for users who already uninstalled Copilot is deeply offensive" (#237819), 2025-01-13, 76 comments, 255 reactions — [issue](https://github.com/microsoft/vscode/issues/237819)
- "Weekly updates are too frequent" (#309223), 2026-04-11, 81 comments, 200 reactions — [issue](https://github.com/microsoft/vscode/issues/309223)
- Anomaly: "Add `.astro` extension to the known extensions" (#205296), 2024-02-15, 0 comments yet 443 reactions (236 +1); the reaction-to-comment ratio suggests an unusual (possibly framework-community-driven) campaign, treat cautiously — [issue](https://github.com/microsoft/vscode/issues/205296)

**Zed (zed-industries/zed), open, top by +1**
- "Smooth scrolling" (#4355), 2023-11-13, 31 comments, 1,050 reactions (912 +1) — [issue](https://github.com/zed-industries/zed/issues/4355)
- "Test runner integration" (#5242), 2022-08-18, 53 comments, 934 reactions (898 +1) — [issue](https://github.com/zed-industries/zed/issues/5242)
- "Add support for jj SCM" (#21538), 2024-12-04, 59 comments, 805 reactions (579 +1) — [issue](https://github.com/zed-industries/zed/issues/21538)
- "easymotion vim" (#4930), 2023-03-15, 530 reactions; "Flash.nvim style search in a document" (#14801), 2024-07-19, 77 comments, 486 reactions — [#4930](https://github.com/zed-industries/zed/issues/4930), [#14801](https://github.com/zed-industries/zed/issues/14801)
- "Add secondary editor windows to support multi-monitor setup" (#9662), 2024-03-21, 54 comments, 508 reactions — [issue](https://github.com/zed-industries/zed/issues/9662); "Drag tab to open new window" (#6722), 2024-01-25, 333 reactions — [issue](https://github.com/zed-industries/zed/issues/6722)
- "Webview via Extensions" (#21208), 2024-11-26, 39 comments, 506 reactions — [issue](https://github.com/zed-industries/zed/issues/21208)
- "Support opening `.code-workspace` files" (#9459), 2024-03-17, 446 reactions — [issue](https://github.com/zed-industries/zed/issues/9459)
- "Make the Python experience wonderful" (#7808), 2024-02-15, 430 reactions — [issue](https://github.com/zed-industries/zed/issues/7808)
- "Zed downloads NodeJS binary and npm packages from Internet without user's consent" (#12589), 2024-06-02, 97 comments, 371 reactions — [issue](https://github.com/zed-industries/zed/issues/12589)
- "Support Difftastic for visualizing code diffs" (#9721), 2024-03-22, 348 reactions — [issue](https://github.com/zed-industries/zed/issues/9721)
- "iOS support for iPad" (#11889), 2024-05-16, 356 reactions — [issue](https://github.com/zed-industries/zed/issues/11889)
- "User configurable mouse bindings" (#10647), 2024-04-16, 239 reactions — [issue](https://github.com/zed-industries/zed/issues/10647)
- "Settings Sync: Built-in synchronization support" (#5010), 2023-02-14, 186 reactions — [issue](https://github.com/zed-industries/zed/issues/5010); re-opened as "Settings Sync" (#59978), 2026-06-26, 133 reactions — [issue](https://github.com/zed-industries/zed/issues/59978)
- "Traditional 'Find All References' views" (#5117), 2022-11-20, 224 reactions — [issue](https://github.com/zed-industries/zed/issues/5117)
- "Typescript server is slow on Zed compared to VSCode" (#18698), 2024-10-03, 77 comments, 181 reactions — [issue](https://github.com/zed-industries/zed/issues/18698)

**Zed, newest (created 2025+) high-reaction open issues**
- "Add support for Git 3-way merge" (#34813), 2025-07-21, 177 reactions — [issue](https://github.com/zed-industries/zed/issues/34813)
- "Commit partial changes / Line-by-line staging" (#45295), 2025-12-18, 158 reactions — [issue](https://github.com/zed-industries/zed/issues/45295)
- "Branch Merging" (#57982), 2026-05-28, 167 reactions — [issue](https://github.com/zed-industries/zed/issues/57982)
- "Side-by-Side Git Merge Conflict Resolution UI" (#58974), 2026-06-09, 104 reactions — [issue](https://github.com/zed-industries/zed/issues/58974)
- "Add PR-style review comments in Git Diff UI that feed into the active agent thread" (#59157), 2026-06-11, 162 reactions — [issue](https://github.com/zed-industries/zed/issues/59157)
- "Git Panel: Support for workspaces with multiple Git repositories" (#59221), 2026-06-12, 146 reactions — [issue](https://github.com/zed-industries/zed/issues/59221)
- "Support connecting to remote devcontainers (devcontainer on remote host)" (#59500), 2026-06-17, 158 reactions — [issue](https://github.com/zed-industries/zed/issues/59500)
- "RTL Right-to-Left Text Input/Rendering Support" (#31102), 2025-05-21, 45 comments, 205 reactions — [issue](https://github.com/zed-industries/zed/issues/31102)
- "Zed Offline Support (Meta Tracking Issue)" (#24878), 2025-02-14, 175 reactions — [issue](https://github.com/zed-industries/zed/issues/24878)
- "Support LaTex rendering in markdown preview" (#40813), 2025-10-21, 76 reactions — [issue](https://github.com/zed-industries/zed/issues/40813)
- "Ability to copy/paste files from the system file manager" (#29026), 2025-04-18, 115 reactions — [issue](https://github.com/zed-industries/zed/issues/29026)

**Neovim (neovim/neovim), open, top by +1**
- "nvim-treeconfig: upstream nvim-treesitter" (#39006), 2026-04-13, 23 comments, 539 reactions (346 +1) — [issue](https://github.com/neovim/neovim/issues/39006)
- "replace libvterm with libghostty / libvaxis / ghostty-vt" (#33155), 2025-03-29, 202 reactions — [issue](https://github.com/neovim/neovim/issues/33155)
- "Debug Adapter Protocol implementation" (#11732), 2020-01-18, 112 reactions — [issue](https://github.com/neovim/neovim/issues/11732)
- "Elastic Tabstops" (#1419), 2014-11-06, 122 reactions; "PCRE regex support" (#3208), 2015-08-20, 123 reactions; "Bidi language support" (#553), 2014-04-17, 107 reactions — [#1419](https://github.com/neovim/neovim/issues/1419), [#3208](https://github.com/neovim/neovim/issues/3208), [#553](https://github.com/neovim/neovim/issues/553)
- "unified interface for cmdline, fuzzy find/picker, completion" (#35456), 2025-08-24, 87 reactions — [issue](https://github.com/neovim/neovim/issues/35456)
- "TUI: kitty's keyboard protocol support" (#14400), 2021-04-19, 87 reactions — [issue](https://github.com/neovim/neovim/issues/14400)
- Neovim's reaction counts are much smaller than VS Code/Zed (top is about 540, then about 200), consistent with a smaller, more contributor-oriented tracker.

**Helix (helix-editor/helix), open, top by +1**
- "Add Code Folding" (#1840), 2022-03-18, 508 reactions (491 +1) — [issue](https://github.com/helix-editor/helix/issues/1840)
- "automatic reload when file changes externally" (#1125), 2021-11-18, 357 reactions — [issue](https://github.com/helix-editor/helix/issues/1125)
- "Persistent State (session)" (#401), 2021-07-03, 394 reactions — [issue](https://github.com/helix-editor/helix/issues/401)
- "Side by side file diffing" (#405), 2021-07-03, 258 reactions — [issue](https://github.com/helix-editor/helix/issues/405)
- "[Proposal] Builtin support for Integrated Terminal" (#1976), 2022-04-06, 337 reactions — [issue](https://github.com/helix-editor/helix/issues/1976)
- "Kakoune-style client-server model for sharing buffers across windows" (#312), 2021-06-19, 210 reactions — [issue](https://github.com/helix-editor/helix/issues/312)
- "Add file tree" (#200), 2021-06-09, 157 reactions; "VCS/git support" (#227), 2021-06-12, 123 reactions; "Debugging overhaul and redesign" (#5950), 2023-02-12, 272 reactions — [#200](https://github.com/helix-editor/helix/issues/200), [#227](https://github.com/helix-editor/helix/issues/227), [#5950](https://github.com/helix-editor/helix/issues/5950)

**JetBrains YouTrack (IDEA project), unresolved, by votes**
- IDEA-68854 "Problems View Like eclipse", 426 votes, created 2011-04-27, 112 comments
- IDEA-124520 "Eclipse RCP development support", 221 votes, 2014-04-27
- IDEA-100812 "OSGi support on a level similar to BndTools", 167 votes, 2013-02-11
- IDEA-15540 "Export breakpoints", 152 votes, 2007-10-08
- IDEA-252110 "Remote profiling support", 136 votes, 2020-10-02
- IDEA-262280 "Code completion for Gradle Version Catalogs in TOML files", 131 votes, 2021-02-17
- IDEA-134919 "Allow debug variables and/or watches to be saved for later inspection", 99 votes, 2015-01-02
- IDEA-114661 "Separate right margin configuration for documentation", 78 votes, 2013-10-09
- IDEA-54807 "Project settings own Debug Stepping / Only Step into the classes", 67 votes, 2010-05-09
- IDEA-332553 "Zig support", 53 votes, 2023-09-15 (the newest in the top 25)
- All from the [YouTrack API query](https://youtrack.jetbrains.com/api/issues?query=project:IDEA%20%23Unresolved%20sort%20by:votes%20desc&fields=idReadable,summary,votes,created,commentsCount&$top=25); individual issues are at `https://youtrack.jetbrains.com/issue/<ID>`. Vote counts are far lower in absolute terms than GitHub reactions (top is 426).

**Firefox DevTools (Bugzilla), unresolved, by votes**
- Bug 885508 "[meta] WebSocket Inspector", 66 votes, created 2013-06-20 — [bug](https://bugzilla.mozilla.org/show_bug.cgi?id=885508)
- Bug 1039678 "Add the equivalent of Chrome --disable-web-security to Firefox developer options to globally disable CORS", 36 votes, 2014-07-16 — [bug](https://bugzilla.mozilla.org/show_bug.cgi?id=1039678)
- Bug 771339 "Live function editing", 20 votes, 2012-07-05 — [bug](https://bugzilla.mozilla.org/show_bug.cgi?id=771339)
- Bug 991806 "[meta] Firebug Gaps", 19 votes, 2014-04-03 — [bug](https://bugzilla.mozilla.org/show_bug.cgi?id=991806)
- Bug 1219917 "When opening devtools in a separate window, reuse the same devtools window for all tabs", 19 votes, 2015-10-29 — [bug](https://bugzilla.mozilla.org/show_bug.cgi?id=1219917)
- Bug 1004678 "[meta] Debugger DOM Mutation Breakpoints", 18 votes, 2014-05-01; Bug 1262914 "Custom Formatters in devtools", 15 votes, 2016-04-07; Bug 1110207 "[meta] Network Throttling Control", 10 votes, 2014-12-11 — [1004678](https://bugzilla.mozilla.org/show_bug.cgi?id=1004678), [1262914](https://bugzilla.mozilla.org/show_bug.cgi?id=1262914), [1110207](https://bugzilla.mozilla.org/show_bug.cgi?id=1110207)
- Source for the list: [Bugzilla REST query](https://bugzilla.mozilla.org/rest/bug?product=DevTools&resolution=---&order=votes%20DESC&limit=15&include_fields=id,summary,votes,creation_time,type)
- A Mozilla Hacks commenter noted that no one really uses the voting system, so Bugzilla votes are a weak popularity signal — [Mozilla Hacks 2016 post and comments](https://hacks.mozilla.org/2016/04/developer-edition-48-firebug-features-editable-storage-inspector-improvements-and-more/) (reported via search snippet; I did not open the comments directly).
- Chrome side: per-request network throttling was only added to Chrome Canary around Nov 2025 despite global throttling existing since 2014 (per one developer's write-up surfaced via search) — [DebugBear, favourite devtools features in 2025](https://debugbear.com/blog/favourite-devtools-features-in-2025) (snippet-level; I did not open the page).

### Inferences
- VS Code's all-time top asks are about personalization and configuration model (fonts/UI scale, mouse bindings, settings inheritance/scoping, extension manifests in config, multi-window workspaces). They have gone unresolved 5-11 years, suggesting architectural cost rather than lack of demand.
- Zed's 2025-2026 requests are heavily Git-workflow: 3-way merge, conflict UI, line staging, branch merge, multi-repo, jj, Difftastic, PR-style review. Git/diff UX is the largest recent unmet cluster in a modern editor.
- JetBrains and Firefox lists look old because older issues have had more time to accumulate votes and the votes systems are less used; they should not be read as evidence that demand has faded.
- The newest VS Code mass-reaction issues are about control and opt-out (AI model choice, UI revert, update cadence, Copilot menu), not new capabilities.

### Gaps
- Chrome DevTools requests live on issues.chromium.org (crbug), which I did not retrieve; no reaction/star counts for Chrome DevTools. No sorted data from Firefox DevTools beyond Bugzilla votes.
- JetBrains: only the IDEA project was queried; WebStorm, PyCharm, Rider, etc. were not. Top-voted list is dominated by pre-2021 issues, so I have no vote-ranked view of the newest requests there.
- Framework discussion boards (Next.js, Vite, Svelte, Angular, etc.) were not covered.
- Reaction counts include all reaction types; I did not verify that each issue is still open beyond the API `is:open` filter.

## 2. What recurring "I wish my editor/devtools could..." themes appear on HN, Reddit, and dev.to in 2025-2026?

### Takeaway
I could retrieve HN and dev.to evidence only (Reddit was blocked). HN wish threads are small and diffuse (tens of points, up to about 60 comments) but the debugging threads and Show HN reactions repeatedly point at time-travel/record-replay debugging, non-stopping tracepoints, structure-aware (AST/tree-sitter) editing, and AI-agent-era review/permissions tooling.

### Cited Findings
- "Ask HN: What developer tool do you wish existed in 2026?" (2025-12-21, 22 points, 24 comments): wishes were scattered: saner CI (2), CI test-blocking proposals, daily priority sense-making, an agent runtime enforcing "a hard no" before unsafe execution, a function call graph for reading code, temporary SSH containers, an "unbloated easy to use Postman", and an explorative hex editor — [HN item 46345827](https://news.ycombinator.com/item?id=46345827) (via [HN API](https://hn.algolia.com/api/v1/items/46345827))
- "Features I'd like to see in future IDEs" (2024-08-08, 61 points, about 58 comments): structure-aware editing/diffing ("an IDE that functions on objects of code and not text files", about 9 comments); format-on-view separated from stored code (about 5); commit masks / local-only changes (about 5); debugger visualization/replay (about 5, e.g., "there is no way to view the Debug representation of your types in the debugger"); multi-cursor/selection workflows (about 3); blocking TODO/console.log from being saved (about 3); IDE blocked waiting on rust-analyzer (1) — [HN item 41187533](https://news.ycombinator.com/item?id=41187533) (counts are approximate, based on a summarized read of the thread)
- "Things you can do with a debugger but not with print debugging" (2025-09-07, 257 points, 214 comments): commenters raised time-travel/record-replay (about 5; rr doesn't run on Windows and serializes threads), non-suspending formatted tracepoints/logpoints (about 3), debugger breakpoints distorting race conditions (about 5), debuggers failing on remote/production/embedded/GPU/minified JS (several), painful setup (about 6, e.g., weeks to configure Xdebug), poor GDB/LLDB CLI UX (about 4) — [HN item 45156414](https://news.ycombinator.com/item?id=45156414) (counts approximate; I read only the first ~100k characters of the thread)
- HN debugger-related stories since 2024 with high points: "The Zed Debugger Is Here" (2025-06-19, 502 pts, 202 comments), "rr - record and replay debugger for C/C++" (2024-07-21, 402 pts, 131 comments), "Show HN: CodeTracer - time-traveling debugger" (2025-03-06, 334 pts), "Nnd - a TUI debugger alternative to GDB, LLDB" (2025-05-06, 278 pts), "Show HN: Uscope, a new Linux debugger written from scratch" (2025-01-31, 262 pts) — [Zed debugger](https://news.ycombinator.com/item?id=44314977), [rr](https://news.ycombinator.com/item?id=41023547), [CodeTracer](https://news.ycombinator.com/item?id=43280615), [nnd](https://news.ycombinator.com/item?id=43905185), [uscope](https://news.ycombinator.com/item?id=42889407)
- "Show HN: A web debugger an ex-Cloudflare team has been working on for 4 years" (2024-05-10, 886 points, 233 comments): commenters asked for Firefox/Safari support ("a deal breaker for my team"), Electron/mobile support, automatic capture on exception or 4XX, self-hosting/EU data/auto-deletion, configurable header scrubbing, source-mapped stack traces, repro-to-Cypress/Selenium test generation, and contrasted with Replay.io's custom-browser requirement. The product named in the comments was Jam (jam.dev) — [HN item 40318542](https://news.ycombinator.com/item?id=40318542) (summarized from the first ~100k characters; the title/points are from the Algolia search result)
- AI-agent-era tooling gets large HN engagement: "Ask HN: What's your current AI agentic setup?" (2026-11-04, 573 points, 717 comments); "Show HN: Whiteboard (YC W26) - An open-source IDE for thoughtful software design" (2026-09-24, 424 points, 143 comments); "Show HN: Get your coding agent off ~2019 JavaScript, onto modern web primitives" (2026-11-10, 447 points, 146 comments) — [HN search results](https://hn.algolia.com/api/v1/search?query=IDE%20wish&tags=story&numericFilters=created_at_i>1704067200,points>100&hitsPerPage=20) (title/points/comments only; I did not read the threads)
- "Ask HN: What's your 'impossible' developer workflow wish?" (2024-12-29, 5 points, 5 comments): logical-consistency PR review of a branch against the codebase, "Show me everywhere this API is used incorrectly across the entire codebase", and WYSIWYG-to-working-CSS/React — [HN item 42537739](https://news.ycombinator.com/item?id=42537739) (tiny sample, weak signal)
- dev.to opinion posts (not feature-request counts): IDEs should shift to agent review and session status instead of file-tree-first layouts ("The Editor-First IDE Is Dead. Your Next IDE Is a Control Tower"); a developer working mostly via terminal agents wants a lightweight editor for reviewing changes and small edits; a Zed critic dislikes needing extensions and IDE-style bloat — [Control Tower](https://dev.to/gabrielanhaia/the-editor-first-ide-is-dead-your-next-ide-is-a-control-tower-41h1), [Do we still need a full IDE](https://dev.to/monawwar/do-we-still-need-a-full-ide-in-the-age-of-ai-agents-4mel), [Zed: The Editor I Wish I Liked](https://dev.to/1ce/zed-the-editor-i-wish-i-liked-2jn2) (read via search summaries only, reaction counts not captured)

### Inferences
- Debugging UX (time-travel, tracepoints, easier setup, GUI quality) is the most consistent wish theme across HN threads and aligns with GitHub signals (Zed test runner, Neovim DAP, Helix debugging overhaul, JetBrains breakpoint export / saving watches).
- "Review what the AI agent did" (PR-style diff comments feeding agents, agent permission boundaries, review-focused lightweight editors) is the newest theme; it appears in Zed #59157, dev.to posts, and HN threads.
- Structure-aware editing (AST/tree-sitter) recurs in HN ("objects of code and not text files") and in GitHub (VS Code #50140 tree-sitter, 929 reactions; Helix-style syntax-node selection; Zed Difftastic).

### Gaps
- Reddit (r/webdev, r/programming, r/ExperiencedDevs, r/neovim, r/vscode) was not accessible: WebFetch refused reddit.com and WebSearch blocked the domain. No Reddit counts are reported. A researcher with Reddit access should fill this.
- HN "wish" threads from 2025-2026 are small; I did not find a high-engagement (200+ points) dedicated "I wish my editor could..." thread from 2025-2026. The HN keyword searches I tried (e.g., "I wish my editor") returned noisy results.
- dev.to reaction counts and a systematic dev.to survey were not captured.
- Thread summaries were produced by summarizing the first ~100k characters of long threads; counts like "about 5 comments" are approximate.

## 3. Which themes recur across several communities (strong signal) vs. appear once (weak signal)?

### Takeaway
Strong cross-community signals (3+ independent trackers/communities): Git/diff/merge UX; debugging, test and profiling integration; settings/config portability and sync; multi-window/multi-workspace/multi-monitor; tablet/iPad availability; mouse/keybinding customization; vim/modal-editing emulation fidelity; user control over AI and forced changes. Weak/single-source: LaTeX preview, RTL (two trackers, moderate), call-graph navigation, commit masks, WYSIWYG-to-CSS.

### Cited Findings

**Strong (multiple independent trackers)**
- Git/diff/merge/review UX: Zed 3-way merge #34813 (177 reactions, 2025), conflict UI #58974 (104), line staging #45295 (158), branch merging #57982 (167), multi-repo panel #59221 (146), jj #21538 (805), Difftastic #9721 (348); Helix side-by-side diffing #405 (258, 2021) and VCS support #227 (123); HN "commit masks" (about 5 comments); Zed PR-style review comments feeding agents #59157 (162) — see links in Section 1 and [HN 41187533](https://news.ycombinator.com/item?id=41187533)
- Debugging/test/profiling: Zed test runner #5242 (934 reactions, 2022); Neovim DAP #11732 (112, 2020); Helix debugging overhaul #5950 (272, 2023); JetBrains IDEA-15540 export breakpoints (152 votes, 2007), IDEA-134919 save watches (99, 2015), IDEA-252110 remote profiling (136, 2020); Firefox bug 1004678 DOM mutation breakpoints (18 votes) and 1110207 network throttling control (10); HN [45156414](https://news.ycombinator.com/item?id=45156414) and [40318542](https://news.ycombinator.com/item?id=40318542) debugging threads
- Settings/config portability and sync: VS Code #15909 extend settings (1,732 reactions, 2016), #5595 platform-scoped settings (1,609, 2016), #40233 local workspace settings (1,472, 2017), #40239 extensions from config file (1,181, 2017), #2809 variables in settings (936, 2016); Zed #5010 settings sync (186, 2023) and #59978 (133, 2026); Helix #401 persistent session state (394, 2021); JetBrains IDEA-54807 per-project debug stepping (67 votes, 2010)
- Multi-window / multi-workspace / multi-monitor: VS Code #43188 (1,227, 2018) and #34442 extract integrated terminal (1,186, 2017); Zed #9662 multi-monitor (508, 2024), #6722 drag tab to window (333, 2024), #9459 .code-workspace (446, 2024); Helix #312 client-server buffers (210, 2021); Firefox bug 1219917 reuse one devtools window (19 votes, 2015)
- Mouse/keybinding customization: VS Code #3130 (2,565, 2016); Zed #10647 (239, 2024)
- Vim/modal emulation fidelity: VS Code #114851 "VIM mode like sublime" (1,640, 2021); Zed easymotion #4930 (530, 2023) and flash.nvim-style search #14801 (486, 2024)
- Tablet/iPad: VS Code #70764 (2,100 reactions, 2019) and #255717 (173, 2025); Zed #11889 (356, 2024)
- Structure-aware editing/tree-sitter: VS Code #50140 (929, 2018); Neovim treesitter upstreaming #39006 (539, 2026); Zed Difftastic #9721 (348); HN 41187533 (about 9 comments on object/AST editing)
- Integrated terminal as first-class feature: VS Code #34442 (1,186, 2017); Helix #1976 (337, 2022); Neovim ":terminal improvements" #5431 (62), libvterm replacement #33155 (202, 2025)
- Rich/formatted content in tooling: VS Code diagnostics markdown #54272 (1,439, 2018); Zed Webview via Extensions #21208 (506, 2024) and LaTeX in markdown preview #40813 (76, 2025); HN: images in comments (about 6 comments in 41187533)
- Control over AI and forced changes (2025-2026): VS Code ACP #265496 (348), BYOK #318545 (332), local completions #263535 (207), Copilot menu #237819 (255), modern UI revert #326146 (376) and #325240 (253), weekly updates #309223 (200); Zed offline #24878 (175) and Node auto-download #12589 (371, 2024); Neovim keeps a "no core C rewrite/unify cmdline" conversation not about AI
- Project-wide diagnostics/LSP quality: VS Code #13953 all errors/warnings in project (2,005, 2016); Zed Find All References views #5117 (224), TS server slow #18698 (181), LSP meta #26916 (67); HN: editor blocked on rust-analyzer (1 comment)
- Smooth rendering/scroll: Zed #4355 smooth scrolling (1,050, 2023); Neovim #989 scroll without cursor move (126, 2014)
- Bidirectional text: Zed #31102 RTL (205, 2025), Neovim #553 Bidi (107, 2014)
- Code folding / basic editor primitives still missing in newer editors: Helix #1840 (508), #1125 auto-reload (357), #200 file tree (157)

**Weak (appear once in what I found)**
- Call-graph navigation across a codebase (one HN comment, [item 46345827](https://news.ycombinator.com/item?id=46345827))
- "Show me everywhere this API is used incorrectly" and branch-vs-codebase logical-consistency review (one HN thread, 5 comments, [item 42537739](https://news.ycombinator.com/item?id=42537739))
- Commit masks for local-only changes (about 5 comments in one HN thread; JetBrains changelists were cited as partial answer)
- Elastic tabstops (Neovim #1419, 122 reactions, 2014), PCRE regex (Neovim #3208, 123 reactions, 2015), Wayland default (VS Code #207033, 239 reactions)

### Inferences
- Git/diff/merge, debugging/test, and config portability each appear in 3+ independent trackers across 2021-2026, making them the strongest convergent signals.
- The ranking is shaped by user-base size: VS Code and Zed show much larger counts than Neovim/Helix; a theme in a smaller tracker (Helix, Neovim) is meaningful even at 100-500 reactions.
- Since I could not access Reddit, "cross-community" here means cross-tracker plus HN/dev.to; Reddit confirmation is missing.

### Gaps
- No Reddit verification of any theme.
- No counts for Chrome DevTools features; the web-dev-specific signal comes from Firefox Bugzilla (old, low vote counts), the Jam/web-debugger HN thread, and VS Code diagnostics/tree-sitter requests. Web-specific framework discussions were not sampled.

## 4. Which requests are long-standing (open 3+ years) despite high demand?

### Takeaway
Many. As of 2026-11-16, VS Code has at least a dozen open requests with 900+ reactions that are 5-11 years old; Helix and Zed have requests 3-5 years old with 350-1,050 reactions; JetBrains and Firefox have 10-19-year-old votable items.

### Cited Findings
- VS Code #519 workbench font size/font: open since 2015-11-24 (about 11 years), 4,844 reactions — [issue](https://github.com/microsoft/vscode/issues/519)
- VS Code #3130 mouse shortcuts: since 2016-02-18 (about 10.5 years), 2,565 reactions — [issue](https://github.com/microsoft/vscode/issues/3130)
- VS Code #13953 project-wide JS/TS errors: since 2016-10-18 (about 10 years), 2,005 reactions — [issue](https://github.com/microsoft/vscode/issues/13953)
- VS Code #70764 iPad: since 2019-03-19 (about 7.5 years), 2,100 reactions — [issue](https://github.com/microsoft/vscode/issues/70764)
- VS Code #15909 extend settings files: since 2016-11-22, 1,732 reactions; #4490 macro recording: since 2016-03-21, 1,680; #5595 platform scoping: since 2016-04-21, 1,609; #40233: since 2017-12-14, 1,472; #54272 markdown diagnostics: since 2018-07-13, 1,439; #43188 multi-workspace windows: since 2018-02-08, 1,227; #40239: since 2017-12-15, 1,181; #34442: since 2017-09-15, 1,186; #100335 grouped tabs: since 2020-06-16, 1,187; #50140 tree-sitter: since 2018-05-19, 929; #35744 status bar locations: since 2017-10-06, 903; #114851 vim mode: since 2021-01-24, 1,640 — links as in Section 1
- Zed #5242 test runner: since 2022-08-18 (about 4.2 years), 934 reactions — [issue](https://github.com/zed-industries/zed/issues/5242); Zed #4355 smooth scrolling: since 2023-11-13 (about 3 years), 1,050 reactions — [issue](https://github.com/zed-industries/zed/issues/4355); Zed #4930 easymotion: since 2023-03-15 (about 3.7 years), 530; #5117 Find All References: since 2022-11-20, 224; #5010 settings sync: since 2023-02-14, 186 (re-filed 2026 as #59978)
- Helix #1840 code folding: since 2022-03-18 (about 4.7 years), 508 reactions; #1125 auto-reload: since 2021-11-18, 357; #401 session persistence: since 2021-07-03, 394; #405 side-by-side diff: since 2021-07-03, 258; #1976 integrated terminal: since 2022-04-06, 337; #312 client-server: since 2021-06-19, 210 — links in Section 1 (note: some Helix features may have been partially implemented via PRs or plugins since; I did not verify current status beyond the issue being open)
- Neovim #11732 DAP: since 2020-01-18 (about 6.8 years), 112 reactions; #989 scroll without cursor move: since 2014-07-24, 126; #553 Bidi: since 2014-04-17, 107; #1419 elastic tabstops: since 2014-11-06, 122 — links in Section 1
- JetBrains IDEA-15540 export breakpoints (2007-10-08, 152 votes), IDEA-68854 Problems View (2011-04-27, 426 votes, 112 comments), IDEA-134919 save debug watches (2015-01-02, 99 votes), IDEA-252110 remote profiling (2020-10-02, 136 votes) — [YouTrack API query](https://youtrack.jetbrains.com/api/issues?query=project:IDEA%20%23Unresolved%20sort%20by:votes%20desc&fields=idReadable,summary,votes,created,commentsCount&$top=25)
- Firefox DevTools bug 885508 WebSocket Inspector (2013-06-20, 66 votes), bug 1039678 disable web security/CORS toggle (2014-07-16, 36 votes), bug 771339 live function editing (2012-07-05, 20 votes) — [Bugzilla query](https://bugzilla.mozilla.org/rest/bug?product=DevTools&resolution=---&order=votes%20DESC&limit=15&include_fields=id,summary,votes,creation_time,type)
- Chrome per-request network throttling: global throttling dates to 2014; per-request throttling appeared in Canary around Nov 2025 per a developer write-up — [DebugBear](https://debugbear.com/blog/favourite-devtools-features-in-2025) (snippet-level only; indicates a long-standing wish that is now being addressed, not a vote count)

### Inferences
- The long-standing, high-demand pattern is concentrated in configuration/workspace architecture (VS Code settings model, multi-root windows) and in editor-core capabilities that are architecturally expensive (project-wide diagnostics, tree-sitter, multi-window, macros).
- Several Zed requests (test runner, smooth scrolling, settings sync) have 3+ years of accumulated demand and were still open at fetch time; settings sync was re-filed in 2026, which suggests the older issue did not resolve it.
- Because "open" status comes from the API filter at fetch time, items that were closed and reopened or fixed partially (e.g., via extensions) could still appear as open.

### Gaps
- I did not verify maintainer responses (e.g., "on roadmap", "won't fix") for these issues, so I cannot say which are stalled by policy versus capacity.
- Chrome DevTools long-standing requests (crbug) were not retrieved; no data for JetBrains products other than IDEA.
- Framework communities (React, Angular, Svelte, Next.js, Vite) were not sampled.
