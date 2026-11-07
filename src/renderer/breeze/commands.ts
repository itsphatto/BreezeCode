/* ================= Commands, menu bar & shortcuts ================= */
interface MenuItem {
  label?: string; icon?: string; remove?: () => void; act?: string; run?: () => void; key?: string; sep?: boolean; checked?: () => boolean; enabled?: () => boolean; native?: boolean;
  keyFrom?: string;           // shows the key of that command, which does this job when it applies; has none of its own
  header?: User;              // a "who is signed in" row
  sub?: () => MenuItem[];     // opens a submenu on hover
  subClass?: string;          // custom css class for submenu
  clickRuns?: boolean;        // with `sub`: a click runs the item, hovering still opens the submenu
  slider?: MenuSlider;        // a row with a stepped slider in place of a label
}
// Steps picked by dragging or clicking along a track; the menu stays open while it changes.
interface MenuSlider {
  label: string;                      // what the slider sets, for screen readers
  steps: readonly string[];
  value: () => number;                // index into steps
  set: (i: number) => void;
  hint?: (i: number) => string;       // a line under the value
  reset?: () => void;                 // shows a reset button
}
const hasFile = () => !!activeText();
function searchSelection(): void {
  showView('search', true);
  const i = $<HTMLInputElement>('#searchInput');
  const b = activeText();
  const s = b ? b.ta.value.slice(b.ta.selectionStart, b.ta.selectionEnd) : '';
  if (s && !s.includes('\n')) i.value = s;
  i.focus(); i.select();
}
function backToOnboarding(n: number): void {
  appState.onboarded = false; saveApp();
  for (const id of ['#ide', '#box', '#debug']) $(id).classList.add('hidden');
  $('#onboard').classList.remove('hidden');
  goStep(n);
}
const commands: Record<string, () => unknown> = {
  'app.home': goHome,
  'file.newFile': () => newEntry(targetDir(), false),
  'file.newFolder': () => newEntry(targetDir(), true),
  'file.openFile': chooseFile,
  'file.openFolder': openFolderCmd,
  'file.openRecent': openRecentPicker,
  'file.save': () => saveFile(focused() === splitTa.input ? splitPath : active).then(ok => { if (ok) sfx.play('save'); }),
  'file.saveAll': saveAll,
  'file.closeEditor': () => { if (active) closeTab(active); },
  'file.closeFolder': closeFolderCmd,
  'file.exit': () => api.win.quit(),
  'edit.undo': () => editRole('undo'),
  'edit.redo': () => editRole('redo'),
  'edit.cut': () => editRole('cut'),
  'edit.copy': () => editRole('copy'),
  'edit.paste': () => editRole('paste'),
  'edit.find': () => openFind(),
  'edit.replace': () => openFind(true),
  'edit.comment': toggleComment,
  'edit.selectAll': () => editRole('selectAll'),
  'sel.line': selectLine,
  'sel.dup': duplicateLines,
  'sel.up': () => moveLines(-1),
  'sel.down': () => moveLines(1),
  'sel.addNext': addNextOccurrence,
  'sel.allOccurrences': selectAllOccurrences,
  'sel.cursorAbove': () => addCursorVertical(-1),
  'sel.cursorBelow': () => addCursorVertical(1),
  'view.palette': () => openPalette(),
  'view.paletteF1': () => openPalette(),
  'view.files': () => showView('files', true),
  'view.search': searchSelection,
  'view.git': () => showView('git', true),
  'view.toggleSide': () => {
    closeScmPage(); // the side bar is hidden behind the Source Control page: go back to what it holds, then toggle it
    const prev = { ...layout };
    layout.sideOpen = !layout.sideOpen;
    sfx.play('menu');
    pushAppAction({ type: 'layout', prev, next: { ...layout } });
    applyLayoutAnimated();
  },
  'view.toggleAgents': () => {
    const prev = { ...layout };
    layout.agentsOpen = !layout.agentsOpen;
    sfx.play('menu');
    pushAppAction({ type: 'layout', prev, next: { ...layout } });
    applyLayoutAnimated();
  },
  'view.togglePreview': () => {
    closeScmPage(); // the preview is hidden behind the Source Control page: close it first so the toggle is seen
    const prev = { ...layout };
    layout.previewOpen = !layout.previewOpen;
    pushAppAction({ type: 'layout', prev, next: { ...layout } });
    applyLayoutAnimated();
  },
  'view.toggleMinimap': () => { setMinimap(!minimapOn); sfx.play('menu'); },
  'view.splitEditor': () => { if (splitPath) { closeSplit(); } else { openSplit(); } renderTabs(); },
  'view.resetLayout': () => {
    closeScmPage(); // it resets the side bar and preview, which are hidden behind the Source Control page
    const prev = { ...layout };
    Object.assign(layout, DEFAULT_LAYOUT, { view: layout.view });
    pushAppAction({ type: 'layout', prev, next: { ...layout } });
    applyLayoutAnimated();
  },
  'win.reload': () => { flushSession(); return api.win.reload(); },
  'win.devtools': () => api.win.toggleDevTools(),
  'go.file': quickOpen,
  'go.line': goToLine,
  'go.nextProblem': nextProblem,
  'mark.toggle': () => { const b = activeText(); if (b) toggleMark(b.path, lineAt(b.text, b.ta.selectionStart)); },
  'debug.toggleBreakpoint': () => {
    if (debugPageShowing()) { toggleDebugSourceBreakpoint(); return; }
    const b = activeText();
    if (b) toggleBreakpoint(b.path, lineAt(b.text, b.ta.selectionStart));
  },
  // Wrapped: debug.ts and debugview.ts load after this file.
  'debug.start': () => startDebugging(),
  'debug.stop': () => stopDebugging(),
  'debug.restart': () => restartDebugging(),
  'debug.continue': () => { if (debugState === 'paused') return api.debug.continue(); },
  'debug.pause': () => { if (debugState === 'running') return api.debug.pause(); },
  'debug.stepOver': () => { if (debugState === 'paused') return api.debug.step('over'); },
  'debug.stepInto': () => { if (debugState === 'paused') return api.debug.step('into'); },
  'debug.stepOut': () => { if (debugState === 'paused') return api.debug.step('out'); },
  'debug.open': () => openDebugView(),
  'mark.next': () => jumpMark(1),
  'mark.prev': () => jumpMark(-1),
  'mark.clear': () => { if (active && lineMarks.delete(active)) { saveMarks(); repaintMarks(active); } },
  'go.nextEditor': () => cycleTab(1),
  'go.prevEditor': () => cycleTab(-1),
  'run.file': runFile,
  // F5: continues a paused debug session first; on the debug page it starts one. Otherwise it runs or previews.
  'run.start': () => {
    if (debugState === 'paused') return api.debug.continue();
    if (debugPageShowing()) return debugState === 'stopped' ? startDebugging() : undefined;
    if (runnable(active)) return run('run.file');
    return running && previewPath === previewTarget() ? reloadPreview() : startPreview();
  },
  'run.reload': reloadPreview,
  'run.stop': () => { if (term.runId != null) killCommand(); else { stopPreview(); toast('Preview stopped'); } },
  'live.toggle': toggleLiveShare,
  'live.start': () => background((async () => {
    try {
      const live = await api.live.start();
      await refreshLiveShare();
      toast(`Live Share opened at ${live.url}`);
    } catch (e) { toast(errMsg(e)); }
  })()),
  'live.stop': () => background((async () => {
    try {
      await api.live.stop();
      await refreshLiveShare();
      toast('Live Share turned off');
    } catch (e) { toast(errMsg(e)); }
  })()),
  'term.toggle': () => {
    if (termPopped()) { termPopup?.focus(); termInput.focus(); return; } // it lives in its own window: bring that up
    const prev = { ...layout };
    // Open back in the IDE but not brought over yet, Breeze Space's button shows it rather than closing it unseen.
    const showing = layout.termOpen && (appState.mode !== 'box' || $('#terminal').parentElement === $('#box'));
    terminalHere();
    layout.termOpen = !showing;
    sfx.play('whoosh');
    pushAppAction({ type: 'layout', prev, next: { ...layout } });
    applyLayoutAnimated();
    if (layout.termOpen) termInput.focus();
    else if (appState.mode === 'box') SURFACES.box.prompt.focus();
  },
  'term.focus': () => { if (termPopped()) termPopup?.focus(); terminalHere(); layout.termOpen = true; applyLayoutAnimated(); termInput.focus(); },
  'term.new': () => {
    terminalHere();
    layout.termOpen = true;
    applyLayoutAnimated();
    createTermSession();
    termInput.focus();
  },
  'term.newWindow': () => background(api.win.newTerminal()),
  'term.clear': () => {
    if (activeTermSession?.paneEl) {
      activeTermSession.paneEl.innerHTML = '';
    }
  },
  'term.kill': () => { if (term.proc == null) toast('Nothing is running'); else killCommand(); },
  'explorer.refresh': refreshTree,
  'explorer.collapse': () => { expanded.clear(); renderTree(); saveSession(); },
  'help.welcome': () => setActive(null),
  'help.keys': showShortcuts,
  'help.setup': () => backToOnboarding(STEP.agent),
  'account.signIn': addAccount,
  'account.signOut': signOut,
  'sync.run': () => runSync('sync'),
  'sync.pull': confirmPull,
  'sync.open': () => openCloudWorkspaces(),
  'mode.ide': () => enterMode('ide'),
  'mode.box': () => enterMode('box'),
  'help.about': showAbout,
};
function showAbout(): void {
  const where = isDesktop ? 'Desktop app' : 'Browser preview';
  const engine = /Electron\/[\d.]+|Chrome\/[\d.]+/.exec(navigator.userAgent)?.[0] ?? '';
  openModal(`<h3>Breeze Code</h3><p class="sub">Smooth as a breeze.</p><p class="sub fs-12">${where} · ${esc(engine)}</p><div class="row end"><button class="btn btn-primary" data-close>OK</button></div>`);
}
function run(act: string): void {
  const fn = commands[act];
  if (fn) Promise.resolve(fn()).catch((e: unknown) => toast(errMsg(e)));
}
// Undo and redo in the code editor use its own history; everything else goes to the focused field.
function editRole(role: string): void {
  const fe = focusedEditor();
  const b = fe?.b;
  const topAction = actionUndoStack.at(-1);
  const isRecentTreeAction = topAction && topAction.type.startsWith('tree-') &&
    ((topAction as any).timestamp ?? 0) > (lastUserTypeAt || 0);

  if (role === 'undo') {
    if (isRecentTreeAction) {
      void undoAppAction();
      return;
    }
    if (b && b.undo.length > 0) {
      stepHistory(b, true, fe.ta);
      fe.ta.focus();
      return;
    }
    if (actionUndoStack.length > 0) {
      void undoAppAction();
      return;
    }
    if (b) {
      stepHistory(b, true, fe.ta);
      fe.ta.focus();
      return;
    }
  }
  if (role === 'redo') {
    const topRedo = actionRedoStack.at(-1);
    const isRecentTreeRedo = topRedo?.type.startsWith('tree-');
    if (isRecentTreeRedo) {
      void redoAppAction();
      return;
    }
    if (b && b.redo.length > 0) {
      stepHistory(b, false, fe.ta);
      fe.ta.focus();
      return;
    }
    if (actionRedoStack.length > 0) {
      void redoAppAction();
      return;
    }
    if (b) {
      stepHistory(b, false, fe.ta);
      fe.ta.focus();
      return;
    }
  }
  // The surface's text isn't in the DOM, so the native select-all would only select its hidden input.
  if (role === 'selectAll' && fe) {
    fe.ta.focus();
    fe.ta.setSelectionRange(0, fe.ta.value.length);
    return;
  }
  // Copy, cut and paste: Electron fires the clipboard event on the focused hidden input, which the surface handles.
  fe?.ta.focus();
  background(api.win.edit(role));
}
function cycleTab(d: number): void {
  if (!openTabs.length) return;
  const i = active ? openTabs.indexOf(active) : -1;
  setActive(openTabs[(i + d + openTabs.length) % openTabs.length]);
}
async function openFolderCmd(): Promise<void> {
  if (!(await confirmDiscard())) return;
  const r = await api.fs.openFolder();
  if (r) await loadWorkspace(r);
}
async function openRecentFolder(dir: string): Promise<void> {
  if (!(await confirmDiscard())) return;
  try { await loadWorkspace(await api.fs.openRecent(dir)); } catch (e) { toast(errMsg(e)); }
}
async function openRecentPicker(): Promise<void> {
  const recent = await api.fs.recent();
  if (!recent.length) { toast('No recent folders yet'); return; }
  const rows = recent.map(r => `<div class="qo-item" data-r="${escAttr(r.path)}"><span>${esc(r.name)}</span><small>${esc(r.path)}</small></div>`);
  openModal(`<h3>Open recent</h3><div class="qo-list">${rows.join('')}</div>`,
    m => $$('[data-r]', m).forEach(el => el.onclick = () => { closeModal(); void openRecentFolder(el.dataset.r as string); }), undefined, 'top');
}
async function closeFolderCmd(): Promise<void> {
  if (!rootInfo || !(await confirmDiscard())) return;
  store.del(hotExitKey());
  await api.fs.closeFolder();
  resetWorkspace();
  renderTree(); renderTabs(); renderEditor();
}
// Before leaving a folder: save, discard or cancel any unsaved files.
function confirmDiscard(): Promise<boolean> {
  const dirty = [...buffers.values()].filter(isDirty);
  if (!dirty.length) return Promise.resolve(true);
  return new Promise(res => {
    const finish = settleOnce(res);
    openModal(`<h3>Save changes to ${plural(dirty.length, 'file')}?</h3><p class="sub">${dirty.map(b => esc(shownPath(b.path))).join('<br>')}</p>
      <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn" id="dDiscard">Don't Save</button><button class="btn btn-primary" id="dSave">Save All</button></div>`, m => {
      $('#dDiscard', m).onclick = () => {
        for (const b of dirty) { b.text = b.saved; if (b.ta) b.ta.value = b.saved; }
        finish(true); closeModal();
      };
      // Closed first without cancelling: a file changed on disk may ask its own question while saving.
      $('#dSave', m).onclick = () => { modalOnClose = null; closeModal(); background(saveAll().then(finish, err => { finish(false); throw err; })); };
    }, () => finish(false));
  });
}

