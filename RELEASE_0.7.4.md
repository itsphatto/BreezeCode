## Breeze Code 0.7.4

Run several agents side by side on the new Agent board, and make Breeze look and sound the way you like.

### New

- **Agent board.** Open it with `Ctrl+Shift+B` or the board button in the activity bar. Drag agents into boxes and run them side by side: four to a screen, more on scroll.
  - Each box owns the files it writes first.
  - When one box edits another box's file, Breeze puts the file back and relays the change to the owner. The owner's answer goes back to the asker.
  - After three relays between the same two boxes, Breeze pauses the loop. An **Auto-relay** switch turns relaying off.
- **Explain with Agents.** Select code, right-click, and get an explanation card from your agents.
- **Settings search.** Type to find a setting. Matches are highlighted and the setting glows when you jump to it.
- **Movable contribution graph.** Drag the graph on Home into the left, right, or bottom dock. The prompt box now stays pinned to the bottom of the page.
- **Backdrop picture blur.** New setting to blur your background picture.
- **Windows 10 glass.** Glass blur now works on Windows 10.
- **Thai font fallback.** Thai text now renders with a proper fallback font.

### Improved

- **Sound effects.** UI sounds are warmer and no longer spike when several play at once. Pitches stay in tune with each other.
- **Menus and popups.** Menus, popups, and color pickers are more opaque, so the background no longer bleeds through. Keyboard navigation no longer draws a focus outline on the trigger.
- **Backdrops.** Backdrops now work on the setup Home step. Changes fade in, and the debugger no longer double-layers over them.
- **Dropdowns.** They no longer reopen when you click to close them. The color picker closes smoothly.
- **Agent dashboard.** Cache write metric colors have better contrast.
- **Pinned tabs.** Run and Split buttons have a solid background and tabs fade out under them, so tabs no longer look cut off.
- **Path tooltips.** File path tips on hover are now off by default. Turn them on with **File path on hover** in Settings > Explorer.

### Fixed

- **First launch.** Agents and Preview now start closed, so the editor opens at a usable width. Saved layouts are not touched.
- **Triple backticks in agent replies.** A ``` now starts a code block only at the start of a line. Mid-sentence ones show as inline code, in Agents chat and in the Explain card.
- **Status bar.** It shows only the tool for the open file (for example "Node ready" for a `.ts` file). A missing required tool such as Git always shows. Hover to see all tools.
- **Generated JS files.** A `.js` file (and its `.map`) is hidden only when a `.ts` or `.tsx` with the same name sits in the same folder. Right-click the Explorer and pick **Show Generated Files** to see them again. A generated file you have open always stays visible.

**Full changelog:** https://github.com/itsphatto/BreezeCode/compare/v0.7.3...v0.7.4
