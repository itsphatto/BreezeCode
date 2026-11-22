/* ================= Skills view: what each agent can load, and a way to remove it ================= */
// Skills are folders with a SKILL.md, per agent (main/skills.js). A click shows one; the bin removes it (its folder
// goes to the Recycle Bin). A Claude Code plugin brings its own skills, which can't be removed one by one, so the
// plugin has an on/off switch instead (a plugin synced from the Claude account is left to the account).
const SKILL_AGENTS: [string, string][] = [['claude', 'Claude Code'], ['codex', 'Codex'], ['antigravity', 'Antigravity']];
const SKILL_TAGS: Record<string, [string, string]> = {
  synced: ['Synced', 'Synced from your Claude account'], builtin: ['Built-in', 'Comes with the agent'],
};
let skillData: SkillList | null = null;
const openPlugins = new Set<string>();

function skillRowHtml(s: AgentSkill): string {
  const tag = SKILL_TAGS[s.scope];
  const end = s.removable ? holdDelHtml(s.name, `data-skill-del="${escAttr(s.id)}"`)
    : tag ? `<span class="skill-tag" title="${escAttr(tag[1])}">${tag[0]}</span>` : '';
  // One shared list, so a skill shows the mark of every agent that has it (a plugin's are all Claude Code's).
  const mark = s.plugin ? '' : `<span class="skill-marks">${(s.agents ?? [s.agent]).map(a => brandMark('skill-mark', a, agentLabel(a)[0])).join('')}</span>`;
  return `<div class="skill-row" role="button" tabindex="0" data-skill="${escAttr(s.id)}" title="${escAttr(s.description || s.name)}">
    ${mark}<span class="skill-text"><b>${esc(s.name)}</b>${s.description ? `<small>${esc(s.description)}</small>` : ''}</span>${end}</div>`;
}

function pluginHtml(p: AgentPlugin): string {
  const open = openPlugins.has(p.id);
  const skills = p.skills.length ? p.skills.map(skillRowHtml).join('') : '<p class="side-note">No skills in this plugin.</p>';
  return `<div class="plugin-item${open ? ' open' : ''}${p.enabled ? '' : ' off'}">
    <div class="plugin-row">
      <button class="plugin-name" type="button" data-plugin-open="${escAttr(p.id)}" aria-expanded="${open}" title="${escAttr(p.description || p.id)}">
        ${svgIcon('chevronRight', 12)}<b>${esc(p.name)}</b><small>${esc(p.version ? 'v' + p.version : p.marketplace)}</small></button>
      ${p.synced
        ? '<span class="skill-tag" title="Synced from your Claude account, which turns it on and off">Synced</span>'
        : `<button class="switch switch-sm${p.enabled ? ' on' : ''}" type="button" role="switch" data-plugin="${escAttr(p.id)}" aria-checked="${p.enabled}" aria-label="${escAttr(p.name)} on"><span class="sw-knob"></span></button>`}
    </div>
    <div class="plugin-skills"><div>${skills}</div></div>
  </div>`;
}

// MCP servers: the ones connected here (Claude Code gets them on every run; the bin disconnects one) and the ones
// Claude Code has set up itself, shown with where they come from.
let mcpData: McpList | null = null;
const MCP_SCOPES: Record<string, string> = { user: 'Claude Code', local: 'This project', project: '.mcp.json' };
function mcpRowHtml(m: McpServer, mine: boolean, builtIn = false): string {
  const end = builtIn
    ? '<span class="skill-tag" title="Part of Breeze: every run gets it">Always on</span>'
    : mine
    ? holdDelHtml(m.name, `data-mcp-del="${escAttr(m.name)}"`)
    : `<span class="skill-tag" title="Set up in Claude Code itself">${esc(MCP_SCOPES[m.scope ?? 'user'] ?? 'Claude Code')}</span>`;
  return `<div class="skill-row mcp-row" title="${escAttr(m.detail)}">
    <span class="skill-text"><b>${esc(m.name)}</b><small>${esc(m.detail || (m.type === 'http' ? 'URL' : 'Command'))}</small></span>${end}</div>`;
}
/* ---- The pop-up: Skills / Plugins / MCP tabs, a search, and the list (opened from the chats side bars) ---- */
type ExtTab = 'skills' | 'plugins' | 'mcp';
const EXT_TABS: [ExtTab, string][] = [['skills', 'Skills'], ['plugins', 'Plugins'], ['mcp', 'MCP']];
let extTab: ExtTab = 'skills';
let extQuery = '';