interface Menu { name: string; items: MenuItem[]; }
const MENUS: Menu[] = [
  {
    name: 'File', items: [
      { label: 'Home', act: 'app.home' },
      { sep: true },
      { label: 'New File', act: 'file.newFile', key: 'Ctrl+N' },
      { label: 'New Folder', act: 'file.newFolder' },
      { sep: true },
      { label: 'Open File', act: 'file.openFile', key: 'Ctrl+K' },
      { label: 'Open Folder', act: 'file.openFolder', key: 'Ctrl+O' },
      { label: 'Open Recent', act: 'file.openRecent' },
      { sep: true },
      { label: 'Save', act: 'file.save', key: 'Ctrl+S', enabled: hasFile },
      { label: 'Save All', act: 'file.saveAll', key: 'Ctrl+Alt+S', enabled: () => [...buffers.values()].some(isDirty) },
      { sep: true },
      { label: 'Close Editor', act: 'file.closeEditor', key: 'Ctrl+W', enabled: () => !!active },
      { label: 'Close Folder', act: 'file.closeFolder', enabled: () => !!rootInfo },
      { sep: true },
      { label: 'Exit', act: 'file.exit' },
    ]
  },
  {
    name: 'Edit', items: [
      { label: 'Undo', act: 'edit.undo', key: 'Ctrl+Z', native: true },
      { label: 'Redo', act: 'edit.redo', key: 'Ctrl+Y', native: true },
      { sep: true },
      { label: 'Cut', act: 'edit.cut', key: 'Ctrl+X', native: true },
      { label: 'Copy', act: 'edit.copy', key: 'Ctrl+C', native: true },
      { label: 'Paste', act: 'edit.paste', key: 'Ctrl+V', native: true },
      { sep: true },
      { label: 'Find', act: 'edit.find', key: 'Ctrl+F', enabled: hasFile },
      { label: 'Replace', act: 'edit.replace', key: 'Ctrl+H', enabled: hasFile },
      { label: 'Find in Files', act: 'view.search', key: 'Ctrl+Shift+F' },
      { sep: true },
      { label: 'Toggle Line Comment', act: 'edit.comment', key: 'Ctrl+/', enabled: hasFile },
    ]
  },
  {
    name: 'Selection', items: [
      { label: 'Select All', act: 'edit.selectAll', key: 'Ctrl+A', native: true },
      { label: 'Select Line', act: 'sel.line', key: 'Ctrl+L', enabled: hasFile },
      { sep: true },
      { label: 'Copy Line Down', act: 'sel.dup', key: 'Shift+Alt+Down', enabled: hasFile },
      { label: 'Move Line Up', act: 'sel.up', key: 'Alt+Up', enabled: hasFile },
      { label: 'Move Line Down', act: 'sel.down', key: 'Alt+Down', enabled: hasFile },
      { sep: true },
      { label: 'Add Next Occurrence', act: 'sel.addNext', key: 'Ctrl+D', enabled: hasFile },
      { label: 'Select All Occurrences', act: 'sel.allOccurrences', key: 'Ctrl+Shift+L', enabled: hasFile },
      { label: 'Add Cursor Above', act: 'sel.cursorAbove', key: 'Ctrl+Alt+Up', enabled: hasFile },
      { label: 'Add Cursor Below', act: 'sel.cursorBelow', key: 'Ctrl+Alt+Down', enabled: hasFile },
    ]
  },
  {
    name: 'View', items: [
      { label: 'Command Palette…', act: 'view.palette', key: 'Ctrl+Shift+P' },
      { sep: true },
      { label: 'Explorer', act: 'view.files', key: 'Ctrl+Shift+E' },
      { label: 'Search', act: 'view.search', key: 'Ctrl+Shift+F' },
      { label: 'Checkpoints', act: 'view.git', key: 'Ctrl+Shift+G' },
      { sep: true },
      { label: 'Primary Side Bar', act: 'view.toggleSide', key: 'Ctrl+B', checked: () => layout.sideOpen },
      { label: 'Agents Panel', act: 'view.toggleAgents', key: 'Ctrl+Alt+B', checked: () => layout.agentsOpen },
      { label: 'Terminal', act: 'term.toggle', key: 'Ctrl+`', checked: () => layout.termOpen },
      { label: 'Preview', act: 'view.togglePreview', checked: () => layout.previewOpen },
      { label: 'Notebook View', act: 'nb.toggleView', checked: () => nbShown(activeBuf()), enabled: () => isNotebook(activeBuf()) },
      { label: 'Minimap', act: 'view.toggleMinimap', checked: () => minimapOn },
      { label: 'Split Editor Right', act: 'view.splitEditor', key: 'Ctrl+\\', checked: () => !!splitPath },
      { label: 'Reset Layout', act: 'view.resetLayout' },
      { sep: true },
      { label: 'Reload Window', act: 'win.reload', key: 'Ctrl+R' },
      { label: 'Toggle Developer Tools', act: 'win.devtools', key: 'Ctrl+Shift+I' },
    ]
  },
  {
    name: 'Go', items: [
      { label: 'Go to File', act: 'go.file', key: 'Ctrl+P' },
      { label: 'Go to Line', act: 'go.line', key: 'Ctrl+G', enabled: hasFile },
      { label: 'Next Problem', act: 'go.nextProblem', key: 'F8', enabled: hasFile },
      { sep: true },
      { label: 'Go to Definition', act: 'go.definition', key: 'F12', enabled: hasFile },
      { label: 'Find References', act: 'go.references', key: 'Shift+F12', enabled: hasFile },
      // F2 renames the file in the explorer and the symbol in the editor (editorKeys).
      { label: 'Rename Symbol', act: 'go.rename', key: 'F2', native: true, enabled: hasFile },
      { sep: true },
      { label: 'Toggle Mark', act: 'mark.toggle', key: 'Ctrl+Alt+K', enabled: hasFile },
      { label: 'Next Mark', act: 'mark.next', key: 'Ctrl+Alt+L' },
      { label: 'Previous Mark', act: 'mark.prev', key: 'Ctrl+Alt+J' },
      { label: 'Clear Marks in File', act: 'mark.clear', enabled: hasFile },
      { sep: true },
      { label: 'Next Editor', act: 'go.nextEditor', key: 'Ctrl+Tab' },
      { label: 'Previous Editor', act: 'go.prevEditor', key: 'Ctrl+Shift+Tab' },
    ]
  },
  {
    name: 'Run', items: [
      { label: 'Run File', act: 'run.file', enabled: () => runnable(active) },
      { label: 'Start Preview / Run File', act: 'run.start', key: 'F5' },
      { label: 'Reload Preview', act: 'run.reload', key: 'Ctrl+F5', enabled: () => running },
      { label: 'Stop Preview', act: 'run.stop', key: 'Shift+F5', enabled: () => running || term.runId != null },
      { sep: true },
      { label: 'Start Debugging', act: 'debug.start', key: 'Ctrl+Shift+D' },
      { label: 'Open Debug View', act: 'debug.open' },
      // Continue and Stop Debugging share F5 and Shift+F5 with the two above (see run.start and debugKeyAct).
      { label: 'Continue', act: 'debug.continue', keyFrom: 'run.start', enabled: () => debugState === 'paused' },
      { label: 'Pause', act: 'debug.pause', key: 'F6', enabled: () => debugState === 'running' },
      { label: 'Step Over', act: 'debug.stepOver', key: 'F10', enabled: () => debugState === 'paused' },
      { label: 'Step Into', act: 'debug.stepInto', key: 'F11', enabled: () => debugState === 'paused' },
      { label: 'Step Out', act: 'debug.stepOut', key: 'Shift+F11', enabled: () => debugState === 'paused' },
      { label: 'Restart Debugging', act: 'debug.restart', key: 'Ctrl+Shift+F5', enabled: () => debugState !== 'stopped' },
      { label: 'Stop Debugging', act: 'debug.stop', keyFrom: 'run.stop', enabled: () => debugState !== 'stopped' },
      { label: 'Toggle Breakpoint', act: 'debug.toggleBreakpoint', key: 'F9', enabled: () => hasFile() || debugPageShowing() },
      { sep: true },
      { label: 'Toggle Live Share', act: 'live.toggle' },
    ]
  },
  {
    name: 'Terminal', items: [
      { label: 'New Terminal', act: 'term.new', key: 'Ctrl+Shift+`' },
      { label: 'New Terminal Window', act: 'term.newWindow' },
      { label: 'Toggle Terminal', act: 'term.toggle', key: 'Ctrl+`' },
      { sep: true },
      { label: 'Clear Terminal', act: 'term.clear' },
      { label: 'Stop Running Command', act: 'term.kill', enabled: () => term.proc != null },
    ]
  },
  {
    name: 'Help', items: [
      { label: 'Settings', act: 'settings.open', key: 'Ctrl+,' },
      { label: 'Keyboard Shortcuts', act: 'help.keys' },
      { label: 'Show All Commands', act: 'view.paletteF1', key: 'F1' },
      { label: 'Run Setup Again', act: 'help.setup' },
      { label: 'Vibe Mode Feeds', act: 'vibe.feeds' },
      { label: 'Sound Effects', act: 'sound.toggle', checked: () => sfx.on },
      { sep: true },
      { label: 'Home', act: 'app.home' },
      { label: 'Breeze Code', act: 'mode.ide', checked: () => appState.mode === 'ide' },
      { label: 'Breeze Space', act: 'mode.box', checked: () => appState.mode === 'box' },
      { sep: true },
      { label: 'Sync Workspace', act: 'sync.run', enabled: () => !!user && !!rootInfo },
      { label: 'Open Cloud Workspace', act: 'sync.open', enabled: () => !!user },
      { sep: true },
      { label: 'Add Account', act: 'account.signIn' },
      { label: 'Sign Out', act: 'account.signOut', enabled: () => !!user },
    ]
  },
];
// Go, Run and Help stay out of the menu bar; their shortcuts still work and Help lives under the gear button.
const BAR_MENUS = MENUS.filter(m => !['Go', 'Run', 'Help'].includes(m.name));
// Shortcuts handled by the editor itself or by keydown elsewhere, but listed for discoverability.
const EXTRA_KEYS: [string, string][] = [['F2', 'explorer.rename']];
commands['explorer.rename'] = () => { if (active) return renameEntry(active); };
commands['sound.toggle'] = () => sfx.toggle();

