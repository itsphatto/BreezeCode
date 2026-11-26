# First-run tips: one blue bubble per screen

## Why
People new to Breeze Code don't know what each screen is for or where to start. The first time they open a screen,
a blue bubble points at the one thing worth trying there, and gets out of the way the moment they close it.

## What the user sees
- A blue card with a small pointer toward one control: a short line with one **bold** word, an × in the corner, an
  action button (does the thing the tip is about), and a small **Skip all tips** link.
- Style follows the reference picture: solid blue (`--blue`), white text, rounded corners, the action button as a
  dashed-outline pill with an icon.
- It appears the first time the user opens that screen, after setup is finished. It never comes back once closed.
- The user can close it at any time: ×, Escape, the action button, or Skip all tips (closes every tip for good).

| Screen | Points at | Line | Action button |
|---|---|---|---|
| Code editor | the agent prompt (`#prompt`) | Ask an **agent** to write or change code here. | Try it (focuses the prompt) |
| Source Control | Generate commit message (`#scmGenMsg`) | Let the agent write your **commit message**. | Generate (runs `git.genCommitMsg`) |
| Agent Board | New chat (`#boardSideNew`) | Each **chat** runs its own agent in a box of its own. | New chat |
| Debug | Go (`#dbgGo`) | Start your program and **pause** at breakpoints. | Start |
| Manager (Manage agents window) | the agent list (`#pickList`) | Pick which **AI agent** Breeze uses. | Got it |

Wording is a first draft; the builder may tighten it.

## Goals
- One bubble per screen, on first entry, dismissable whenever the user wants.
- Settings → Miscellaneous gets a **Show tips again** row that brings every tip back.

## Non-goals
- No guided tour that moves the user from screen to screen.
- No tips during setup (onboarding), on Home, or in Breeze Space.
- No server-side tracking of which tips were seen.

## Anti-goals
- A bubble that blocks work: it never dims the screen or traps focus, and clicks elsewhere still work.
- A bubble pointing at nothing: if its control isn't visible (Generate commit message is hidden until there are
  changes), that tip waits for a later visit when it is.
- Two bubbles at once: only one shows at a time.

## Constraints
- The renderer's CSP blocks inline `style` attributes: position with `element.style` from script, colours in breeze.css.
- Respect reduced motion and the power saver (pop-in animation only when motion is allowed).
- Must read on dark, light and high-contrast themes.
- Stays in place when the window or panels resize, and closes if its control disappears (screen switched away).

## Approaches
1. **Per-screen bubble on first entry** (picked). Each screen's tip is independent; simple, matches the request.
2. Guided tour on first launch, walking through every screen in order. Rejected: it moves the user to screens they
   didn't choose, and the request was a bubble when entering a screen.

## Decided
- One new module (`src/renderer/breeze/tips.ts`) with the tip list, the bubble, and the seen-state.
- Seen-state in `store` (localStorage) under one key, e.g. `breeze.tipsSeen` (a list of tip ids, plus a "skip all" flag).
- Each screen calls the module when it opens (editor shown, Source Control page opened, board opened, debug page
  opened, agent picker opened).

## Left to the builder
- Exact hook points in each screen's open function, pointer placement (above/below/side, flipped to stay on screen),
  z-index relative to menus and modals, and the final wording.