document.body.insertAdjacentHTML('beforeend', `<div class="ext-scrim" id="extPop" hidden>
  <div class="ext-pop" role="dialog" aria-modal="true" aria-label="Skills, plugins and MCP servers">
    <div class="ext-head">
      <div class="ext-tabs" role="tablist">${EXT_TABS.map(([k, l]) => `<button class="ext-tab" type="button" role="tab" data-ext-tab="${k}">${l}</button>`).join('')}</div>
      <label class="ext-search">${svgIcon('search', 14)}<input id="extSearch" type="search" placeholder="Search" aria-label="Search" spellcheck="false" autocomplete="off"></label>
      <button class="btn btn-sm ext-add" id="extAdd" type="button" title="Connect MCP server">${svgIcon('plus', 14)}<span>Add</span></button>
      <button class="icon-btn ext-close" id="extClose" type="button" title="Close (Esc)" aria-label="Close">${svgIcon('x', 16)}</button>
    </div>
    <div class="ext-body" id="extBody"></div>
  </div>
</div>`);
const extPop = $('#extPop'), extBody = $('#extBody'), extSearch = $<HTMLInputElement>('#extSearch');
const extOpen = () => !extPop.hidden && !extPop.classList.contains('closing');
const EXT_LOADING = '<p class="side-note">Looking for skills…</p>';
let extShown = ''; // the list as last put in: a refresh that finds the same leaves it, and its rise-in, alone

// Add belongs to the MCP tab only. On a tab switch it pops in beside the search, which glides over to make room,
// and shrinks back out (pinned where it stood) as the search glides back. Transforms only; from wherever it is, so a
// quick switch back mid-way just turns it around.
const extAdd = $('#extAdd'), extSearchBox = $('.ext-search', extPop);
let extAddOut: Animation | null = null;
function setExtAdd(show: boolean, morph: boolean): void {
  if (show === (!extAdd.hidden && !extAddOut)) return;
  morph &&= !motionReduced();
  const x0 = extSearchBox.getBoundingClientRect().left;
  const cs = getComputedStyle(extAdd);
  const from = extAdd.hidden ? { opacity: 0, transform: 'scale(.5)', filter: 'blur(4px)' }
    : { opacity: cs.opacity, transform: cs.transform, filter: cs.filter };
  extAdd.getAnimations().forEach(a => a.cancel());
  extSearchBox.getAnimations().forEach(a => a.cancel());
  extAddOut = null;
  extAdd.style.position = extAdd.style.left = extAdd.style.top = '';
  if (show || !morph) extAdd.hidden = !show;
  else { // out of the row at once, so the search can take the room, but still drawn where it was while it goes
    const r = extAdd.getBoundingClientRect(), head = extAdd.parentElement!.getBoundingClientRect();
    Object.assign(extAdd.style, { position: 'absolute', left: `${r.left - head.left}px`, top: `${r.top - head.top}px` });
  }
  if (!morph) return;
  const opts = { duration: 420, easing: SPRING };
  const dx = x0 - extSearchBox.getBoundingClientRect().left;
  if (Math.abs(dx) > .5) extSearchBox.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], opts);
  if (show) { extAdd.animate([from, { opacity: 1, transform: 'none', filter: 'none' }], opts); return; }
  const out = extAddOut = extAdd.animate([from, { opacity: 0, transform: 'scale(.5)', filter: 'blur(4px)' }], { duration: 200, easing: 'ease-in' });
  out.onfinish = () => {
    if (extAddOut !== out) return;
    extAddOut = null;
    extAdd.hidden = true;
    extAdd.style.position = extAdd.style.left = extAdd.style.top = '';
  };
}

