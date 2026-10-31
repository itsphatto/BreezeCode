/* ================= Skills view: what each agent can load, and a way to remove it ================= */
// Skills are folders with a SKILL.md, per agent (main/skills.js). A click shows one; the bin removes it (its folder
// goes to the Recycle Bin). A Claude Code plugin brings its own skills, which can't be removed one by one, so the
// plugin has an on/off switch instead (a plugin synced from the Claude account is left to the account).
const SKILL_AGENTS: [string, string][] = [['claude', 'Claude Code'], ['codex', 'Codex']];
let skillData: SkillList | null = null;
const openPlugins = new Set<string>();
// Groups ("claude:user", "claude:plugins", …) start open; these are the ones folded shut.
const foldedSkillGroups = new Set<string>();

// A drop-down group: open by default, folds on a click. An empty one stays shut and can't be opened.
function skillGroupHtml(key: string, title: string, count: number, rows: string): string {
  const open = count > 0 && !foldedSkillGroups.has(key);
  return `<div class="skill-group${open ? ' open' : ''}${count ? '' : ' no-items'}">
    <button class="skill-group-head" type="button" data-skill-group="${escAttr(key)}" aria-expanded="${open}"${count ? '' : ' disabled'}>
      ${svgIcon('chevronRight', 12)}<span>${esc(title)}</span><span class="n">${count}</span></button>
    <div class="skill-group-body">${rows}</div>
  </div>`;
}

function skillRowHtml(s: AgentSkill): string {
  const bin = s.removable
    ? `<button class="icon-btn skill-del" type="button" data-skill-del="${escAttr(s.id)}" title="Remove skill" aria-label="Remove ${escAttr(s.name)}">${svgIcon('trash', 13)}</button>`
    : '';
  return `<div class="skill-row" role="button" tabindex="0" data-skill="${escAttr(s.id)}" title="${escAttr(s.description || s.name)}">
    <span class="skill-text"><b>${esc(s.name)}</b>${s.description ? `<small>${esc(s.description)}</small>` : ''}</span>${bin}</div>`;
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
    <div class="plugin-skills">${skills}</div>
  </div>`;
}

// MCP servers: the ones connected here (Claude Code gets them on every run; the bin disconnects one) and the ones
// Claude Code has set up itself, shown with where they come from.
let mcpData: McpList | null = null;
const MCP_SCOPES: Record<string, string> = { user: 'Claude Code', local: 'This project', project: '.mcp.json' };
function mcpRowHtml(m: McpServer, mine: boolean): string {
  const end = mine
    ? `<button class="icon-btn skill-del" type="button" data-mcp-del="${escAttr(m.name)}" title="Disconnect" aria-label="Disconnect ${escAttr(m.name)}">${svgIcon('trash', 13)}</button>`
    : `<span class="skill-tag" title="Set up in Claude Code itself">${esc(MCP_SCOPES[m.scope ?? 'user'] ?? 'Claude Code')}</span>`;
  return `<div class="skill-row mcp-row" title="${escAttr(m.detail)}">
    <span class="skill-text"><b>${esc(m.name)}</b><small>${esc(m.detail || (m.type === 'http' ? 'URL' : 'Command'))}</small></span>${end}</div>`;
}
function mcpGroupHtml(): string {
  const mine = mcpData?.breeze ?? [], theirs = mcpData?.claude ?? [];
  const rows = mine.map(m => mcpRowHtml(m, true)).join('') + theirs.map(m => mcpRowHtml(m, false)).join('');
  return skillGroupHtml('claude:mcp', 'MCP servers', mine.length + theirs.length, rows);
}

function renderSkills(): void {
  const box = $('#skillList');
  if (!skillData) { box.innerHTML = '<p class="side-note">Looking for skills…</p>'; return; }
  const { skills, plugins } = skillData;
  let html = '';
  for (const [agent, label] of SKILL_AGENTS) {
    const mine = skills.filter(s => s.agent === agent);
    html += `<section class="skill-agent"><h6>${brandMark('skill-mark', agent, label[0])}${esc(label)}</h6>`;
    html += skillGroupHtml(`${agent}:user`, 'Your skills', mine.length, mine.map(skillRowHtml).join(''));
    // Only Claude Code has plugins.
    if (agent === 'claude') html += skillGroupHtml('claude:plugins', 'Plugins', plugins.length, plugins.map(pluginHtml).join('')) + mcpGroupHtml();
    html += '</section>';
  }
  box.innerHTML = html;
}

async function refreshSkills(): Promise<void> {
  try {
    [skillData, mcpData] = await Promise.all([api.skills.list(), api.mcp.list().catch(() => ({ breeze: [], claude: [] }))]);
  } catch (e) { $('#skillList').innerHTML = `<p class="side-note">Couldn't read the skills: ${esc(errMsg(e))}</p>`; return; }
  setSlashSkills(skillData); // the prompts' "/" menu follows what's here
  renderSkills();
}

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
        <label>Environment variables <small>one per line, optional</small><textarea class="input" name="env" rows="2" placeholder="GITHUB_TOKEN=…" spellcheck="false"></textarea></label>
      </div>
      <div data-mcp-for="http" hidden>
        <label>URL<input class="input" name="url" placeholder="https://example.com/mcp" spellcheck="false"></label>
        <label>Headers <small>one per line, optional</small><textarea class="input" name="headers" rows="2" placeholder="Authorization: Bearer …" spellcheck="false"></textarea></label>
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
    });
    form.onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(form);
      const val = (k: string) => String(f.get(k) ?? '');
      try {
        const s = await api.mcp.add({ name: val('name').trim(), type, command: val('command'), env: val('env'), url: val('url'), headers: val('headers') });
        closeModal();
        toast(`Connected ${s.name}. Claude Code gets it from the next run.`);
        foldedSkillGroups.delete('claude:mcp');
        await refreshSkills();
      } catch (err) { $('#mcpError', m).textContent = errMsg(err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
    };
    $<HTMLInputElement>('[name="name"]', m).focus();
  });
}
commands['mcp.connect'] = connectMcp;

