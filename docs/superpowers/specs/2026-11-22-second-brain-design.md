# Second brain: per-folder memory from compactions

## Intent
Each project folder gets its own long-lived memory. When an agent's chat is compacted, Breeze keeps what the
compaction summary said as small memory nodes, so the details aren't lost. The user can see the memory as a graph:
right-click the folder name in the Agent board's chat side bar, then pick **Second brain**.

## Goals
- Memory is per folder, stored on this computer only (`second-brain.json` in userData), and keyed like `MemoryStore` scopes.
- Captured automatically when Claude Code, Codex or Breeze's local LLM loop compacts.
- An interactive graph: pan, zoom, drag, and hover to read a memory. It follows the Breeze design system.

## Non-goals (for now)
- Agents don't read the memory back (the user chose "not yet").
- No editing of nodes in the graph, apart from deleting one from the hover card.
- Antigravity: it doesn't report compaction, so it isn't captured.

## Anti-goals
- Never keep secrets or code dumps (reuse `looksLikeSecret` and the `memoryRefusal` checks).
- No network calls and no extra model tokens to build the memory.
- Don't slow the agent streams: capture runs after the event, off the hot path.

## Approaches considered
- **Picked: summaries → typed facts by heuristics, links from shared files and terms.** Offline, instant, no new
  dependency. Links can be noisy, which is acceptable for a first version.
- Agent-tagged links: better links, but costs a model call per compaction.
- Embeddings: needs a model or service and adds a dependency.

## Design
**Node** `{ id, kind: 'fact'|'decision'|'task'|'file', text, at, agent, hits }`. A file named in a memory becomes its
own `file` node (a hub). Re-adding the same text bumps `hits` and `at` instead of making a duplicate. Each folder
holds at most 1500 nodes; past that, the least-hit and oldest nodes are dropped first.

**Extraction** (pure, in `src/main/secondbrain.ts`): split the summary into sections and bullets, and drop fenced
code. Claude's numbered section headings set the kind: Files → file mention, Pending tasks / Next step → task,
Errors and fixes / Problem solving → decision, everything else → fact. "All user messages" is skipped. Text with no
headings is typed by keywords (decided/chose/instead → decision; todo/next/pending → task). Each bullet becomes one
memory of up to 300 characters. Paths that look like files (`src/x.ts`, `foo.json`) become file nodes.

**Links** (computed when the graph is read): memory–file when the memory names the file; memory–memory when they
share a file, or when the Jaccard similarity of their uncommon words (3+ letters, no stop words) is at least 0.25.
Each node keeps its top 6 links so the graph stays readable.

**Capture**
- Claude Code: on stream event `system/compact_boundary`, and on a streamed user message flagged `isCompactSummary`
  (or starting "This session is being continued"), take the summary text. If only the boundary arrives, read the
  newest `isCompactSummary` line from the session's JSONL in `~/.claude/projects`.
- Codex: after each turn, read new `compacted` items from the thread's rollout file in `~/.codex/sessions`.
  Already-seen summaries are skipped (keyed by a hash).
- Local LLM loop: when `compactHistory` drops whole early exchanges, the dropped assistant replies are kept as facts.

**IPC**: `brain:graph(folder) → { nodes, links }`, `brain:remove(folder, id)`, and a `brain` push event when a folder's
memory changes. `demoApi` gets a fake brain with sample nodes, so the static preview can show the graph.

**UI**: right-clicking a `.box-side-folder` header shows a menu with **Second brain**, which opens a full-board overlay.
It has an Unbounded headline "Second brain", the folder name, counts per kind as legend chips that toggle each kind,
and a close button (Esc). The canvas runs a small hand-written force simulation (no library). Node radius grows with
link count, nodes are colored by kind, links are thin grey lines, and unlinked nodes drift to the edge. Wheel zooms
toward the cursor, dragging the background pans, and dragging a node moves it. Hovering a node shows a card with the
text, the kind, the agent and the date, and highlights the node's neighbors. The panel opens with the panel easing
(.4s `cubic-bezier(.32,.72,0,1)`). With reduced motion, the simulation settles before the first paint.

## Left to the builder
Exact colors (from the app's tokens), simulation constants, and the stop-word list.

## Tests (`test/secondbrain.test.js`)
Extraction from a Claude-style summary and a plain one, secret and code refusal, dedupe, the cap, per-folder scopes,
links (shared file, shared terms, top-N), Codex rollout parsing, and the dropped-exchange diff for the local loop.
