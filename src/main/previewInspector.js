// The preview's element inspector. Right-clicking an element in the preview outlines it in blue with its
// tag, id and classes on a label above it; a left click, Escape or right-clicking empty space clears it.
// The preview frame is sandboxed (an opaque origin), so Breeze can't reach into it: this runs inside the page,
// injected by main.js's servePreview as an inline <script>. It draws in a closed shadow root so the page's CSS
// can't restyle it, and the overlay never takes pointer events, so the page underneath still works.
function previewInspector() {
  if (window.__breezeInspector) return;
  window.__breezeInspector = true;

  const BLUE = '#0a6cd8';
  let host = null, box = null, label = null, target = null;

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
    </style><div class="box"></div><div class="label"></div>`;
    box = shadow.querySelector('.box');
    label = shadow.querySelector('.label');
  }

  // "div#hero.card.wide": the id and classes are what the label is for, the tag says what they sit on.
  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const classes = [...el.classList].map(c => `.${c}`).join('');
    return { tag, name: id + classes };
  }

  function place() {
    if (!target || !target.isConnected) { clear(); return; }
    const r = target.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    // Above the element, or just inside its top edge when there's no room above (an element at the top of the page).
    const h = label.offsetHeight || 20;
    const top = r.top - h - 2 >= 0 ? r.top - h - 2 : Math.max(0, r.top) + 2;
    const left = Math.min(Math.max(0, r.left), Math.max(0, innerWidth - label.offsetWidth - 4));
    Object.assign(label.style, { left: `${left}px`, top: `${top}px` });
  }

  function show(el) {
    if (!host) mount();
    if (!host.isConnected) document.documentElement.appendChild(host);
    target = el;
    const { tag, name } = describe(el);
    const r = el.getBoundingClientRect();
    label.innerHTML = '';
    const tagEl = document.createElement('span');
    tagEl.className = 'tag';
    tagEl.textContent = tag;
    const sizeEl = document.createElement('span');
    sizeEl.className = 'size';
    // The \u00d7 escape (a times sign) keeps the source ASCII, so it reads right on a page that declares no charset.
    sizeEl.textContent = `${Math.round(r.width)} \u00d7 ${Math.round(r.height)}`;
    label.append(tagEl, name, sizeEl);
    place();
  }

  function clear() {
    target = null;
    host?.remove();
  }

  addEventListener('contextmenu', e => {
    const el = e.target instanceof Element ? e.target : null;
    e.preventDefault();
    if (!el || el === document.documentElement || el === document.body) { clear(); return; }
    show(el);
  }, true);
  addEventListener('mousedown', e => { if (e.button === 0 && target) clear(); }, true);
  addEventListener('keydown', e => { if (e.key === 'Escape' && target) clear(); }, true);
  // Keeps the outline on the element as the page scrolls, resizes or animates.
  addEventListener('scroll', () => target && place(), true);
  addEventListener('resize', () => target && place());
}

const PREVIEW_INSPECTOR = `<script data-breeze-inspector>(${previewInspector.toString()})();</script>`;

module.exports = { previewInspector, PREVIEW_INSPECTOR };