const canonKey = (combo: string): string => {
  const parts = combo.split('+');
  const key = parts.pop() as string;
  const mods = new Set(parts);
  return ['Ctrl', 'Shift', 'Alt'].filter(m => mods.has(m)).concat(key.length === 1 ? key.toUpperCase() : key).join('+');
};
const keymap = new Map<string, string>();

/* ----- Key binds: the menu shortcuts, changed in Settings → Controls ----- */
// The menus' own keys ('' for a command without one), kept before any change. Native ones (copy, paste, undo…)
// belong to the editor and stay put.
const DEFAULT_KEYS = new Map<string, string>();
for (const { items } of MENUS) for (const it of items) if (it.act && it.label && !it.native && !it.keyFrom && !DEFAULT_KEYS.has(it.act)) DEFAULT_KEYS.set(it.act, it.key ?? '');
// The user's changes: command → combo, '' for one with its key removed.
let keyBinds = store.get<Record<string, string>>('breeze.keys', {});
const keyOf = (act: string): string => (act in keyBinds ? keyBinds[act] : DEFAULT_KEYS.get(act) ?? '');
// The menus show, and the keymap runs, the keys in use now.
function applyKeyBinds(): void {
  for (const { items } of MENUS) {
    for (const it of items) {
      if (it.keyFrom) it.key = keyOf(it.keyFrom) || undefined;
      else if (it.act && DEFAULT_KEYS.has(it.act)) it.key = keyOf(it.act) || undefined;
    }
  }
  keymap.clear();
  for (const [k, act] of EXTRA_KEYS) keymap.set(canonKey(k), act);
  for (const act of DEFAULT_KEYS.keys()) { const k = keyOf(act); if (k) keymap.set(canonKey(k), act); }
}
// Gives `act` the combo ('' removes its key). A command that had that combo loses it; its name is returned.
function setKeyBind(act: string, combo: string): string | null {
  let took: string | null = null;
  if (combo) {
    for (const other of DEFAULT_KEYS.keys()) {
      if (other !== act && keyOf(other) && canonKey(keyOf(other)) === canonKey(combo)) { keyBinds[other] = ''; took = other; }
    }
  }
  if (combo === (DEFAULT_KEYS.get(act) ?? '')) delete keyBinds[act]; else keyBinds[act] = combo;
  store.set('breeze.keys', keyBinds);
  applyKeyBinds();
  return took;
}
function resetKeyBinds(act?: string): void {
  if (act) delete keyBinds[act]; else keyBinds = {};
  // A reset key may still be in use by another command's change: that one gives it back.
  if (act) { const k = DEFAULT_KEYS.get(act); for (const other of Object.keys(keyBinds)) if (k && keyBinds[other] && canonKey(keyBinds[other]) === canonKey(k)) keyBinds[other] = ''; }
  store.set('breeze.keys', keyBinds);
  applyKeyBinds();
}
// Every rebindable command, by menu, for the Controls list.
function keyBindRows(): { menu: string; act: string; label: string }[] {
  const rows: { menu: string; act: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const { name, items } of MENUS) {
    for (const it of items) {
      if (!it.act || !it.label || !DEFAULT_KEYS.has(it.act) || seen.has(it.act)) continue;
      seen.add(it.act);
      rows.push({ menu: name, act: it.act, label: it.label });
    }
  }
  return rows;
}
applyKeyBinds();
const KEY_BY_CODE: Record<string, string> = { Backquote: '`', Slash: '/', Backslash: '\\', Comma: ',' };
function keyName(e: KeyboardEvent): string {
  if (KEY_BY_CODE[e.code]) return KEY_BY_CODE[e.code];
  if (e.key.startsWith('Arrow')) return e.key.slice(5);
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}
function comboOf(e: KeyboardEvent): string {
  return [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.shiftKey ? 'Shift' : '', e.altKey ? 'Alt' : '', keyName(e)].filter(Boolean).join('+');
}
// Commands that only make sense while typing in the code editor.
const EDITOR_ONLY = new Set(['edit.comment', 'sel.line', 'sel.dup', 'sel.up', 'sel.down', 'sel.addNext', 'sel.allOccurrences', 'sel.cursorAbove',
  'sel.cursorBelow', 'go.definition', 'go.references', 'debug.toggleBreakpoint']);