const extMatches = (...text: (string | undefined)[]) => !extQuery || text.some(t => t?.toLowerCase().includes(extQuery));
function extSection(title: string, count: number, rows: string, empty: string): string {
  return `<div class="ext-section"><span>${esc(title)}</span><span class="n">${count}</span></div>${rows || `<p class="side-note">${esc(extQuery ? 'Nothing matches your search.' : empty)}</p>`}`;
}

// rise: the rows come in one after another, as a dialog's parts do (opening, a new tab, the list first arriving).
function renderSkills(rise = false): void {
  if (extPop.hidden) return;
  $$<HTMLButtonElement>('[data-ext-tab]', extPop).forEach(b => {
    const on = b.dataset.extTab === extTab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  setExtAdd(extTab === 'mcp', false);
  let html: string;
  if (!skillData) html = EXT_LOADING;
  else if (extTab === 'skills') {
    const list = skillData.skills.filter(k => extMatches(k.name, k.description));
    html = extSection('Your skills', list.length, list.map(skillRowHtml).join(''), 'No skills yet.');
  } else if (extTab === 'plugins') {
    const list = skillData.plugins.filter(p => extMatches(p.name, p.description, ...p.skills.map(k => k.name)));
    html = extSection('Claude Code plugins', list.length, list.map(pluginHtml).join(''), 'No plugins installed.');
  } else {
    const own = (mcpData?.builtIn ?? []).filter(m => extMatches(m.name, m.detail));
    const mine = (mcpData?.breeze ?? []).filter(m => extMatches(m.name, m.detail));
    const theirs = (mcpData?.claude ?? []).filter(m => extMatches(m.name, m.detail));
    const rows = own.map(m => mcpRowHtml(m, false, true)).join('') + mine.map(m => mcpRowHtml(m, true)).join('') + theirs.map(m => mcpRowHtml(m, false)).join('');
    html = extSection('MCP servers', own.length + mine.length + theirs.length, rows, 'No MCP servers. Add one to give Claude Code its tools.');
  }
  if (html === extShown && !rise) return;
  rise ||= extShown === EXT_LOADING;
  extShown = html;
  extBody.innerHTML = html;
  if (rise) staggerIn(extBody.children);
  $$<HTMLElement>('[data-skill-del]', extBody).forEach(b => holdToDelete(b, () => { const k = allSkills().find(x => x.id === b.dataset.skillDel); if (k) void removeSkill(k); }));
  $$<HTMLElement>('[data-mcp-del]', extBody).forEach(b => holdToDelete(b, () => {
    const name = b.dataset.mcpDel as string;
    background(api.mcp.remove(name).then(() => { toast(`Disconnected ${name}`); return refreshSkills(); }));
  }));
}

async function refreshSkills(): Promise<void> {
  try {
    [skillData, mcpData] = await Promise.all([api.skills.list(), api.mcp.list().catch(() => ({ breeze: [], claude: [] }))]);
  } catch (e) { extShown = ''; extBody.innerHTML = `<p class="side-note">Couldn't read the skills: ${esc(errMsg(e))}</p>`; return; }
  setSlashSkills(skillData); // the prompts' "/" menu follows what's here
  renderSkills();
}

// The viewport point the pop-up grows out of and shrinks back into: where it was clicked open, else the middle.
let extFrom: [number, number] | null = null;
function aimExt(): void {
  const pop = $('.ext-pop', extPop);
  const [x, y] = extFrom ?? [innerWidth / 2, innerHeight / 2];
  pop.style.transformOrigin = `${x - pop.offsetLeft}px ${y - pop.offsetTop}px`;
}
function openExtensions(tab: ExtTab, from?: [number, number]): void {
  extTab = tab;
  if (!extOpen()) {
    extQuery = '';
    extSearch.value = '';
    extFrom = from ?? null;
    extPop.classList.remove('closing');
    extPop.hidden = false;
    aimExt();
    staggerIn($('.ext-head', extPop).children); // marked once; showing the pop-up again replays their rise
  }
  renderSkills(true);
  extSearch.focus();
  void refreshSkills();
}
function closeExtensions(): void {
  if (!extOpen()) return;
  aimExt(); // the window may have been resized since it opened
  extPop.classList.add('closing');
  // As a closing dialog (closeModal): gone once the shrink has run.
  setTimeout(() => { if (extPop.classList.contains('closing')) { extPop.hidden = true; extPop.classList.remove('closing'); } }, 380);
}
$$<HTMLElement>('[data-ext-open]').forEach(b => b.onclick = e => {
  const r = b.getBoundingClientRect(); // a keyboard click (detail 0) has no pointer: grow out of the button's middle
  openExtensions(b.dataset.extOpen as ExtTab, e.detail ? [e.clientX, e.clientY] : [r.left + r.width / 2, r.top + r.height / 2]);
});
// The highlight glides from the old tab to the new one, and the new list rises in.
$$<HTMLButtonElement>('[data-ext-tab]', extPop).forEach(b => b.onclick = () => {
  if (b.dataset.extTab === extTab) return;
  const from = extPop.querySelector('.ext-tab.on')?.getBoundingClientRect();
  extTab = b.dataset.extTab as ExtTab;
  setExtAdd(extTab === 'mcp', true);
  renderSkills(true);
  slideSelected(b, from);
});
extSearch.oninput = () => { extQuery = extSearch.value.trim().toLowerCase(); renderSkills(); };
$('#extClose').onclick = closeExtensions;
$('#extAdd').onclick = () => connectMcp();
extPop.addEventListener('mousedown', e => { if (e.target === extPop) closeExtensions(); });
// Capture, so a dialog opened over the pop-up (a skill, Connect MCP) takes Esc first and the pop-up stays.
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !extOpen() || $$('#modalRoot .scrim:not(.closing)').length) return;
  e.preventDefault();
  e.stopPropagation();
  closeExtensions();
}, true);
commands['skills.open'] = () => openExtensions('skills');

