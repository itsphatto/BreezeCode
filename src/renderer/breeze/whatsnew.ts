/* ================= What's new ================= */
// After an update, the first launch on the new version shows that version's release notes once. The notes are the
// GitHub release's own (main fetches them: update:notes). A first install shows nothing: there's nothing "new" yet.
// The version last shown is kept in NOTES_SEEN_KEY; it only moves on once the notes were shown (or there were none to
// fetch for a reason that won't change), so an offline launch tries again next time.
const NOTES_SEEN_KEY = 'breeze.notesSeen';
interface ReleaseNotes { version: string; name: string; html: string; url: string; }
const notesApi = (): { notes?(): Promise<ReleaseNotes | null> } => api.update as unknown as { notes?(): Promise<ReleaseNotes | null> };

// "0.7.10" > "0.7.9"; pre-release tags are ignored.
function newerVersion(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map(n => parseInt(n, 10) || 0), pb = b.split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

// The release body is Markdown with GitHub's HTML passed through; only plain formatting is kept. Pictures are left
// out (the window's CSP doesn't load them), and links open in the browser.
const NOTES_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'UL', 'OL', 'LI', 'STRONG', 'B', 'EM', 'I', 'DEL', 'CODE', 'PRE', 'BLOCKQUOTE', 'BR', 'HR', 'A']);
function cleanNotes(html: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const out = document.createDocumentFragment();
  const copy = (from: Node, to: Node): void => {
    for (const n of [...from.childNodes]) {
      if (n.nodeType === Node.TEXT_NODE) { to.appendChild(document.createTextNode(n.textContent ?? '')); continue; }
      if (n.nodeType !== Node.ELEMENT_NODE) continue; // comments
      const src = n as Element, tag = src.tagName.toUpperCase();
      if (/^(SCRIPT|STYLE|TEMPLATE|IMG|IFRAME|OBJECT|EMBED|SVG|VIDEO|AUDIO|PICTURE|SOURCE)$/.test(tag)) continue;
      if (!NOTES_TAGS.has(tag)) { copy(src, to); continue; } // unknown wrappers (div, details…) keep their text
      const el = document.createElement(tag.toLowerCase());
      const href = src.getAttribute('href');
      if (tag === 'A' && href && /^https:\/\//i.test(href)) { el.dataset.href = href; el.setAttribute('href', '#'); el.title = href; }
      copy(src, el);
      to.appendChild(el);
    }
  };
  copy(doc.body, out);
  // Paragraphs left empty by a dropped picture.
  out.querySelectorAll('p').forEach(p => { if (!p.textContent?.trim()) p.remove(); });
  return out;
}

function showReleaseNotes(n: ReleaseNotes): void {
  openModal(`<h3>What's new in Breeze Code ${esc(n.version)}</h3>
    <p class="sub">You're up to date. Here's what changed in this release.</p>
    <div class="whatsnew-body"></div>
    <div class="row end">${n.url ? '<button class="btn" id="whatsNewMore">View on GitHub</button>' : ''}<button class="btn btn-primary" data-close>Got it</button></div>`, m => {
    m.classList.add('whatsnew');
    const body = $('.whatsnew-body', m);
    body.append(cleanNotes(n.html));
    // The release's own title ("Breeze Code 0.7.2") repeats the dialog's.
    const first = body.firstElementChild;
    if (first && /^H[1-3]$/.test(first.tagName) && first.textContent?.includes(n.version)) first.remove();
    body.addEventListener('click', e => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('a[data-href]');
      if (!a) return;
      e.preventDefault();
      background(api.sys.openExternal(a.dataset.href!));
    });
    m.querySelector<HTMLElement>('#whatsNewMore')?.addEventListener('click', () => background(api.sys.openExternal(n.url)));
  });
}

// Called once start-up has settled and the window is showing.
async function maybeShowWhatsNew(): Promise<void> {
  const current = api.version;
  if (!current) return;
  const seen = store.get<string>(NOTES_SEEN_KEY, '');
  // First run: a fresh install (setup not done yet) starts here. Someone who had Breeze before this key existed has
  // finished setup, so they get this version's notes.
  if (!seen && !appState.onboarded) { store.set(NOTES_SEEN_KEY, current); return; }
  if (seen && !newerVersion(current, seen)) { if (seen !== current) store.set(NOTES_SEEN_KEY, current); return; }
  if (!appState.onboarded) return; // mid-setup: wait for a launch on Home or the editor
  const notes = await notesApi().notes?.().catch(() => null);
  if (!notes || notes.version !== current) return; // offline, or no notes yet: try again next launch
  if (topScrim()) return; // something else is asking first; next launch
  store.set(NOTES_SEEN_KEY, current);
  showReleaseNotes(notes);
}
