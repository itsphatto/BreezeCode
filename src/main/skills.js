// Skills and plugins the coding agents load, for the Skills view: each skill is a folder with a SKILL.md, kept per
// agent (Claude Code, Codex). Claude Code plugins bring skills of their own. Claude Desktop keeps skills synced
// from the account under `skills/synced/`; only Claude Desktop loads those, so they aren't listed. Plugins synced
// the same way (`plugins/synced/`) are listed, marked as synced.
const fs = require('node:fs');
const path = require('node:path');

const fsp = fs.promises;

// Where each agent keeps the user's own skills. A skill in one of these folders can be removed; a plugin's can't
// (the plugin brings it back).
function skillSources({ claudeHome, codexHome }) {
  return [
    { agent: 'claude', scope: 'user', dir: path.join(claudeHome, 'skills') },
    { agent: 'codex', scope: 'user', dir: path.join(codexHome, 'skills') },
  ];
}

// `name` and `description` from a SKILL.md's front matter (YAML between --- lines). A folded or literal block
// (`description: >` then indented lines) is joined into one line.
function frontMatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv || (kv[1] !== 'name' && kv[1] !== 'description')) continue;
    let value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const parts = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) parts.push(lines[++i].trim());
      value = parts.filter(Boolean).join(' ');
    }
    out[kv[1]] = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return out;
}

// The skills in one folder: each subfolder with a SKILL.md. Hidden folders (Codex keeps its built-ins in .system)
// are left out.
async function skillsIn(dir, extra) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const file = path.join(dir, e.name, 'SKILL.md');
    const text = await fsp.readFile(file, 'utf8').catch(() => null);
    if (text == null) continue;
    const fm = frontMatter(text);
    out.push({ ...extra, id: path.join(dir, e.name), file, folder: e.name, name: fm.name || e.name, description: fm.description || '' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Claude Code's installed plugins. installed_plugins.json is `{ version: 2, plugins: { "name@market": [install, …] } }`
// (an older file has one install object per plugin); settings.json's enabledPlugins says which are on.
async function claudePlugins(claudeHome) {
  const read = async f => JSON.parse(await fsp.readFile(path.join(claudeHome, ...f), 'utf8'));
  const installed = await read(['plugins', 'installed_plugins.json']).catch(() => null);
  const enabled = (await read(['settings.json']).catch(() => null))?.enabledPlugins ?? {};
  const out = [];
  for (const [id, raw] of Object.entries(installed?.plugins ?? {})) {
    const inst = Array.isArray(raw) ? raw[0] : raw;
    if (!inst?.installPath) continue;
    const [name, marketplace = ''] = id.split('@');
    const manifest = await fsp.readFile(path.join(inst.installPath, '.claude-plugin', 'plugin.json'), 'utf8').then(JSON.parse).catch(() => ({}));
    out.push({
      id, name, marketplace,
      version: inst.version || manifest.version || '',
      description: manifest.description || '',
      enabled: enabled[id] !== false,
      synced: false,
      skills: await skillsIn(path.join(inst.installPath, 'skills'), { agent: 'claude', scope: 'plugin', plugin: id, removable: false }),
    });
  }
  // Plugins synced from the Claude account: plugins/synced/<account>/<plugin>/ with a .claude-plugin/plugin.json,
  // and a <plugin>.meta.json beside it naming its marketplace. The account turns these on and off, not settings.json.
  const base = path.join(claudeHome, 'plugins', 'synced');
  for (const acct of await fsp.readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (!acct.isDirectory() || acct.name.startsWith('.')) continue;
    for (const e of await fsp.readdir(path.join(base, acct.name), { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(base, acct.name, e.name);
      const manifest = await fsp.readFile(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (!manifest) continue;
      const meta = await fsp.readFile(`${dir}.meta.json`, 'utf8').then(JSON.parse).catch(() => ({}));
      const name = manifest.name || e.name;
      const marketplace = meta.marketplace_name || '';
      const id = marketplace ? `${name}@${marketplace}` : name;
      if (out.some(p => p.id === id)) continue;
      out.push({
        id, name, marketplace,
        version: manifest.version || '',
        description: manifest.description || '',
        enabled: true,
        synced: true,
        skills: await skillsIn(path.join(dir, 'skills'), { agent: 'claude', scope: 'plugin', plugin: id, removable: false }),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function listSkills(opts) {
  const skills = [];
  for (const s of skillSources(opts)) skills.push(...await skillsIn(s.dir, { agent: s.agent, scope: s.scope, removable: true }));
  return { skills, plugins: await claudePlugins(opts.claudeHome) };
}

// A folder the Skills view may remove: a skill (it has a SKILL.md) directly inside one of the agents' own skill
// folders. Not a hidden folder, and not Claude Desktop's `synced` folder.
function removableSkill(dir, opts) {
  if (typeof dir !== 'string' || !dir) return false;
  const abs = path.resolve(dir);
  const name = path.basename(abs);
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  return !name.startsWith('.') && name !== 'synced' && fs.existsSync(path.join(abs, 'SKILL.md'))
    && skillSources(opts).some(s => same(path.dirname(abs), path.resolve(s.dir)));
}

// A SKILL.md the view may show: one from listSkills (an agent's skill folder or an installed plugin's).
async function readSkill(file, opts) {
  const { skills, plugins } = await listSkills(opts);
  const all = [...skills, ...plugins.flatMap(p => p.skills)];
  if (!all.some(s => path.resolve(s.file) === path.resolve(String(file)))) throw new Error('Not a skill Breeze knows about');
  return fsp.readFile(file, 'utf8');
}

// Turns a Claude Code plugin on or off in its settings.json, keeping everything else in the file as it was.
async function setPluginEnabled(claudeHome, id, on) {
  const file = path.join(claudeHome, 'settings.json');
  const text = await fsp.readFile(file, 'utf8').catch(e => (e.code === 'ENOENT' ? '{}' : Promise.reject(e)));
  const settings = JSON.parse(text); // a file that doesn't parse is left alone
  settings.enabledPlugins = { ...settings.enabledPlugins, [id]: on === true };
  await fsp.mkdir(claudeHome, { recursive: true });
  await fsp.writeFile(file, JSON.stringify(settings, null, 2) + '\n');
  return on === true;
}

module.exports = { skillSources, frontMatter, listSkills, removableSkill, readSkill, setPluginEnabled };
