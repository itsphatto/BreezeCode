/* ================= An Agent Board box's browser ================= */
// The board box's preview panel works as a small browser. It has tabs, back/forward/reload and an address bar.
// A tab shows one of three things:
// - 'page': one of the project's pages, in the box's PreviewView iframe, so inspect and in-page edits still work.
// - 'web': a website, in its own <webview>. main.ts locks these down in will-attach-webview.
// - 'new': the new-tab page, with a search bar and the project's .html files listed in the middle.

type BrowserKind = 'new' | 'page' | 'web';
type BrowserEntry = { kind: BrowserKind; target: string }; // target: the page's path, the site's URL, '' for new
// The parts of Electron's <webview> element that this file uses. The renderer has no Electron types.
interface WebviewEl extends HTMLElement {
  src: string;
  canGoBack(): boolean; canGoForward(): boolean;
  goBack(): void; goForward(): void; reload(): void; stop(): void;
  getURL(): string; loadURL(url: string): Promise<void>;
}
interface BrowserTab {
  id: number;
  hist: BrowserEntry[];  // where the tab has been, by address bar, list or link; a site's own links stay in its webview
  at: number;
  title: string;
  web?: WebviewEl;       // made when the tab first opens a site
  el: HTMLElement;       // its button in the tab strip
}

const PAGE_FILE = /\.html?$/i;
// Text typed into the address bar that reads as an address rather than words to search for.
function browserUrlOf(text: string): string | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(t) && !PAGE_FILE.test(t)) return `https://${t}`;
  return null;
}

let browserTabSeq = 0;

class BoxBrowser {
  readonly preview: PreviewView;
  private tabs: BrowserTab[] = [];
  private active: BrowserTab | null = null;
  private pages: string[] = [];
  private strip: HTMLElement;
  private addr: HTMLInputElement;
  private stage: HTMLElement;
  private pageBox: HTMLElement;
  private home: HTMLElement;
  private homeSearch: HTMLInputElement;
  private homeList: HTMLElement;

