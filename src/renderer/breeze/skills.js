"use strict";
/* ================= Skills view: what each agent can load, and a way to remove it ================= */
// Skills are folders with a SKILL.md, per agent (main/skills.js). A click shows one; the bin removes it (its folder
// goes to the Recycle Bin). A Claude Code plugin brings its own skills, which can't be removed one by one, so the
// plugin has an on/off switch instead (a plugin synced from the Claude account is left to the account).
const SKILL_AGENTS = [['claude', 'Claude Code'], ['codex', 'Codex'], ['antigravity', 'Antigravity']];
const SKILL_TAGS = {
    synced: ['Synced', 'Synced from your Claude account'], builtin: ['Built-in', 'Comes with the agent'],
};
let skillData = null;
const openPlugins = new Set();
// Groups ("skills", "claude:plugins", "claude:mcp") start open; these are the ones folded shut.
const foldedSkillGroups = new Set();
// A drop-down group: open by default, folds on a click. An empty one stays shut and can't be opened.
function skillGroupHtml(key, title, count, rows) {
    const open = count > 0 && !foldedSkillGroups.has(key);
    return `<div class="skill-group${open ? ' open' : ''}${count ? '' : ' no-items'}">
    <button class="skill-group-head" type="button" data-skill-group="${escAttr(key)}" aria-expanded="${open}"${count ? '' : ' disabled'}>
      ${svgIcon('chevronRight', 12)}<span>${esc(title)}</span><span class="n">${count}</span></button>
    <div class="skill-group-body"><div>${rows}</div></div>
  </div>`;
}
function skillRowHtml(s) {
    const tag = SKILL_TAGS[s.scope];
    const end = s.removable ? holdDelHtml(s.name, `data-skill-del="${escAttr(s.id)}"`)
        : tag ? `<span class="skill-tag" title="${escAttr(tag[1])}">${tag[0]}</span>` : '';
    // One shared list, so a skill shows the mark of every agent that has it (a plugin's are all Claude Code's).
    const mark = s.plugin ? '' : `<span class="skill-marks">${(s.agents ?? [s.agent]).map(a => brandMark('skill-mark', a, agentLabel(a)[0])).join('')}</span>`;
    return `<div class="skill-row" role="button" tabindex="0" data-skill="${escAttr(s.id)}" title="${escAttr(s.description || s.name)}">
    ${mark}<span class="skill-text"><b>${esc(s.name)}</b>${s.description ? `<small>${esc(s.description)}</small>` : ''}</span>${end}</div>`;
}
function pluginHtml(p) {
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
let mcpData = null;
const MCP_SCOPES = { user: 'Claude Code', local: 'This project', project: '.mcp.json' };
function mcpRowHtml(m, mine) {
    const end = mine
        ? holdDelHtml(m.name, `data-mcp-del="${escAttr(m.name)}"`)
        : `<span class="skill-tag" title="Set up in Claude Code itself">${esc(MCP_SCOPES[m.scope ?? 'user'] ?? 'Claude Code')}</span>`;
    return `<div class="skill-row mcp-row" title="${escAttr(m.detail)}">
    <span class="skill-text"><b>${esc(m.name)}</b><small>${esc(m.detail || (m.type === 'http' ? 'URL' : 'Command'))}</small></span>${end}</div>`;
}
function mcpGroupHtml() {
    const mine = mcpData?.breeze ?? [], theirs = mcpData?.claude ?? [];
    const rows = mine.map(m => mcpRowHtml(m, true)).join('') + theirs.map(m => mcpRowHtml(m, false)).join('');
    return skillGroupHtml('claude:mcp', 'MCP servers', mine.length + theirs.length, rows);
}
function renderSkills() {
    const box = $('#skillList');
    if (!skillData) {
        box.innerHTML = '<p class="side-note">Looking for skills…</p>';
        return;
    }
    const { skills, plugins } = skillData;
    box.innerHTML = skillGroupHtml('skills', 'Skills', skills.length, skills.map(skillRowHtml).join(''))
        + skillGroupHtml('claude:plugins', 'Plugins', plugins.length, plugins.map(pluginHtml).join('')) + mcpGroupHtml();
    $$('[data-skill-del]', box).forEach(b => holdToDelete(b, () => { const k = allSkills().find(x => x.id === b.dataset.skillDel); if (k)
        void removeSkill(k); }));
    $$('[data-mcp-del]', box).forEach(b => holdToDelete(b, () => {
        const name = b.dataset.mcpDel;
        background(api.mcp.remove(name).then(() => { toast(`Disconnected ${name}`); return refreshSkills(); }));
    }));
}
async function refreshSkills() {
    try {
        [skillData, mcpData] = await Promise.all([api.skills.list(), api.mcp.list().catch(() => ({ breeze: [], claude: [] }))]);
    }
    catch (e) {
        $('#skillList').innerHTML = `<p class="side-note">Couldn't read the skills: ${esc(errMsg(e))}</p>`;
        return;
    }
    setSlashSkills(skillData); // the prompts' "/" menu follows what's here
    renderSkills();
}
// Connect an MCP server: a command Breeze starts (with optional env vars) or a URL (with optional headers).
function connectMcp() {
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
        const form = $('#mcpForm', m);
        let type = 'stdio';
        $$('[data-mcp-type]', m).forEach(b => b.onclick = () => {
            type = b.dataset.mcpType === 'http' ? 'http' : 'stdio';
            $$('[data-mcp-type]', m).forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
            $$('[data-mcp-for]', m).forEach(x => { x.hidden = x.dataset.mcpFor !== type; });
            form.classList.add('switched'); // fields slide in only on a switch, not when the dialog opens
        });
        form.onsubmit = async (e) => {
            e.preventDefault();
            const f = new FormData(form);
            const val = (k) => String(f.get(k) ?? '');
            try {
                const s = await api.mcp.add({ name: val('name').trim(), type, command: val('command'), env: val('env'), url: val('url'), headers: val('headers') });
                closeModal();
                toast(`Connected ${s.name}. Claude Code gets it from the next run.`);
                foldedSkillGroups.delete('claude:mcp');
                await refreshSkills();
            }
            catch (err) {
                $('#mcpError', m).textContent = errMsg(err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
            }
        };
        $('[name="name"]', m).focus();
    });
}
commands['mcp.connect'] = connectMcp;
const allSkills = () => [...skillData?.skills ?? [], ...(skillData?.plugins ?? []).flatMap(p => p.skills)];
const agentLabel = (id) => SKILL_AGENTS.find(([a]) => a === id)?.[1] ?? id;
const skillAgentName = (s) => agentLabel(s.agent);
async function viewSkill(s) {
    let text = '';
    try {
        text = await api.skills.read(s.file);
    }
    catch (e) {
        toast(`Couldn't open ${s.name}: ${errMsg(e)}`);
        return;
    }
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
        const del = m.querySelector('#skillViewDel');
        if (del)
            holdToDelete(del, () => { closeModal(); void removeSkill(s); });
    });
}
// Held for 5 seconds: its folder goes to the Recycle Bin, where it can be restored.
async function removeSkill(s) {
    try {
        await api.skills.remove(s.id);
        toast(`Removed ${s.name}. Restore it from the Recycle Bin to get it back.`);
    }
    catch (e) {
        toast(`Couldn't remove ${s.name}: ${errMsg(e)}`);
    }
    await refreshSkills();
}
$('#skillList').addEventListener('click', e => {
    const t = e.target;
    const find = (id) => allSkills().find(s => s.id === id);
    const sw = t.closest('[data-plugin]');
    if (sw) {
        const id = sw.dataset.plugin;
        const on = sw.getAttribute('aria-checked') !== 'true';
        const p = skillData?.plugins.find(x => x.id === id);
        // Flip it in place so the knob slides; a re-render would swap in a switch already at the end.
        const show = (v) => {
            if (p)
                p.enabled = v;
            sw.classList.toggle('on', v);
            sw.setAttribute('aria-checked', String(v));
            sw.closest('.plugin-item')?.classList.toggle('off', !v);
        };
        show(on);
        background(api.skills.setPlugin(id, on).then(v => {
            show(v);
            if (skillData)
                setSlashSkills(skillData);
            toast(v ? `${p?.name ?? id} is on` : `${p?.name ?? id} is off: Claude Code won't load its skills in new chats`);
        }).catch(err => { show(!on); toast(`Couldn't change ${id}: ${errMsg(err)}`); }));
        return;
    }
    // Groups and plugins fold in place, so the body and chevron animate.
    const group = t.closest('[data-skill-group]');
    if (group) {
        if (group.disabled)
            return;
        const key = group.dataset.skillGroup;
        const open = foldedSkillGroups.has(key);
        if (open)
            foldedSkillGroups.delete(key);
        else
            foldedSkillGroups.add(key);
        group.parentElement?.classList.toggle('open', open);
        group.setAttribute('aria-expanded', String(open));
        return;
    }
    const plug = t.closest('[data-plugin-open]');
    if (plug) {
        const id = plug.dataset.pluginOpen;
        const open = !openPlugins.has(id);
        if (open)
            openPlugins.add(id);
        else
            openPlugins.delete(id);
        plug.closest('.plugin-item')?.classList.toggle('open', open);
        plug.setAttribute('aria-expanded', String(open));
        return;
    }
    const row = t.closest('[data-skill]');
    const s = row && find(row.dataset.skill);
    if (s)
        void viewSkill(s);
});
$('#skillList').addEventListener('keydown', e => {
    const row = e.target.closest('.skill-row');
    if (!row || (e.key !== 'Enter' && e.key !== ' '))
        return;
    e.preventDefault();
    row.click();
});
commands['skills.refresh'] = () => void refreshSkills();
renderSkills();