const allSkills = (): AgentSkill[] => [...skillData?.skills ?? [], ...(skillData?.plugins ?? []).flatMap(p => p.skills)];
const skillAgentName = (s: AgentSkill) => SKILL_AGENTS.find(([id]) => id === s.agent)?.[1] ?? s.agent;

async function viewSkill(s: AgentSkill): Promise<void> {
  let text = '';
  try { text = await api.skills.read(s.file); } catch (e) { toast(`Couldn't open ${s.name}: ${errMsg(e)}`); return; }
  const body = text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const where = s.plugin ? `Plugin ${s.plugin}` : `${skillAgentName(s)} · your skills`;
  const del = s.removable ? '<button class="btn btn-danger" id="skillViewDel">Remove</button>' : '';
  openModal(`<h3>${esc(s.name)}</h3>
    <p class="sub">${esc(where)}</p>
    ${s.description ? `<p class="skill-view-desc">${esc(s.description)}</p>` : ''}
    <pre class="skill-view-body">${esc(body.trim())}</pre>
    <p class="skill-view-path" title="${escAttr(s.file)}">${esc(s.file)}</p>
    <div class="row end"><button class="btn" data-close>Close</button>${del}</div>`, m => {
    m.classList.add('skill-view');
    m.querySelector<HTMLElement>('#skillViewDel')?.addEventListener('click', () => confirmRemoveSkill(s));
  });
}

function confirmRemoveSkill(s: AgentSkill): void {
  openModal(`<h3>Remove ${esc(s.name)}?</h3>
    <p class="sub">Its folder goes to the Recycle Bin, and ${esc(skillAgentName(s))} stops using it in new chats. Restore it from the Recycle Bin to get it back.</p>
    <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn btn-danger" id="skillDelOk">Remove</button></div>`, m => {
    $('#skillDelOk', m).onclick = async () => {
      closeModal();
      try {
        await api.skills.remove(s.id);
        toast(`Removed ${s.name}`);
      } catch (e) { toast(`Couldn't remove ${s.name}: ${errMsg(e)}`); }
      await refreshSkills();
    };
  });
}

$('#skillList').addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const find = (id?: string) => allSkills().find(s => s.id === id);
  const mcpDel = t.closest<HTMLElement>('[data-mcp-del]');
  if (mcpDel) {
    const name = mcpDel.dataset.mcpDel as string;
    background(api.mcp.remove(name).then(() => { toast(`Disconnected ${name}`); return refreshSkills(); }));
    return;
  }
  const del = t.closest<HTMLElement>('[data-skill-del]');
  if (del) { const s = find(del.dataset.skillDel); if (s) confirmRemoveSkill(s); return; }
  const sw = t.closest<HTMLButtonElement>('[data-plugin]');
  if (sw) {
    const id = sw.dataset.plugin as string;
    const on = sw.getAttribute('aria-checked') !== 'true';
    background(api.skills.setPlugin(id, on).then(v => {
      const p = skillData?.plugins.find(x => x.id === id);
      if (p) p.enabled = v;
      if (skillData) setSlashSkills(skillData);
      renderSkills();
      toast(v ? `${p?.name ?? id} is on` : `${p?.name ?? id} is off: Claude Code won't load its skills in new chats`);
    }).catch(err => toast(`Couldn't change ${id}: ${errMsg(err)}`)));
    return;
  }
  const group = t.closest<HTMLButtonElement>('[data-skill-group]');
  if (group) {
    if (group.disabled) return;
    const key = group.dataset.skillGroup as string;
    if (foldedSkillGroups.has(key)) foldedSkillGroups.delete(key); else foldedSkillGroups.add(key);
    renderSkills();
    return;
  }
  const open = t.closest<HTMLElement>('[data-plugin-open]');
  if (open) {
    const id = open.dataset.pluginOpen as string;
    if (openPlugins.has(id)) openPlugins.delete(id); else openPlugins.add(id);
    renderSkills();
    return;
  }
  const row = t.closest<HTMLElement>('[data-skill]');
  const s = row && find(row.dataset.skill);
  if (s) void viewSkill(s);
});
$('#skillList').addEventListener('keydown', e => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.skill-row');
  if (!row || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  row.click();
});
commands['skills.refresh'] = () => void refreshSkills();
renderSkills();