// The Keyboard shortcuts pop-up: every menu item that has a key, plus a few gestures, with a search box.
// It lives here rather than with Settings because `commands` above holds it by name while this file loads.
function showShortcuts(): void {
  interface ShortcutItem { label: string; key: string; }
  const all: ShortcutItem[] = [];
  for (const { items } of MENUS) {
    for (const it of items) {
      if (it.key && it.label) all.push({ label: it.label, key: it.key });
    }
  }
  all.push(
    { label: 'Indent / outdent', key: 'Tab / Shift+Tab' },
    { label: 'Add cursor', key: 'Alt+Click' },
    { label: 'Column select', key: 'Shift+Alt+Drag' },
    { label: 'Back to one cursor', key: 'Esc' },
    { label: 'Expand Emmet abbreviation', key: 'Tab' },
    { label: 'Rename file', key: 'F2' },
    { label: 'Menu bar', key: 'Alt' },
    { label: 'Reorder tabs', key: 'Drag a tab' }
  );

  openModal(`<h3>Keyboard shortcuts</h3><p class="sub">Drag any panel edge to resize it; drag it closed to hide it.</p>
    <input class="input w-full mb-12" id="shortcutSearch" placeholder="Search keyboard shortcuts" spellcheck="false" autocomplete="off">
    <div class="kbd-table" id="shortcutList"></div>
    <div class="row end"><button class="btn btn-primary" data-close>Close</button></div>`, m => {
    const input = $<HTMLInputElement>('#shortcutSearch', m);
    const list = $('#shortcutList', m);
    input?.focus();
    const render = () => {
      const q = (input?.value || '').toLowerCase().trim();
      const filtered = q
        ? all.filter(s => s.label.toLowerCase().includes(q) || s.key.toLowerCase().includes(q))
        : all;
      if (!filtered.length) {
        list.innerHTML = '<div class="side-note keys-empty">No matching shortcuts</div>';
      } else {
        list.innerHTML = filtered.map(s => `<span>${esc(s.label)}</span><kbd>${esc(s.key)}</kbd>`).join('');
      }
    };
    render();
    if (input) input.oninput = render;
  });
}

