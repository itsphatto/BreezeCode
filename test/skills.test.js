const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { frontMatter, listSkills, removableSkill, readSkill, setPluginEnabled, shareSkills, unlinkSkill } = require('../src/main/skills');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-skills-'));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const skill = (dir, name, description) => write(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);

function homes() {
  const base = tmp();
  return { claudeHome: path.join(base, 'claude'), codexHome: path.join(base, 'codex'), agentsHome: path.join(base, 'agents'), geminiHome: path.join(base, 'gemini'), root: path.join(base, 'proj') };
}

test('frontMatter reads name and description, quoted or folded', () => {
  assert.deepEqual(frontMatter('---\nname: deploy\ndescription: "Ship it"\n---\nbody'), { name: 'deploy', description: 'Ship it' });
  assert.deepEqual(frontMatter('---\r\nname: x\r\ndescription: >\r\n  Two\r\n  lines\r\n---\r\n'), { name: 'x', description: 'Two lines' });
  assert.deepEqual(frontMatter('no front matter'), {});
});

test('listSkills finds each agent skills, with synced and built-in ones read-only', async () => {
  const h = homes();
  skill(path.join(h.claudeHome, 'skills'), 'review', 'Review a diff');
  skill(path.join(h.claudeHome, 'skills', 'synced', 'acct-1'), 'pdf', 'Work with PDFs');
  skill(path.join(h.codexHome, 'skills'), 'lint', 'Lint the code');
  skill(path.join(h.codexHome, 'skills', '.system'), 'builtin', 'Built in');
  skill(path.join(h.agentsHome, 'skills'), 'shared', 'Shared skill');
  skill(path.join(h.geminiHome, 'config', 'skills'), 'tidy', 'Tidy up');
  skill(path.join(h.geminiHome, 'antigravity-cli', 'builtin', 'skills'), 'guide', 'Antigravity guide');
  skill(path.join(h.geminiHome, 'antigravity-ide', 'builtin', 'skills'), 'guide', 'Antigravity guide');
  fs.mkdirSync(path.join(h.claudeHome, 'skills', 'no-skill-md'), { recursive: true });
  const { skills, plugins } = await listSkills(h);
  assert.deepEqual(skills.map(s => [s.agent, s.scope, s.name, s.removable]).sort(), [
    ['antigravity', 'builtin', 'guide', false], ['antigravity', 'user', 'tidy', true], ['claude', 'synced', 'pdf', false],
    ['claude', 'user', 'review', true], ['codex', 'builtin', 'builtin', false], ['codex', 'user', 'lint', true], ['codex', 'user', 'shared', true]]);
  assert.deepEqual(plugins, []);
});

test('listSkills lists plugins synced from the Claude account, with their marketplace', async () => {
  const h = homes();
  const dir = path.join(h.claudeHome, 'plugins', 'synced', 'acct-1', 'a4b3');
  skill(path.join(dir, 'skills'), 'caveman', 'Talk short');
  write(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'caveman', version: '1.1.2' }));
  write(`${dir}.meta.json`, JSON.stringify({ marketplace_name: 'anthropic-plugin-directory' }));
  const { plugins } = await listSkills(h);
  assert.deepEqual(plugins.map(p => [p.id, p.version, p.synced, p.skills.map(s => s.name)]), [['caveman@anthropic-plugin-directory', '1.1.2', true, ['caveman']]]);
});

test('listSkills lists Claude plugins with their skills and on/off state', async () => {
  const h = homes();
  const install = path.join(h.claudeHome, 'plugins', 'cache', 'design');
  skill(path.join(install, 'skills'), 'ux-copy', 'Write UX copy');
  write(path.join(install, '.claude-plugin', 'plugin.json'), JSON.stringify({ description: 'Design tools', version: '1.2.0' }));
  write(path.join(h.claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'design@market': [{ installPath: install }] } }));
  write(path.join(h.claudeHome, 'settings.json'), JSON.stringify({ enabledPlugins: { 'design@market': false } }));
  const { plugins } = await listSkills(h);
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].name, 'design');
  assert.equal(plugins[0].version, '1.2.0');
  assert.equal(plugins[0].enabled, false);
  assert.deepEqual(plugins[0].skills.map(s => [s.name, s.removable]), [['ux-copy', false]]);
});