  constructor(readonly root: HTMLElement, host: PreviewHost) {
    root.innerHTML = `
      <div class="bb-tabs" role="tablist" aria-label="Browser tabs">
        <div class="bb-strip"></div>
        <button class="icon-btn bb-newtab" type="button" title="New tab" aria-label="New tab">${svgIcon('plus', 14)}</button>
      </div>
      <div class="board-side-bar bb-nav">
        <button class="icon-btn bb-back" type="button" title="Back" aria-label="Back">${svgIcon('chevronLeft', 15)}</button>
        <button class="icon-btn bb-fwd" type="button" title="Forward" aria-label="Forward">${svgIcon('chevronRight', 15)}</button>
        <button class="icon-btn bb-reload" type="button" title="Reload" aria-label="Reload">${svgIcon('rotateCw', 13)}</button>
        <input class="bb-addr" type="text" spellcheck="false" autocomplete="off" placeholder="Search pages or type a URL" aria-label="Address">
        <button class="icon-btn toggle bp-inspect" type="button" title="Inspect on Hover" aria-pressed="false">${svgIcon('mouse', 14)}</button>
        <button class="icon-btn bb-external" type="button" title="Open in your browser" aria-label="Open in your browser">${svgIcon('external', 13)}</button>
        <button class="icon-btn toggle bp-full" type="button" title="Fullscreen" aria-pressed="false">${svgIcon('maximize', 13)}</button>
      </div>
      <div class="bb-stage">
        <div class="bb-page hidden">
          <iframe class="preview-frame hidden" title="Preview"></iframe>
          <div class="empty bp-empty hidden"><div class="bp-hint"></div></div>
        </div>
        <div class="bb-home hidden">
          <div class="bb-home-inner">
            ${svgIcon('globe', 28)}
            <h4>Open a page</h4>
            <label class="bb-search">${svgIcon('search', 14)}<input type="text" spellcheck="false" autocomplete="off" placeholder="Search pages or type a URL" aria-label="Search pages or type a URL"></label>
            <ul class="bb-list" role="listbox" aria-label="Pages in this project"></ul>
          </div>
        </div>
      </div>`;
    this.strip = $('.bb-strip', root);
    this.addr = $<HTMLInputElement>('.bb-addr', root);
    this.stage = $('.bb-stage', root);
    this.pageBox = $('.bb-page', root);
    this.home = $('.bb-home', root);
    this.homeSearch = $<HTMLInputElement>('.bb-search input', root);
    this.homeList = $('.bb-list', root);
    // PreviewView keeps the page's address in its own bar. This browser shows it in its address bar instead.
    const urlStub = document.createElement('span');
    this.preview = new PreviewView({
      root,
      frame: $<HTMLIFrameElement>('.preview-frame', root),
      url: urlStub,
      urlText: document.createElement('span'),
      inspect: $<HTMLButtonElement>('.bp-inspect', root),
      full: $<HTMLButtonElement>('.bp-full', root),
      empty: $('.bp-empty', root),
      hint: $('.bp-hint', root),
    }, host);

    $('.bb-newtab', root).onclick = () => { this.newTab(); this.homeSearch.focus(); };
    $('.bb-back', root).onclick = () => this.step(-1);
    $('.bb-fwd', root).onclick = () => this.step(1);
    $('.bb-reload', root).onclick = () => this.reload();
    $('.bb-external', root).onclick = () => { const e = this.entry(); if (e?.kind === 'web') void api.sys.openExternal(this.active?.web?.getURL() || e.target).catch(() => {}); };
    this.addr.onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); this.go(this.addr.value); this.addr.blur(); }
      else if (e.key === 'Escape') { this.paintAddr(); this.addr.blur(); }
    };
    this.addr.onfocus = () => this.addr.select();
    this.homeSearch.oninput = () => this.paintList();
    this.homeSearch.onkeydown = e => {
      const items = [...this.homeList.querySelectorAll<HTMLElement>('.bb-item')];
      const cur = items.findIndex(i => i.classList.contains('sel'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!items.length) return;
        const next = (cur + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach((it, i) => it.classList.toggle('sel', i === next));
        items[next].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const pick = items[cur]?.dataset.path;
        if (pick && !browserUrlOf(this.homeSearch.value)) this.open({ kind: 'page', target: pick });
        else this.go(this.homeSearch.value);
      }
    };
    this.homeList.onclick = e => {
      const path = (e.target as HTMLElement).closest<HTMLElement>('.bb-item')?.dataset.path;
      if (path) this.open({ kind: 'page', target: path });
    };
  }

  /* ----- Tabs ----- */
  newTab(first?: BrowserEntry): BrowserTab {
    const el = document.createElement('div');
    el.className = 'bb-tab';
    el.setAttribute('role', 'tab');
    el.innerHTML = `<span class="bb-tab-ico"></span><span class="bb-tab-title"></span><button class="icon-btn bb-tab-x" type="button" title="Close tab" aria-label="Close tab">${svgIcon('x', 12)}</button>`;
    const tab: BrowserTab = { id: ++browserTabSeq, hist: [first ?? { kind: 'new', target: '' }], at: 0, title: '', el };
    el.onmousedown = e => { if (e.button === 1) { e.preventDefault(); this.closeTab(tab); } };
    el.onclick = e => {
      if ((e.target as HTMLElement).closest('.bb-tab-x')) this.closeTab(tab);
      else this.select(tab);
    };
    this.tabs.push(tab);
    this.strip.append(el);
    this.select(tab);
    return tab;
  }
  private closeTab(tab: BrowserTab): void {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    tab.web?.remove();
    tab.el.remove();
    this.tabs.splice(i, 1);
    if (!this.tabs.length) { this.newTab(); return; }
    if (this.active === tab) this.select(this.tabs[Math.min(i, this.tabs.length - 1)]);
  }
  private select(tab: BrowserTab): void {
    this.active = tab;
    for (const t of this.tabs) { t.el.classList.toggle('active', t === tab); t.el.setAttribute('aria-selected', String(t === tab)); }
    tab.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.show();
  }
  private entry(tab = this.active): BrowserEntry | null { return tab ? tab.hist[tab.at] ?? null : null; }

  /* ----- Going places ----- */
  // What the address bar or the new-tab search was given: a project page, a site, or words to search the web for.
  go(text: string): void {
    const t = text.trim();
    if (!t) return;
    const rel = t.replaceAll('\\', '/').replace(/^\.?\//, '');
    const page = this.pages.find(p => p === rel) ?? this.pages.find(p => p.toLowerCase() === rel.toLowerCase());
    if (page) { this.open({ kind: 'page', target: page }); return; }
    const url = browserUrlOf(t);
    if (url) { this.open({ kind: 'web', target: url }); return; }
    if (PAGE_FILE.test(rel)) { toast(`No page named ${rel} in this project`); return; }
    this.open({ kind: 'web', target: `https://www.google.com/search?q=${encodeURIComponent(t)}` });
  }
  // Opens `e` in the active tab. Anything after the tab's current place in its history is dropped, as in a browser.
  open(e: BrowserEntry): void {
    const tab = this.active ?? this.newTab();
    tab.hist.splice(tab.at + 1, Infinity, e);
    tab.at = tab.hist.length - 1;
    if (e.kind === 'web') this.webOf(tab).src = e.target;
    this.show();
  }
  private step(dir: -1 | 1): void {
    const tab = this.active, e = this.entry();
    if (!tab || !e) return;
    // A site steps through its own history first; the tab's history takes over at the site's first or last page.
    if (e.kind === 'web' && tab.web) {
      if (dir < 0 && tab.web.canGoBack()) { tab.web.goBack(); return; }
      if (dir > 0 && tab.web.canGoForward()) { tab.web.goForward(); return; }
    }
    const at = tab.at + dir;
    if (at < 0 || at >= tab.hist.length) return;
    tab.at = at;
    const next = tab.hist[at];
    if (next.kind === 'web') { const w = this.webOf(tab); if (w.getAttribute('src') !== next.target) w.src = next.target; }
    this.show();
  }
  private reload(): void {
    const e = this.entry();
    if (e?.kind === 'web') this.active?.web?.reload();
    else if (e?.kind === 'page') void (this.preview.running ? this.preview.reload() : this.preview.start(e.target));
    else void this.loadPages();
  }

  /* ----- Showing the active tab ----- */
  private show(): void {
    const tab = this.active, e = this.entry();
    if (!tab || !e) return;
    for (const t of this.tabs) t.web?.classList.toggle('hidden', !(t === tab && e.kind === 'web'));
    this.pageBox.classList.toggle('hidden', e.kind !== 'page');
    this.home.classList.toggle('hidden', e.kind !== 'new');
    if (e.kind === 'page' && (!this.preview.running || this.preview.path !== e.target)) void this.preview.start(e.target);
    if (e.kind !== 'page' && this.preview.inspecting) this.preview.setInspect(false);
    $('.bp-inspect', this.root).classList.toggle('hidden', e.kind !== 'page');
    $('.bb-external', this.root).classList.toggle('hidden', e.kind !== 'web');
    if (e.kind === 'new') { this.homeSearch.value = ''; void this.loadPages(); }
    if (e.kind === 'page') tab.title = baseName(e.target);
    else if (e.kind === 'new') tab.title = 'New tab';
    else if (!tab.title || tab.title === 'New tab' || PAGE_FILE.test(tab.title)) tab.title = this.hostOf(e.target);
    this.paintTab(tab);
    this.paintNav();
    this.paintAddr();
  }
  private paintTab(tab: BrowserTab): void {
    const e = this.entry(tab);
    $('.bb-tab-ico', tab.el).innerHTML = svgIcon(e?.kind === 'page' ? 'file' : 'globe', 13);
    $('.bb-tab-title', tab.el).textContent = tab.title;
    tab.el.title = tab.title;
  }
  private paintNav(): void {
    const tab = this.active, e = this.entry();
    const webBack = e?.kind === 'web' && !!tab?.web && this.safe(() => tab.web!.canGoBack());
    const webFwd = e?.kind === 'web' && !!tab?.web && this.safe(() => tab.web!.canGoForward());
    $<HTMLButtonElement>('.bb-back', this.root).disabled = !(webBack || (tab && tab.at > 0));
    $<HTMLButtonElement>('.bb-fwd', this.root).disabled = !(webFwd || (tab && tab.at < tab.hist.length - 1));
  }
  private paintAddr(): void {
    if (document.activeElement === this.addr) return;
    const e = this.entry();
    this.addr.value = !e || e.kind === 'new' ? '' : e.kind === 'page' ? e.target : (this.active?.web && this.safe(() => this.active!.web!.getURL(), '')) || e.target;
  }
  // canGoBack and friends throw before the webview has attached; until then the answer is "no".
  private safe<T>(f: () => T, fallback?: T): T { try { return f(); } catch { return fallback as T; } }
  private hostOf(url: string): string { try { return new URL(url).host || url; } catch { return url; } }

  // The webview a tab shows sites in. It is made the first time the tab opens one.
  private webOf(tab: BrowserTab): WebviewEl {
    if (tab.web) return tab.web;
    const w = document.createElement('webview') as WebviewEl;
    w.className = 'bb-web hidden';
    w.setAttribute('partition', 'persist:breeze-browser');
    w.setAttribute('allowpopups', '');
    const sync = () => { if (this.active === tab) { this.paintNav(); this.paintAddr(); } };
    w.addEventListener('page-title-updated', ev => {
      const title = (ev as Event & { title?: string }).title;
      if (title && this.entry(tab)?.kind === 'web') { tab.title = title; this.paintTab(tab); }
    });
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'did-stop-loading', 'dom-ready']) w.addEventListener(ev, sync);
    w.addEventListener('did-start-loading', () => this.active === tab && $('.bb-reload', this.root).classList.add('spin'));
    w.addEventListener('did-stop-loading', () => this.active === tab && $('.bb-reload', this.root).classList.remove('spin'));
    tab.web = w;
    this.stage.append(w);
    return w;
  }

  /* ----- The new-tab page ----- */
  private async loadPages(): Promise<void> {
    this.pages = rootInfo ? (await api.fs.listFiles().catch(() => [] as string[])).filter(p => PAGE_FILE.test(p)) : [];
    const rank = (p: string) => (/(^|\/)index\.html?$/i.test(p) ? 0 : 1000) + p.split('/').length;
    this.pages.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    this.paintList();
  }
  private paintList(): void {
    const q = this.homeSearch.value.trim().toLowerCase();
    const shown = this.pages.filter(p => !q || p.toLowerCase().includes(q));
    if (!rootInfo) { this.homeList.innerHTML = '<li class="bb-none">Open a folder to list its pages</li>'; return; }
    if (!shown.length) {
      this.homeList.innerHTML = `<li class="bb-none">${this.pages.length ? `No pages match. Press Enter to ${browserUrlOf(q) ? 'open the site' : 'search the web'}.` : 'No .html files in this project yet'}</li>`;
      return;
    }
    this.homeList.innerHTML = shown.map((p, i) => {
      const slash = p.lastIndexOf('/');
      const dir = slash > 0 ? `<span class="bb-item-dir">${esc(p.slice(0, slash))}</span>` : '';
      return `<li class="bb-item${i === 0 && q ? ' sel' : ''}" role="option" data-path="${escAttr(p)}">${svgIcon('file', 14)}<span class="bb-item-name">${esc(p.slice(slash + 1))}</span>${dir}</li>`;
    }).join('');
  }

  /* ----- From the board ----- */
  // The first open: a tab on the box's page (index.html by default), or the new-tab page with no page to show.
  async begin(target: Promise<string | null> | string | null): Promise<void> {
    await this.loadPages();
    const page = await target;
    this.newTab(page ? { kind: 'page', target: page } : undefined);
  }
  changed(paths: string[]): void {
    this.preview.changed(paths);
    if (paths.some(p => PAGE_FILE.test(p)) && this.entry()?.kind === 'new') void this.loadPages();
  }
  dispose(): void {
    this.preview.dispose();
    for (const t of this.tabs) t.web?.remove();
  }
}