/* ----- Menus: the bar opens on hover; the gear and right-clicks pop up ----- */
let openMenuIdx = -1;      // bar menu index, -2 for a popup, -1 when closed
let menuPinned = false;    // opened by a click or the keyboard: stays open when the pointer leaves
let menuCloseTimer: TimeoutId | undefined;
let kbIdx = -1;
let menuItems: MenuItem[] = [];
let menuOnClose: (() => void) | null = null;
function cancelMenuClose(): void { clearTimeout(menuCloseTimer); }
// A menu opened by hovering closes shortly after the pointer leaves both the bar and the menu.
function scheduleMenuClose(): void {
  cancelMenuClose();
  menuCloseTimer = setTimeout(() => { if (openMenuIdx >= 0 && !menuPinned) closeMenu(); }, 130);
}
function buildMenubar(): void {
  $('#menubar').innerHTML = BAR_MENUS.map((m, i) => `<button class="menu-top" data-menu="${i}" aria-haspopup="menu">${esc(m.name)}</button>`).join('');
  $$('[data-menu]').forEach(b => {
    const i = Number(b.dataset.menu);
    b.onmouseenter = () => {
      cancelMenuClose();
      if (openMenuIdx !== i) openMenu(i, false, menuPinned && openMenuIdx >= 0);
    };
    b.onmouseleave = scheduleMenuClose;
    b.onmousedown = e => {
      e.preventDefault();
      // A click pins a hover-opened menu; clicking a pinned menu closes it.
      if (openMenuIdx === i && menuPinned) closeMenu();
      else openMenu(i, false, true);
    };
  });
}
function openMenu(i: number, viaKeyboard = false, pinned = viaKeyboard): void {
  const btn = $(`[data-menu="${i}"]`);
  const r = btn.getBoundingClientRect();
  showMenu(r.left, r.bottom + 2, BAR_MENUS[i].items, viaKeyboard);
  openMenuIdx = i;
  menuPinned = pinned;
  $$('[data-menu]').forEach(b => b.classList.toggle('open', b === btn));
  const m = $('#menuRoot .menu');
  m.classList.remove('stagger'); // the menu bar keeps the plain drop-down (menuIn), not the staggered unroll
  m.onmouseenter = cancelMenuClose;
  m.onmouseleave = scheduleMenuClose;
}
/* ----- Popups grow out of the icon that opened them and shrink back into it ----- */
let popTrigger: { el: HTMLElement; at: number } | null = null;
let menuOwner: HTMLElement | null = null; // the button whose menu is (or was just) open, for modals its items open
let activeMenuTrigger: HTMLElement | null = null;
let justClosedTrigger: HTMLElement | null = null;
let justClosedAt = 0;
const noteTrigger = (e: Event) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('button, [role="button"]');
  if (el) popTrigger = { el, at: Date.now() };
};
document.addEventListener('pointerdown', noteTrigger, true);
document.addEventListener('click', noteTrigger, true);
// The button that just opened a popup (an item in a menu stands for the button that opened that menu). Popups opened
// any other way (a shortcut, a right-click) keep their plain animation.
function popOwner(): HTMLElement | null {
  if (!popTrigger || Date.now() - popTrigger.at > 700) return null;
  const el = popTrigger.el.closest('.menu') ? menuOwner : popTrigger.el;
  return el?.isConnected ? el : null;
}
// Sets the scale-from point of `pop` (placed at left/top, or wherever it sits) to the middle of its button.
function growFrom(pop: HTMLElement, owner: HTMLElement, at?: { left: number; top: number }): void {
  const i = owner.getBoundingClientRect();
  // Where the popup sits by layout: its bounding box would include the opening animation's transform, already running.
  let p = at;
  if (!p) {
    p = { left: 0, top: 0 };
    for (let e: HTMLElement | null = pop; e; e = e.offsetParent as HTMLElement | null) { p.left += e.offsetLeft; p.top += e.offsetTop; }
  }
  pop.style.transformOrigin = `${i.left + i.width / 2 - p.left}px ${i.top + i.height / 2 - p.top}px`;
  pop.classList.add('from-button');
}
function popupMenu(x: number, y: number, items: MenuItem[], onClose?: () => void, trigger?: HTMLElement): void {
  const trig = trigger || popOwner() || popTrigger?.el || null;
  activeMenuTrigger = trig;
  if (trig) {
    trig.classList.add('open');
    trig.setAttribute('aria-expanded', 'true');
  }
  showMenu(x, y, items, false);
  openMenuIdx = -2;
  menuPinned = true;
  menuOnClose = () => {
    if (trig) {
      trig.classList.remove('open');
      trig.setAttribute('aria-expanded', 'false');
    }
    onClose?.();
  };
}
// A non-clickable row showing who is signed in.
function menuHeaderHtml(u: User): string {
  const detail = [u.email ?? u.login, u.provider].filter(Boolean).join(' · ');
  return `<div class="menu-label">${avatarHtml(u, '')}<span class="who"><b>${esc(u.name)}</b><small>${esc(detail)}</small></span></div>`;
}
function menuSliderHtml(sl: MenuSlider, i: number): string {
  const dots = sl.steps.map((_s, k) => `<i data-style="--at:${k / (sl.steps.length - 1)}"></i>`).join('');
  const reset = sl.reset ? `<button type="button" class="ms-reset" aria-label="Reset ${escAttr(sl.label)}">${svgIcon('rotateCcw', 13)}</button>` : '';
  return `<div class="menu-slider" data-ms="${i}" data-style="--i:${i}">
    <div class="ms-head"><b class="ms-val"></b>${sl.hint ? '<small class="ms-hint"></small>' : ''}${reset}</div>
    <div class="ms-track" role="slider" tabindex="0" aria-label="${escAttr(sl.label)}" aria-valuemin="0" aria-valuemax="${sl.steps.length - 1}"><span class="ms-fill"></span>${dots}<span class="ms-thumb"></span></div>
  </div>`;
}
// Draws the slider at step `i` (or, while dragging, at a fraction `at` of the track) and wires its pointer and keys.
function bindMenuSlider(row: HTMLElement, sl: MenuSlider): void {
  const track = row.querySelector<HTMLElement>('.ms-track') as HTMLElement;
  const last = sl.steps.length - 1;
  // Bubbles stream right through the fill (which clips them), each at its own height, size, speed and slight drift,
  // and started part-way through its trip so they don't set off together.
  const bubbles: Animation[] = [];
  const fill = row.querySelector<HTMLElement>('.ms-fill');
  if (fill && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const w = track.offsetWidth;
    for (let k = 0; k < 16; k++) {
      const b = document.createElement('span');
      const size = 1.5 + Math.random() * 3;
      b.className = 'ms-bubble';
      b.style.cssText = `width:${size}px;height:${size}px;top:${2 + Math.random() * (16 - size)}px;opacity:${.25 + Math.random() * .55}`;
      fill.append(b);
      const drift = (Math.random() - .5) * 6, dur = 1100 + Math.random() * 1500;
      bubbles.push(b.animate([{ transform: 'translate(-6px, 0)' }, { transform: `translate(${w}px, ${drift}px)` }],
        { duration: dur, delay: -Math.random() * dur, iterations: Infinity }));
    }
  }
  const paint = (i: number, at = i / last) => {
    row.style.setProperty('--pos', String(at));
    // The top step (Extra) turns the fill red and races the bubbles.
    row.classList.toggle('max', i === last);
    // More effort, faster bubbles; updatePlaybackRate keeps each bubble where it is instead of jumping.
    for (const a of bubbles) a.updatePlaybackRate(i === last ? 6 : .6 + at * 2.4);
    swapText(row.querySelector('.ms-val') as HTMLElement, sl.steps[i]);
    const hint = row.querySelector<HTMLElement>('.ms-hint');
    if (hint && sl.hint) swapText(hint, sl.hint(i));
    track.setAttribute('aria-valuenow', String(i));
    track.setAttribute('aria-valuetext', sl.steps[i]);
  };
  const pick = (i: number) => { if (i !== sl.value()) sl.set(i); paint(sl.value()); };
  const fraction = (e: PointerEvent) => { const r = track.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  paint(sl.value());
  row.onmousedown = e => e.preventDefault(); // keep focus where it was, like the other rows
  track.onpointerdown = e => {
    track.setPointerCapture(e.pointerId);
    row.classList.add('dragging');
    const at = fraction(e);
    paint(Math.round(at * last), at);
  };
  track.onpointermove = e => {
    if (!track.hasPointerCapture(e.pointerId)) return;
    const at = fraction(e);
    paint(Math.round(at * last), at);
  };
  track.onpointerup = e => {
    row.classList.remove('dragging');
    pick(Math.round(fraction(e) * last));
  };
  track.onpointercancel = () => { row.classList.remove('dragging'); paint(sl.value()); };
  track.onkeydown = e => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? last : step != null ? sl.value() + step : null;
    if (to == null) return;
    e.preventDefault();
    e.stopPropagation();
    pick(Math.min(last, Math.max(0, to)));
  };
  const reset = row.querySelector<HTMLElement>('.ms-reset');
  if (reset && sl.reset) { const r = sl.reset; reset.onclick = () => { r(); paint(sl.value()); }; }
}
function menuItemHtml(it: MenuItem, i: number): string {
  if (it.sep) return `<div class="menu-sep" data-style="--i:${i}"></div>`;
  if (it.header) return menuHeaderHtml(it.header);
  if (it.slider) return menuSliderHtml(it.slider, i);
  const cls = ['menu-item', it.checked?.() ? 'checked' : '', it.sub ? 'has-sub' : '', i === kbIdx ? 'kb' : ''].filter(Boolean).join(' ');
  const disabled = it.enabled && !it.enabled() ? ' disabled' : '';
  const key = it.key ? `<span class="key">${esc(it.key)}</span>` : '';
  const popup = it.sub ? ' aria-haspopup="menu"' : '';
  const label = it.icon ? `<span class="mi-ico-label">${it.icon}<span>${esc(it.label ?? '')}</span></span>` : `<span>${esc(it.label ?? '')}</span>`;
  const del = it.remove ? holdDelHtml(it.label ?? '', 'data-mi-del', 'span', 'minus') : '';
  const tick = it.checked?.() ? `<span class="menu-check">${svgIcon('check', 12)}</span>` : '';
  return `<button class="${cls}${it.remove ? ' has-del' : ''}" role="menuitem" data-mi="${i}" data-style="--i:${i}"${disabled}${popup}>${tick}${label}${key}${del}</button>`;
}
// Builds a menu element at (x, y), kept inside the window.
function renderMenu(x: number, y: number, items: MenuItem[], cls = 'menu', depth = 0): HTMLElement {
  const m = document.createElement('div');
  m.className = `${cls} stagger`;
  m.dataset.depth = String(depth);
  m.setAttribute('role', 'menu');
  m.innerHTML = items.map((it, i) => menuItemHtml(it, i)).join('');
  m.style.setProperty('--n', String(items.length)); // menus that open upwards stagger their rows from the bottom
  applyDataStyles(m);
  $('#menuRoot').append(m);
  m.style.left = `${Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8))}px`;
  m.style.top = `${Math.max(8, Math.min(y, innerHeight - m.offsetHeight - 8))}px`;
  $$<HTMLElement>('[data-ms]', m).forEach(row => {
    const sl = items[Number(row.dataset.ms)].slider;
    if (sl) bindMenuSlider(row, sl);
    if (depth) row.onmouseenter = () => closeSubmenu(depth + 1);
    else row.onmouseenter = () => closeSubmenu(1);
  });
  $$('[data-mi]', m).forEach(b => {
    const it = items[Number(b.dataset.mi)];
    b.onmousedown = e => e.preventDefault(); // keep focus (and the selection) in the editor
    b.onclick = () => (it.sub && !it.clickRuns ? openSubmenu(b, it) : activateMenuItem(it));
    const del = b.querySelector<HTMLElement>('[data-mi-del]');
    if (del && it.remove) { const remove = it.remove; holdToDelete(del, () => { closeMenu(); remove(); }); }
    // Submenus open on hover at every level; hovering a plain row closes any deeper ones.
    if (cls === 'menu' || it.sub) b.onmouseenter = () => (it.sub ? openSubmenu(b, it) : closeSubmenu(depth + 1));
    else if (depth) b.onmouseenter = () => closeSubmenu(depth + 1);
  });
  return m;
}
// Hovering an item with "›" opens its submenu beside it.
function openSubmenu(btn: HTMLElement, it: MenuItem): void {
  if (btn.classList.contains('sub-open')) return;
  const depth = Number(btn.closest<HTMLElement>('.menu')?.dataset.depth ?? 0) + 1;
  closeSubmenu(depth);
  btn.classList.add('sub-open');
  // Measured by layout: hovered while the menu is still growing in, its bounding box is the shrunken one mid-animation,
  // which put the submenu on top of it. (A menu is position: fixed, so its offsets are from the window.)
  const menu = btn.closest<HTMLElement>('.menu');
  const top = (menu ? menu.offsetTop + menu.clientTop : 0) + btn.offsetTop;
  const r = { top, bottom: top + btn.offsetHeight };
  const edge = menu ? { left: menu.offsetLeft, right: menu.offsetLeft + menu.offsetWidth } : btn.getBoundingClientRect(); // a gap from the menu itself, not the row inside it
  const cls = 'menu sub' + (it.subClass ? ` ${it.subClass}` : '');
  const sub = renderMenu(edge.right + 8, r.top - 5, it.sub?.() ?? [], cls, depth);
  if (!btn.closest('.menu')?.classList.contains('stagger')) sub.classList.remove('stagger'); // like its parent menu
  if (btn.closest('.menu.up')) {
    sub.classList.add('up');
    sub.style.top = `${Math.max(8, r.bottom - sub.offsetHeight + 5)}px`;
  }
  if (sub.offsetLeft < edge.right) sub.style.left = `${Math.max(8, edge.left - sub.offsetWidth - 8)}px`; // no room on the right
}
// Closes the submenus at `depth` and deeper (1, the default, is all of them).
function closeSubmenu(depth = 1): void {
  for (const m of $$<HTMLElement>('#menuRoot .menu')) {
    const d = Number(m.dataset.depth ?? 0);
    if (d >= depth) m.remove();
    else if (d === depth - 1) $$('.sub-open', m).forEach(b => b.classList.remove('sub-open'));
  }
}
function showMenu(x: number, y: number, items: MenuItem[], viaKeyboard: boolean): void {
  cancelMenuClose();
  sfx.play('menu');
  menuItems = items;
  kbIdx = viaKeyboard ? items.findIndex(it => !it.sep && !it.header && !it.slider) : -1;
  $('#menuRoot').innerHTML = '';
  menuOwner = popOwner();
  const m = renderMenu(x, y, items);
  // Callers may still restyle the menu (width, flip above its button), so the origin is set once they are done.
  const owner = menuOwner;
  if (owner) queueMicrotask(() => { if (m.isConnected) growFrom(m, owner, { left: Number.parseFloat(m.style.left), top: Number.parseFloat(m.style.top) }); });
}
function activateMenuItem(it: MenuItem): void {
  if (it.enabled && !it.enabled()) return;
  closeMenu();
  if (it.run) it.run(); else if (it.act) run(it.act);
}
function closeMenu(): void {
  cancelMenuClose();
  if (openMenuIdx === -1) return;
  if (activeMenuTrigger) {
    justClosedTrigger = activeMenuTrigger;
    justClosedAt = Date.now();
    activeMenuTrigger.classList.remove('open');
    activeMenuTrigger.setAttribute('aria-expanded', 'false');
    activeMenuTrigger = null;
  }
  openMenuIdx = -1; kbIdx = -1; menuPinned = false;
  // Menus fade out before they are removed; opening another menu clears the root straight away.
  const root = $('#menuRoot');
  const leaving = $$('.menu', root);
  if (!leaving.length) root.innerHTML = '';
  for (const m of leaving) {
    m.classList.add('closing');
    // Item animations bubble up too; only the menu's own exit ends it.
    m.addEventListener('animationend', e => { if (e.target === m) m.remove(); });
    setTimeout(() => m.remove(), 320);
  }
  $$('[data-menu]').forEach(b => b.classList.remove('open'));
  const cb = menuOnClose; menuOnClose = null; cb?.();
}
document.addEventListener('mousedown', e => {
  const target = e.target as HTMLElement;
  if (openMenuIdx !== -1) {
    const trig = activeMenuTrigger;
    if (trig && (trig === target || trig.contains(target))) {
      justClosedTrigger = trig;
      justClosedAt = Date.now();
      closeMenu();
      return;
    }
    if (!target.closest('.menu, .menubar, #settingsBtn, #boxSettings, #homeSettings, .avatars, .dd-btn, #chatHistory,#boxModel, #boxFolder, [data-act="git.more"]')) {
      closeMenu();
    }
  }
});
window.addEventListener('blur', closeMenu);
function moveKbSelection(down: boolean): void {
  const usable = menuItems.map((it, i) => (!it.sep && !it.header && !it.slider && (!it.enabled || it.enabled()) ? i : -1)).filter(i => i !== -1);
  const pos = usable.indexOf(kbIdx);
  kbIdx = usable[(pos + (down ? 1 : -1) + usable.length) % usable.length] ?? -1;
  $$('[data-mi]').forEach(b => b.classList.toggle('kb', Number(b.dataset.mi) === kbIdx));
  slideKbHighlight();
}
// The keyboard highlight is one block (the menu's ::before) that slides to the selected row.
function slideKbHighlight(): void {
  const b = document.querySelector<HTMLElement>('#menuRoot .menu-item.kb');
  const m = b?.closest<HTMLElement>('.menu');
  if (!b || !m) return;
  for (const [k, v] of [['x', b.offsetLeft], ['y', b.offsetTop], ['w', b.offsetWidth], ['h', b.offsetHeight]] as const) m.style.setProperty(`--kb-${k}`, `${v}px`);
  if (m.classList.contains('kb-on')) return;
  m.classList.add('kb-on'); // first placement jumps; later moves slide
  void m.offsetWidth; // apply that placement before turning the slide on
  m.classList.add('kb-slide');
}
function menuKeys(e: KeyboardEvent): boolean {
  if (openMenuIdx === -1 || mentionOpen() || slashOpen()) return false; // the "@" and "/" menus' keys are handled on their prompt
  if (e.key === 'Escape') closeMenu();
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') moveKbSelection(e.key === 'ArrowDown');
  else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && openMenuIdx >= 0) {
    openMenu((openMenuIdx + (e.key === 'ArrowRight' ? 1 : -1) + BAR_MENUS.length) % BAR_MENUS.length, true);
  } else if (e.key === 'Enter' && kbIdx >= 0) activateMenuItem(menuItems[kbIdx]);
  else return false;
  e.preventDefault();
  return true;
}