test('removableSkill allows only a skill folder directly inside an agent own skills folder', () => {
  const h = homes();
  skill(path.join(h.claudeHome, 'skills'), 'review', 'Review a diff');
  skill(path.join(h.claudeHome, 'skills', 'synced', 'acct-1'), 'pdf', 'Work with PDFs');
  assert.equal(removableSkill(path.join(h.claudeHome, 'skills', 'review'), h), true);
  assert.equal(removableSkill(path.join(h.claudeHome, 'skills', 'missing'), h), false); // no SKILL.md
  assert.equal(removableSkill(path.join(h.claudeHome, 'skills', 'synced'), h), false);
  assert.equal(removableSkill(path.join(h.claudeHome, 'skills', 'synced', 'acct-1', 'pdf'), h), false);
  assert.equal(removableSkill(path.join(h.claudeHome, 'skills'), h), false);
  assert.equal(removableSkill(path.join(h.claudeHome, 'skills', 'review', 'sub'), h), false);
  assert.equal(removableSkill(path.join(h.claudeHome, 'skills', '..', 'settings'), h), false);
  assert.equal(removableSkill(path.join(h.codexHome, 'skills', '.system'), h), false);
  assert.equal(removableSkill(path.join(h.claudeHome, 'plugins', 'x'), h), false);
  assert.equal(removableSkill('', h), false);
});

test('readSkill reads only listed skills', async () => {
  const h = homes();
  skill(path.join(h.claudeHome, 'skills'), 'review', 'Review a diff');
  const file = path.join(h.claudeHome, 'skills', 'review', 'SKILL.md');
  assert.match(await readSkill(file, h), /# review/);
  write(path.join(h.claudeHome, 'secret.txt'), 'x');
  await assert.rejects(readSkill(path.join(h.claudeHome, 'secret.txt'), h), /Not a skill/);
});

test('setPluginEnabled keeps the rest of settings.json', async () => {
  const h = homes();
  write(path.join(h.claudeHome, 'settings.json'), JSON.stringify({ model: 'opus', enabledPlugins: { 'a@m': true } }));
  assert.equal(await setPluginEnabled(h.claudeHome, 'b@m', false), false);
  const s = JSON.parse(fs.readFileSync(path.join(h.claudeHome, 'settings.json'), 'utf8'));
  assert.deepEqual(s, { model: 'opus', enabledPlugins: { 'a@m': true, 'b@m': false } });
  write(path.join(h.claudeHome, 'settings.json'), '{ not json');
  await assert.rejects(setPluginEnabled(h.claudeHome, 'b@m', true));
  assert.equal(fs.readFileSync(path.join(h.claudeHome, 'settings.json'), 'utf8'), '{ not json');
});

test('shareSkills links each skill into the agents that lack it, and unlinkSkill takes the links back out', async () => {
  const h = homes();
  skill(path.join(h.claudeHome, 'skills'), 'review', 'Review a diff');
  skill(path.join(h.agentsHome, 'skills'), 'lint', 'Lint the code');
  skill(path.join(h.geminiHome, 'config', 'skills'), 'review', 'Antigravity own review'); // same name: left alone
  assert.equal(await shareSkills(h), 3); // review → Codex; lint → Claude and Antigravity
  assert.equal(await shareSkills(h), 0); // nothing new the second time
  const { skills } = await listSkills(h);
  const row = name => skills.filter(k => k.name === name && k.scope === 'user').map(k => [k.agent, k.agents.sort()]);
  assert.deepEqual(row('lint'), [['codex', ['antigravity', 'claude', 'codex']]]);
  assert.deepEqual(row('review').sort(), [['antigravity', ['antigravity']], ['claude', ['claude', 'codex']]]);
  const lint = path.join(h.agentsHome, 'skills', 'lint');
  assert.equal(await unlinkSkill(lint, h), true); // the real folder stays for the Recycle Bin
  assert.equal(fs.existsSync(path.join(h.claudeHome, 'skills', 'lint')), false);
  assert.equal(fs.existsSync(path.join(h.geminiHome, 'config', 'skills', 'lint', 'SKILL.md')), false);
  assert.equal(fs.existsSync(path.join(lint, 'SKILL.md')), true);
});
