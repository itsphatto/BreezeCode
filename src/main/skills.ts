// Skills and plugins the coding agents load, for the Skills view: each skill is a folder with a SKILL.md, kept per
// agent (Claude Code, Codex). Claude Code plugins bring skills of their own. Claude Desktop keeps skills synced
// from the account under `skills/synced/`; only Claude Desktop loads those, so they aren't listed. Plugins synced
// the same way (`plugins/synced/`) are listed, marked as synced.
import * as fs from 'node:fs';
import * as path from 'node:path';

const fsp = fs.promises;

export interface Homes { claudeHome: string; codexHome: string; agentsHome?: string | null; geminiHome?: string | null }
export interface Skill {
  agent: string; scope: string; removable: boolean; plugin?: string;
  id: string; file: string; folder: string; name: string; description: string;
}
export interface UserSkill extends Skill { real: string; agents: string[] }
export interface Plugin {
  id: string; name: string; marketplace: string; version: string; description: string; enabled: boolean; synced: boolean; skills: Skill[];
}
type SkillExtra = Pick<Skill, 'agent' | 'scope' | 'removable'> & { plugin?: string };
// The fields read from a plugin's JSON files.
interface PluginManifest { name?: string; version?: string; description?: string }

// Where each agent keeps the user's own skills. A skill in one of these folders can be removed; a plugin's can't
// (the plugin brings it back).
// ~/.agents/skills is the shared folder Codex also reads (and where `npx skills` installs); Antigravity keeps the
// user's skills in ~/.gemini/config/skills.
function skillSources({ claudeHome, codexHome, agentsHome, geminiHome }: Homes): { agent: string; scope: string; dir: string }[] {
  return [
    { agent: 'claude', scope: 'user', dir: path.join(claudeHome, 'skills') },
    { agent: 'codex', scope: 'user', dir: path.join(codexHome, 'skills') },
    ...agentsHome ? [{ agent: 'codex', scope: 'user', dir: path.join(agentsHome, 'skills') }] : [],
    ...geminiHome ? [{ agent: 'antigravity', scope: 'user', dir: path.join(geminiHome, 'config', 'skills') }] : [],
  ];
}

// Skills an agent brings itself or gets from the account: listed and readable, never removed here. Claude's synced
// ones sit under skills/synced/<account>/, Codex keeps its built-ins in skills/.system, and each Antigravity install
// has a builtin/skills of its own (the same skill in two installs is listed once).
async function readOnlySkills({ claudeHome, codexHome, geminiHome }: Homes): Promise<Skill[]> {
  const out: Skill[] = [];
  const synced = path.join(claudeHome, 'skills', 'synced');
  for (const acct of await fsp.readdir(synced, { withFileTypes: true }).catch(() => [])) {
    if (acct.isDirectory()) out.push(...await skillsIn(path.join(synced, acct.name), { agent: 'claude', scope: 'synced', removable: false }));
  }
  out.push(...await skillsIn(path.join(codexHome, 'skills', '.system'), { agent: 'codex', scope: 'builtin', removable: false }));
  if (geminiHome) {
    for (const install of ['antigravity-cli', 'antigravity', 'antigravity-ide']) {
      for (const k of await skillsIn(path.join(geminiHome, install, 'builtin', 'skills'), { agent: 'antigravity', scope: 'builtin', removable: false })) {
        if (!out.some(o => o.agent === 'antigravity' && o.folder === k.folder)) out.push(k);
      }
    }
  }
  return out;
}

// `name` and `description` from a SKILL.md's front matter (YAML between --- lines). A folded or literal block
// (`description: >` then indented lines) is joined into one line.
function frontMatter(text: string): { name?: string; description?: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv || (kv[1] !== 'name' && kv[1] !== 'description')) continue;
    let value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const parts: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) parts.push(lines[++i].trim());
      value = parts.filter(Boolean).join(' ');
    }
    out[kv[1]] = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return out;
}

