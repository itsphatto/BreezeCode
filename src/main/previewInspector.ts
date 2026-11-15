// The preview's element inspector. Right-clicking an element in the preview outlines it in blue with its
// tag, id and classes on a label above it; a left click, Escape or right-clicking empty space clears it.
// Hover mode (the mouse button in the preview bar, which posts { breezeInspector: 'hover', on } to the page) does the
// same for whatever is under the cursor, the outline gliding from one element to the next as the cursor moves. A left click pins it where it is; a click on
// the pinned element lets it follow the cursor again, and a click on another element pins it there instead. A right
// click in hover mode pins it and posts { breezeInspector: 'menu' } so Breeze can offer Edit Manually and Ask AI.
// The preview frame is sandboxed (an opaque origin), so Breeze can't reach into it: this runs inside the page,
// injected by main.js's servePreview as an inline <script>. It draws in a closed shadow root so the page's CSS
// can't restyle it, and the overlay never takes pointer events, so the page underneath still works.
function previewInspector(): void {
  // This function is stringified into the page (PREVIEW_INSPECTOR below), so it may only use what the page has: no
  // imports, no helpers from this file, and type annotations only (they are erased).
  const flag = window as Window & { __breezeInspector?: boolean };
  if (flag.__breezeInspector) return;
  flag.__breezeInspector = true;

  const BLUE = '#0a6cd8';
  let host: HTMLElement | null = null, box: HTMLElement | null = null, label: HTMLElement | null = null, target: Element | null = null, hover = false, pinned = false;

  function mount() {
    host = document.createElement('breeze-inspector');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      .box{position:fixed;box-sizing:border-box;border:1px solid rgba(10,108,216,.55);background:rgba(10,108,216,.06);border-radius:2px;
        transition:background .2s ease-out,border-color .2s ease-out}
      .label{position:fixed;max-width:calc(100vw - 8px);padding:0 5px;border-radius:3px;background:${BLUE};color:#fff;
        font:600 10px/16px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .label .tag{font-weight:700}
      .label .tag:not(:last-child){margin-right:4px}
      .label .size{opacity:.75;font-weight:500;margin-left:6px}
      /* A fast glide that settles softly: the box starts quickly toward the next element and eases into place. */
      .box.morph{transition:left .18s cubic-bezier(.16,1,.3,1),top .18s cubic-bezier(.16,1,.3,1),width .18s cubic-bezier(.16,1,.3,1),height .18s cubic-bezier(.16,1,.3,1),background .2s ease-out,border-color .2s ease-out}
      .label.morph{transition:left .18s cubic-bezier(.16,1,.3,1),top .18s cubic-bezier(.16,1,.3,1)}
      .box.pinned{border-color:rgba(10,108,216,.9);background:rgba(10,108,216,.16)}
      .box.editing{border:1px dashed ${BLUE};background:transparent}
      @media (prefers-reduced-motion:reduce){.box,.morph{transition:none!important}}
    </style><div class="box"></div><div class="label"></div>`;
    box = shadow.querySelector<HTMLElement>('.box');
    label = shadow.querySelector<HTMLElement>('.label');
  }

  // "div#hero.card.wide": the id and classes are what the label is for, the tag says what they sit on.
  function describe(el: Element) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const classes = [...el.classList].map(c => `.${c}`).join('');
    return { tag, name: id + classes };
  }

  // Morphing glides the outline to its new element; a fresh outline, or one following a scroll, jumps straight there.
  function setMorph(on: boolean) {
    box!.classList.toggle('morph', on);
    label!.classList.toggle('morph', on);
  }

  function place() {
    if (!target || !target.isConnected) { clear(); return; }
    const r = target.getBoundingClientRect();
    Object.assign(box!.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    // Above the element, or just inside its top edge when there's no room above (an element at the top of the page).
    const h = label!.offsetHeight || 16;
    const top = r.top - h - 4 >= 0 ? r.top - h - 4 : Math.max(0, r.top) + 2;
    const left = Math.min(Math.max(0, r.left), Math.max(0, innerWidth - label!.offsetWidth - 4));
    Object.assign(label!.style, { left: `${left}px`, top: `${top}px` });
  }

  function show(el: Element, morph = false) {
    if (!host) mount();
    const fresh = !host!.isConnected;
    if (fresh) document.documentElement.appendChild(host!);
    setMorph(morph && !fresh);
    target = el;
    const { tag, name } = describe(el);
    const r = el.getBoundingClientRect();
    label!.innerHTML = '';
    const tagEl = document.createElement('span');
    tagEl.className = 'tag';
    tagEl.textContent = tag;
    const sizeEl = document.createElement('span');
    sizeEl.className = 'size';
    // The \u00d7 escape (a times sign) keeps the source ASCII, so it reads right on a page that declares no charset.
    sizeEl.textContent = `${Math.round(r.width)} \u00d7 ${Math.round(r.height)}`;
    label!.append(tagEl, name, sizeEl);
    place();
  }

  function setPinned(on: boolean) {
    pinned = on;
    box?.classList.toggle('pinned', on);
  }

  function clear() {
    setPinned(false);
    target = null;
    host?.remove();
  }

  const inspectable = (el: EventTarget | null): el is Element => el instanceof Element && el !== document.documentElement && el !== document.body;

  function setHover(on: boolean) {
    hover = on;
    if (!on) clear();
  }

  // What Breeze needs to find the element in the page's source: its tag, id and which one of its tag it is in the page.
  function locate(el: Element) {
    const same = [...document.getElementsByTagName(el.localName)].filter(x => !x.matches('[data-breeze-inspector],[data-breeze-preview]'));
    return { tag: el.localName, id: el.id, classes: [...el.classList], text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80), index: same.indexOf(el) };
  }
  // The element and its ancestors up to <body>, innermost first: an element the page's script built (a text-splitting
  // animation's line divs) isn't in the source, so Breeze falls back to the nearest ancestor that is.
  function chain(el: Element) {
    const out: ReturnType<typeof locate>[] = [];
    for (let e: Element | null = el; e && e !== document.body && e !== document.documentElement && out.length < 12; e = e.parentElement) out.push(locate(e));
    return out;
  }

  // Breeze's menu lives outside the page, so a click in here never reaches it: the page tells Breeze to close it.
  // Each menu has a number, so the close of a menu a newer right click replaced doesn't unpin the newer one.
  let menuSeq = 0, menuOpen = 0;
  function dismissMenu() {
    menuOpen = 0;
    parent.postMessage({ breezeInspector: 'dismiss' }, '*');
    if (hover) setPinned(false);
  }

  // Edit Manually: the element's text becomes editable right in the page. Enter saves (Breeze writes the change into
  // the page's source), Escape or a structure change puts it back. Only text changes: pasted formatting is
  // kept out, and each changed text node is sent with its old text so Breeze can find it in the source.
  let edit: { el: HTMLElement; where: ReturnType<typeof chain>; nodes: Text[]; before: string[]; html: string; attr: string | null; style: string | null; leaf: boolean } | null = null;
  function textNodes(el: Element): Text[] {
    const out: Text[] = [], walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) out.push(walk.currentNode as Text);
    return out;
  }
  function startEdit(x: number, y: number) {
    if (edit || !(target instanceof HTMLElement)) return;
    const el = target, nodes = textNodes(el);
    edit = { el, where: chain(el), nodes, before: nodes.map(n => n.data), html: el.innerHTML, attr: el.getAttribute('contenteditable'), style: el.getAttribute('style'), leaf: !el.children.length };
    el.style.outline = 'none'; // the dashed outline stands in for the browser's focus ring
    setPinned(true);
    box!.classList.add('editing');
    const size = label!.querySelector('.size');
    if (size) size.textContent = 'Enter saves · Esc cancels';
    // Not plaintext-only: Chromium shows source line breaks and indents in that mode, so the text would jump.
    // Formatting is kept out by hand instead (paste, drop and formatting keys below).
    el.setAttribute('contenteditable', 'true');
    el.focus();
    // The caret goes where the right click was; if that isn't in the text, the whole text is selected.
    const at = document.caretRangeFromPoint(x, y), sel = getSelection()!;
    sel.removeAllRanges();
    if (at && el.contains(at.startContainer)) sel.addRange(at);
    else { const all = document.createRange(); all.selectNodeContents(el); sel.addRange(all); }
  }
  function endEdit(save: boolean) {
    const ed = edit;
    if (!ed) return;
    edit = null;
    if (ed.attr == null) ed.el.removeAttribute('contenteditable'); else ed.el.setAttribute('contenteditable', ed.attr);
    if (ed.style == null) ed.el.removeAttribute('style'); else ed.el.setAttribute('style', ed.style);
    box?.classList.remove('editing');
    getSelection()?.removeAllRanges();
    const nodes = textNodes(ed.el);
    const same = nodes.length === ed.nodes.length && nodes.every((n, i) => n === ed.nodes[i]);
    if (save && same) {
      const changes = nodes.map((n, i) => ({ from: ed.before[i], to: n.data })).filter(c => c.from !== c.to);
      if (changes.length) parent.postMessage({ breezeInspector: 'edit', chain: ed.where, changes }, '*');
    } else if (save && ed.leaf && !ed.el.children.length) {
      // Typing reshaped a text-only element's nodes: its whole old text becomes its whole new text.
      const from = ed.before.join(''), to = ed.el.textContent ?? '';
      if (from !== to) parent.postMessage({ breezeInspector: 'edit', chain: ed.where, changes: [{ from, to }] }, '*');
    } else {
      if (same) nodes.forEach((n, i) => { n.data = ed.before[i]; }); else ed.el.innerHTML = ed.html;
      if (save) parent.postMessage({ breezeInspector: 'edit-failed' }, '*');
    }
    if (target && target.isConnected) show(target);
    setPinned(false);
  }

  addEventListener('contextmenu', e => {
    e.preventDefault();
    if (edit && !edit.el.contains(e.target as Node)) endEdit(true);
    if (edit) return;
    if (!inspectable(e.target)) { clear(); if (menuOpen) dismissMenu(); return; }
    if (!hover) { show(e.target); return; }
    // In hover mode the outline holds on the element while Breeze shows its Edit Manually / Ask AI menu.
    if (e.target !== target) show(e.target, true);
    setPinned(true);
    menuOpen = ++menuSeq;
    parent.postMessage({ breezeInspector: 'menu', seq: menuOpen, x: e.clientX, y: e.clientY, el: locate(e.target), chain: chain(e.target) }, '*');
  }, true);
  // In hover mode clicks still go through to the page; they pin the outline rather than clear it.
  addEventListener('mousedown', e => {
    if (edit) { if (edit.el.contains(e.target as Node)) return; endEdit(true); }
    if (menuOpen && e.button !== 2) { dismissMenu(); return; } // this click only closes the menu
    if (e.button !== 0) return;
    if (!hover) { if (target) clear(); return; }
    if (!inspectable(e.target)) return;
    if (pinned && e.target === target) { setPinned(false); return; }
    if (e.target !== target) show(e.target, true);
    setPinned(true);
  }, true);
  // While editing, a click in the text places the caret but doesn't follow a link or run the page's handlers.
  addEventListener('click', e => {
    if (edit && edit.el.contains(e.target as Node)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  addEventListener('input', () => { if (edit) place(); }, true);
  addEventListener('paste', e => {
    if (!edit) return;
    e.preventDefault();
    e.stopPropagation();
    document.execCommand('insertText', false, (e.clipboardData?.getData('text/plain') ?? '').replace(/\s*\n\s*/g, ' '));
  }, true);
  addEventListener('drop', e => { if (edit) { e.preventDefault(); e.stopPropagation(); } }, true);
  addEventListener('keydown', e => {
    if (edit) {
      e.stopPropagation(); // the page's own shortcuts stay quiet while typing
      if (e.key === 'Enter') { e.preventDefault(); endEdit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); endEdit(false); }
      else if ((e.ctrlKey || e.metaKey) && /^[biu]$/i.test(e.key)) e.preventDefault(); // no bold, italic or underline
      return;
    }
    // Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) undo and redo Breeze's edits to the page, except in the page's own fields, which
    // keep their own undo. While editing text, Ctrl+Z is the browser's, undoing the typing (the branch above).
    const t = e.target as HTMLElement | null;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && /^[zy]$/i.test(e.key) && !(t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? ''))) {
      e.preventDefault();
      parent.postMessage({ breezeInspector: e.key.toLowerCase() === 'y' || e.shiftKey ? 'redo' : 'undo' }, '*');
      return;
    }
    if (e.key !== 'Escape') return;
    // Escape closes the menu, then leaves hover mode (Breeze is told so its mouse button turns off), then clears the
    // outline, and with nothing left to close tells Breeze, which leaves fullscreen.
    if (menuOpen) dismissMenu();
    else if (hover) { setHover(false); parent.postMessage({ breezeInspector: 'hover-off' }, '*'); }
    else if (target) clear();
    else parent.postMessage({ breezeInspector: 'escape' }, '*');
  }, true);
  addEventListener('mousemove', e => {
    if (!hover || pinned) return;
    if (!inspectable(e.target)) { clear(); return; }
    if (e.target !== target) show(e.target, true);
  }, true);
  // The cursor leaving the page (into Breeze around it) takes the hover outline with it.
  document.addEventListener('mouseout', e => { if (hover && !pinned && !e.relatedTarget) clear(); }, true);
  addEventListener('message', e => {
    if (e.source !== parent) return;
    const kind = e.data?.breezeInspector;
    if (kind === 'hover') { if (!e.data.on) endEdit(false); setHover(!!e.data.on); }
    else if (kind === 'menu-closed' && e.data.seq === menuOpen) { menuOpen = 0; if (hover && !edit) setPinned(false); } // the outline follows the cursor again
    else if (kind === 'edit' && typeof e.data.x === 'number' && typeof e.data.y === 'number') startEdit(e.data.x, e.data.y);
  });
  // Keeps the outline on the element as the page scrolls, resizes or animates.
  addEventListener('scroll', () => { if (target) { setMorph(false); place(); } }, true);
  addEventListener('resize', () => { if (target) { setMorph(false); place(); } });
}

const PREVIEW_INSPECTOR = `<script data-breeze-inspector>(${previewInspector.toString()})();</script>`;

export { previewInspector, PREVIEW_INSPECTOR };