const focused = () => document.activeElement as HTMLElement | null;
// Shift+F5 stops the debugger while a session is going, and the run or preview otherwise: one key, two jobs. (F5's
// own command continues a paused session first; see run.start.) The menu's Stop Preview stays the preview's.
const debugKeyAct = (act: string | undefined) => (act === 'run.stop' && debugState !== 'stopped' ? 'debug.stop' : act);
// The debug page answers only the debugger's keys and a few app-wide ones: the rest would act on the hidden editor.
const DEBUG_PAGE_ACTS = new Set(['run.start', 'debug.start', 'debug.stop', 'debug.restart', 'debug.continue', 'debug.pause', 'debug.stepOver',
  'debug.stepInto', 'debug.stepOut', 'debug.toggleBreakpoint', 'view.palette', 'view.paletteF1', 'settings.open', 'help.keys', 'win.reload', 'win.devtools']);
function debugPageKey(e: KeyboardEvent): void {
  // Typing in the page's own boxes (watch, console, program input) is theirs: only F-keys and Ctrl/Cmd chords
  // still reach the debugger from there.
  const el = focused();
  if (el?.matches('input:not([readonly]), textarea:not([readonly])') && !/^F\d+$/.test(e.key) && !e.ctrlKey && !e.metaKey) return;
  const act = debugKeyAct(keymap.get(comboOf(e)));
  if (!act || !DEBUG_PAGE_ACTS.has(act)) return;
  e.preventDefault();
  run(act);
}
document.addEventListener('keydown', e => {
  if (menuKeys(e)) return;
  if (e.key === 'Escape') {
    if (vibeOn) { exitVibe(); return; }
    if (modalOpen()) { closeModal(); return; }
    if (findOpen) { closeFind(); activeText()?.ta.focus(); return; }
  }
  if (modalOpen() || vibeOn) return;
  if ($('#ide').classList.contains('hidden')) { if (debugPageShowing()) debugPageKey(e); return; }

  const isCtrlZ = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z' && !e.shiftKey;
  const isCtrlY = (e.ctrlKey || e.metaKey) && !e.altKey && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey));

  // Ctrl+A outside a text field selects the open file, not every word on the page.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a' && activeText() && !focused()?.matches('input, textarea, [contenteditable]')) {
    e.preventDefault();
    run('edit.selectAll');
    return;
  }

  if (isCtrlZ) {
    const el = focused();
    if (el && el.matches('input, textarea') && !el.classList.contains('ta')) {
      return;
    }
    if (el?.classList.contains('ta')) {
      const topAction = actionUndoStack.at(-1);
      const isRecentTreeAction = topAction && topAction.type.startsWith('tree-') &&
        ((topAction as any).timestamp ?? 0) > (lastUserTypeAt || 0);
      if (isRecentTreeAction) {
        e.preventDefault();
        e.stopPropagation();
        void undoAppAction();
        return;
      }
      const fe = focusedEditor();
      const b = fe?.b;
      if (b && b.undo.length > 0) {
        // The split has no editorKeys handler, so step its history here.
        if (fe.ta === splitTa) { e.preventDefault(); e.stopPropagation(); stepHistory(b, true, fe.ta); }
        return;
      }
      // The split's history is its own: with none left, Ctrl+Z must not fall through to the left file.
      if (fe?.ta === splitTa) { e.preventDefault(); return; }
    }
    if (actionUndoStack.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      void undoAppAction();
      return;
    }
    const b = activeText();
    if (b && b.undo.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      stepHistory(b, true);
      return;
    }
  }

  if (isCtrlY) {
    const el = focused();
    if (el && el.matches('input, textarea') && !el.classList.contains('ta')) {
      return;
    }
    if (el?.classList.contains('ta')) {
      const topRedo = actionRedoStack.at(-1);
      const isRecentTreeRedo = topRedo?.type.startsWith('tree-');
      if (isRecentTreeRedo) {
        e.preventDefault();
        e.stopPropagation();
        void redoAppAction();
        return;
      }
      const fe = focusedEditor();
      const b = fe?.b;
      if (b && b.redo.length > 0) {
        if (fe.ta === splitTa) { e.preventDefault(); e.stopPropagation(); stepHistory(b, false, fe.ta); }
        return;
      }
      if (fe?.ta === splitTa) { e.preventDefault(); return; } // nor redo
    }
    if (actionRedoStack.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      void redoAppAction();
      return;
    }
    const b = activeText();
    if (b && b.redo.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      stepHistory(b, false);
      return;
    }
  }

  const act = debugKeyAct(keymap.get(comboOf(e)));
  if (!act) return;
  if (EDITOR_ONLY.has(act) && !focused()?.classList.contains('ta')) return;
  if (act === 'explorer.rename' && focused()?.matches('input, textarea')) return;
  e.preventDefault();
  run(act);
}, true);
// Alt alone (released without another key) opens the menu bar, like a native app.
let altAlone = false;
document.addEventListener('keydown', e => { altAlone = e.key === 'Alt' && !e.ctrlKey && !e.shiftKey; }, true);
document.addEventListener('pointerdown', () => { altAlone = false; }, true); // Alt+Click adds a cursor; no menu after it
document.addEventListener('keyup', e => {
  if (e.key === 'Alt' && altAlone && !$('#ide').classList.contains('hidden') && !modalOpen()) {
    e.preventDefault();
    if (openMenuIdx === -1) openMenu(0, true); else closeMenu();
  }
  altAlone = false;
}, true);

