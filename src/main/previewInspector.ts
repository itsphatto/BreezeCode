// The preview's element inspector. Right-clicking an element in the preview outlines it in blue with its
// tag, id and classes on a label above it; a left click, Escape or right-clicking empty space clears it.
// Hover mode (the mouse button in the preview bar, which posts { breezeInspector: 'hover', on } to the page) does the
// same for whatever is under the cursor, the outline gliding from one element to the next as the cursor moves. A left click pins it where it is; a click on
// the pinned element lets it follow the cursor again, and a click on another element pins it there instead.
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
      .box{position:fixed;box-sizing:border-box;border:2px solid ${BLUE};background:rgba(10,108,216,.12);border-radius:2px}
      .label{position:fixed;max-width:calc(100vw - 8px);padding:2px 6px;border-radius:4px;background:${BLUE};color:#fff;
        font:600 11px/16px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .label .tag{opacity:.75;font-weight:500}
      .label .size{opacity:.75;font-weight:500;margin-left:6px}
      .morph{transition:left .16s ease-in,top .16s ease-in,width .16s ease-in,height .16s ease-in}
      .box.pinned{border-style:solid;background:rgba(10,108,216,.2)}
      @media (prefers-reduced-motion:reduce){.morph{transition:none}}
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
    const h = label!.offsetHeight || 20;
    const top = r.top - h - 2 >= 0 ? r.top - h - 2 : Math.max(0, r.top) + 2;
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

  addEventListener('contextmenu', e => {
    e.preventDefault();
    if (!inspectable(e.target)) { clear(); return; }
    show(e.target);
  }, true);
  // In hover mode clicks still go through to the page; they pin the outline rather than clear it.
  addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (!hover) { if (target) clear(); return; }
    if (!inspectable(e.target)) return;
    if (pinned && e.target === target) { setPinned(false); return; }
    if (e.target !== target) show(e.target, true);
    setPinned(true);
  }, true);
  addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    // Escape leaves hover mode too; Breeze is told so its mouse button turns off.
    if (hover) { setHover(false); parent.postMessage({ breezeInspector: 'hover-off' }, '*'); }
    else if (target) clear();
  }, true);
  addEventListener('mousemove', e => {
    if (!hover || pinned) return;
    if (!inspectable(e.target)) { clear(); return; }
    if (e.target !== target) show(e.target, true);
  }, true);
  // The cursor leaving the page (into Breeze around it) takes the hover outline with it.
  document.addEventListener('mouseout', e => { if (hover && !pinned && !e.relatedTarget) clear(); }, true);
  addEventListener('message', e => {
    if (e.source !== parent || e.data?.breezeInspector !== 'hover') return;
    setHover(!!e.data.on);
  });
  // Keeps the outline on the element as the page scrolls, resizes or animates.
  addEventListener('scroll', () => { if (target) { setMorph(false); place(); } }, true);
  addEventListener('resize', () => { if (target) { setMorph(false); place(); } });
}

const PREVIEW_INSPECTOR = `<script data-breeze-inspector>(${previewInspector.toString()})();</script>`;

export { previewInspector, PREVIEW_INSPECTOR };