// The skills in one folder: each subfolder with a SKILL.md. Hidden folders (Codex keeps its built-ins in .system)
// are left out.
async function skillsIn(dir: string, extra: SkillExtra): Promise<Skill[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
  const out: Skill[] = [];
  for (const e of entries) {
    // A linked skill folder (how `npx skills` shares one between agents) counts too.
    if (!(e.isDirectory() || e.isSymbolicLink()) || e.name.startsWith('.')) continue;
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
async function claudePlugins(claudeHome: string): Promise<Plugin[]> {
  const read = async (f: string[]): Promise<any> => JSON.parse(await fsp.readFile(path.join(claudeHome, ...f), 'utf8'));
  const installed = await read(['plugins', 'installed_plugins.json']).catch(() => null);
  const enabled = (await read(['settings.json']).catch(() => null))?.enabledPlugins ?? {};
  const out: Plugin[] = [];
  for (const [id, raw] of Object.entries<any>(installed?.plugins ?? {})) {
    const inst = Array.isArray(raw) ? raw[0] : raw;
    if (!inst?.installPath) continue;
    const [name, marketplace = ''] = id.split('@');
    const manifest: PluginManifest = await fsp.readFile(path.join(inst.installPath, '.claude-plugin', 'plugin.json'), 'utf8').then(JSON.parse).catch(() => ({}));
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
  for (const acct of await fsp.readdir(base, { withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
    if (!acct.isDirectory() || acct.name.startsWith('.')) continue;
    for (const e of await fsp.readdir(path.join(base, acct.name), { withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(base, acct.name, e.name);
      const manifest: PluginManifest | null = await fsp.readFile(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (!manifest) continue;
      const meta: { marketplace_name?: string } = await fsp.readFile(`${dir}.meta.json`, 'utf8').then(JSON.parse).catch(() => ({}));
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

// The user's own skills, one entry per skill folder: a folder linked into other agents' folders (by sharing, or by
// `npx skills`) is listed once, with every agent that has it in `agents`; its own folder (not a link) is the entry.
async function userSkills(opts: Homes): Promise<UserSkill[]> {
  const byReal = new Map<string, UserSkill & { linked: boolean }>();
  for (const src of skillSources(opts)) {
    for (const k of await skillsIn(src.dir, { agent: src.agent, scope: src.scope, removable: true })) {
      const real = await fsp.realpath(k.id).catch(() => k.id);
      const linked = await fsp.lstat(k.id).then(st => st.isSymbolicLink(), () => false);
      const had = byReal.get(real);
      if (!had) { byReal.set(real, { ...k, real, linked, agents: [k.agent] }); continue; }
      if (!had.agents.includes(k.agent)) had.agents.push(k.agent);
      if (had.linked && !linked) byReal.set(real, { ...k, real, linked, agents: had.agents });
    }
  }
  return [...byReal.values()].map(({ linked, ...k }) => k);
}

async function listSkills(opts: Homes): Promise<{ skills: Skill[]; plugins: Plugin[] }> {
  const skills: Skill[] = await userSkills(opts);
  skills.push(...await readOnlySkills(opts));
  return { skills, plugins: await claudePlugins(opts.claudeHome) };
}

// Where sharing links a skill so each agent loads it: Claude Code's skills folder, ~/.agents/skills for Codex and
// Antigravity's config/skills.
function shareTargets({ claudeHome, agentsHome, geminiHome }: Homes): { agent: string; dir: string }[] {
  return [
    { agent: 'claude', dir: path.join(claudeHome, 'skills') },
    ...agentsHome ? [{ agent: 'codex', dir: path.join(agentsHome, 'skills') }] : [],
    ...geminiHome ? [{ agent: 'antigravity', dir: path.join(geminiHome, 'config', 'skills') }] : [],
  ];
}

// Links each of the user's skills into the agents that don't have it yet. A link, not a copy, so an edit shows for
// every agent; on Windows a junction, which needs no admin rights. A folder of the same name already there is left
// alone (it's a different skill, or the agent's own copy). Returns how many links it made.
async function shareSkills(opts: Homes): Promise<number> {
  let made = 0;
  for (const k of await userSkills(opts)) {
    for (const t of shareTargets(opts)) {
      if (k.agents.includes(t.agent)) continue;
      const to = path.join(t.dir, k.folder);
      if (await fsp.lstat(to).then(() => true, () => false)) continue;
      await fsp.mkdir(t.dir, { recursive: true });
      await fsp.symlink(k.real, to, process.platform === 'win32' ? 'junction' : 'dir');
      made++;
    }
  }
  return made;
}

// Removing a shared skill: the links to it in every agent's folder go first (only the link, never what it points
// to). Returns whether the folder itself is still there to be put in the Recycle Bin (it isn't when it was a link).
async function unlinkSkill(dir: string, opts: Homes): Promise<boolean> {
  const real = await fsp.realpath(dir);
  for (const src of skillSources(opts)) {
    for (const e of await fsp.readdir(src.dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
      const p = path.join(src.dir, e.name);
      if (e.isSymbolicLink() && await fsp.realpath(p).catch(() => null) === real) await fsp.unlink(p);
    }
  }
  return fs.existsSync(dir);
}

// A folder the Skills view may remove: a skill (it has a SKILL.md) directly inside one of the agents' own skill
// folders. Not a hidden folder, and not Claude Desktop's `synced` folder.
function removableSkill(dir: unknown, opts: Homes): boolean {
  if (typeof dir !== 'string' || !dir) return false;
  const abs = path.resolve(dir);
  const name = path.basename(abs);
  const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  return !name.startsWith('.') && name !== 'synced' && fs.existsSync(path.join(abs, 'SKILL.md'))
    && skillSources(opts).some(s => same(path.dirname(abs), path.resolve(s.dir)));
}

// A SKILL.md the view may show: one from listSkills (an agent's skill folder or an installed plugin's).
async function readSkill(file: unknown, opts: Homes): Promise<string> {
  const { skills, plugins } = await listSkills(opts);
  const all = [...skills, ...plugins.flatMap(p => p.skills)];
  if (!all.some(s => path.resolve(s.file) === path.resolve(String(file)))) throw new Error('Not a skill Breeze knows about');
  return fsp.readFile(file as string, 'utf8');
}

// Turns a Claude Code plugin on or off in its settings.json, keeping everything else in the file as it was.
async function setPluginEnabled(claudeHome: string, id: string, on: unknown): Promise<boolean> {
  const file = path.join(claudeHome, 'settings.json');
  const text = await fsp.readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? '{}' : Promise.reject(e)));
  const settings = JSON.parse(text); // a file that doesn't parse is left alone
  settings.enabledPlugins = { ...settings.enabledPlugins, [id]: on === true };
  await fsp.mkdir(claudeHome, { recursive: true });
  await fsp.writeFile(file, JSON.stringify(settings, null, 2) + '\n');
  return on === true;
}

export { skillSources, frontMatter, listSkills, removableSkill, readSkill, setPluginEnabled, shareSkills, unlinkSkill };