// Connect an MCP server: a command Breeze starts (with optional env vars) or a URL (with optional headers).
function connectMcp(): void {
  openModal(`<h3>Connect MCP server</h3>
    <p class="sub">Claude Code gets it on every run from Breeze, and can use its tools when building.</p>
    <form class="mcp-form" id="mcpForm" autocomplete="off">
      <label>Name<input class="input" name="name" placeholder="github" spellcheck="false" required></label>
      <div class="seg mcp-type" role="radiogroup" aria-label="Type">
        <button type="button" class="on" data-mcp-type="stdio" role="radio" aria-checked="true">Command</button>
        <button type="button" data-mcp-type="http" role="radio" aria-checked="false">URL</button>
      </div>
      <div data-mcp-for="stdio">
        <label>Command<input class="input" name="command" placeholder="npx -y @modelcontextprotocol/server-github" spellcheck="false"></label>
        <label>Environment variables <small>one per line, optional</small><textarea class="input" name="env" rows="1" placeholder="GITHUB_TOKEN=…" spellcheck="false"></textarea></label>
      </div>
      <div data-mcp-for="http" hidden>
        <label>URL<input class="input" name="url" placeholder="https://example.com/mcp" spellcheck="false"></label>
        <label>Headers <small>one per line, optional</small><textarea class="input" name="headers" rows="1" placeholder="Authorization: Bearer …" spellcheck="false"></textarea></label>
      </div>
      <p class="mcp-error" id="mcpError" role="alert"></p>
      <div class="row end"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">Connect</button></div>
    </form>`, m => {
    const form = $<HTMLFormElement>('#mcpForm', m);
    let type: 'stdio' | 'http' = 'stdio';
    $$<HTMLButtonElement>('[data-mcp-type]', m).forEach(b => b.onclick = () => {
      type = b.dataset.mcpType === 'http' ? 'http' : 'stdio';
      $$<HTMLButtonElement>('[data-mcp-type]', m).forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
      $$<HTMLElement>('[data-mcp-for]', m).forEach(x => { x.hidden = x.dataset.mcpFor !== type; });
      form.classList.add('switched'); // fields slide in only on a switch, not when the dialog opens
    });
    form.onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(form);
      const val = (k: string) => String(f.get(k) ?? '');
      try {
        const s = await api.mcp.add({ name: val('name').trim(), type, command: val('command'), env: val('env'), url: val('url'), headers: val('headers') });
        closeModal();
        toast(`Connected ${s.name}. Claude Code gets it from the next run.`);
        await refreshSkills();
      } catch (err) { $('#mcpError', m).textContent = errMsg(err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
    };
    $<HTMLInputElement>('[name="name"]', m).focus();
  });
}
commands['mcp.connect'] = connectMcp;

const allSkills = (): AgentSkill[] => [...skillData?.skills ?? [], ...(skillData?.plugins ?? []).flatMap(p => p.skills)];
const agentLabel = (id: string) => SKILL_AGENTS.find(([a]) => a === id)?.[1] ?? id;
const skillAgentName = (s: AgentSkill) => agentLabel(s.agent);

async function viewSkill(s: AgentSkill): Promise<void> {
  let text = '';
  try { text = await api.skills.read(s.file); } catch (e) { toast(`Couldn't open ${s.name}: ${errMsg(e)}`); return; }
  const body = text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const where = s.plugin ? `Plugin ${s.plugin}` : `${skillAgentName(s)} · ${SKILL_TAGS[s.scope]?.[0].toLowerCase() ?? 'your skills'}`;
  const del = s.removable ? holdDelHtml(s.name, 'id="skillViewDel"') : '';
  openModal(`<h3>${esc(s.name)}</h3>
    <p class="sub">${esc(where)}</p>
    ${s.description ? `<p class="skill-view-desc">${esc(s.description)}</p>` : ''}
    <pre class="skill-view-body">${esc(body.trim())}</pre>
    <p class="skill-view-path" title="${escAttr(s.file)}">${esc(s.file)}</p>
    <div class="row end"><button class="btn" data-close>Close</button>${del}</div>`, m => {
    m.classList.add('skill-view');
    const del = m.querySelector<HTMLElement>('#skillViewDel');
    if (del) holdToDelete(del, () => { closeModal(); void removeSkill(s); });
  });
}

// Held for 5 seconds: its folder goes to the Recycle Bin, where it can be restored.
async function removeSkill(s: AgentSkill): Promise<void> {
  try {
    await api.skills.remove(s.id);
    toast(`Removed ${s.name}. Restore it from the Recycle Bin to get it back.`);
  } catch (e) { toast(`Couldn't remove ${s.name}: ${errMsg(e)}`); }
  await refreshSkills();
}

extBody.addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const find = (id?: string) => allSkills().find(s => s.id === id);
  const sw = t.closest<HTMLButtonElement>('[data-plugin]');
  if (sw) {
    const id = sw.dataset.plugin as string;
    const on = sw.getAttribute('aria-checked') !== 'true';
    const p = skillData?.plugins.find(x => x.id === id);
    // Flip it in place so the knob slides; a re-render would swap in a switch already at the end.
    const show = (v: boolean) => {
      if (p) p.enabled = v;
      sw.classList.toggle('on', v);
      sw.setAttribute('aria-checked', String(v));
      sw.closest('.plugin-item')?.classList.toggle('off', !v);
    };
    show(on);
    background(api.skills.setPlugin(id, on).then(v => {
      show(v);
      if (skillData) setSlashSkills(skillData);
      toast(v ? `${p?.name ?? id} is on` : `${p?.name ?? id} is off: Claude Code won't load its skills in new chats`);
    }).catch(err => { show(!on); toast(`Couldn't change ${id}: ${errMsg(err)}`); }));
    return;
  }
  // Plugins fold in place, so the body and chevron animate.
  const plug = t.closest<HTMLElement>('[data-plugin-open]');
  if (plug) {
    const id = plug.dataset.pluginOpen as string;
    const open = !openPlugins.has(id);
    if (open) openPlugins.add(id); else openPlugins.delete(id);
    plug.closest('.plugin-item')?.classList.toggle('open', open);
    plug.setAttribute('aria-expanded', String(open));
    return;
  }
  const row = t.closest<HTMLElement>('[data-skill]');
  const s = row && find(row.dataset.skill);
  if (s) void viewSkill(s);
});
extBody.addEventListener('keydown', e => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.skill-row');
  if (!row || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  row.click();
});
commands['skills.refresh'] = () => void refreshSkills();

