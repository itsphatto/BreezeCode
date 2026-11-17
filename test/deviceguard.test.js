const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../src/main/deviceguard');

const WIN = {
  platform: 'win32', home: 'C:\\Users\\me', userData: 'C:\\Users\\me\\AppData\\Roaming\\Breeze Code', appDir: 'C:\\Program Files\\Breeze Code',
  appData: 'C:\\Users\\me\\AppData\\Roaming', localAppData: 'C:\\Users\\me\\AppData\\Local', systemRoot: 'C:\\Windows',
  programFiles: ['C:\\Program Files', 'C:\\Program Files (x86)'], projects: ['C:\\code\\app'], allowed: [],
};
const NIX = { platform: 'linux', home: '/home/me', userData: '/home/me/.config/Breeze Code', appDir: '/opt/breeze', projects: ['/home/me/code/app'], allowed: [] };

test('system folders, keys, browsers and wallets are blocked on Windows', () => {
  for (const p of ['C:\\Windows\\System32\\drivers\\etc\\hosts', 'c:\\windows\\x', 'C:\\Program Files\\Git\\bin\\git.exe', 'C:\\Program Files (x86)\\x',
    'C:\\Users\\me\\.ssh\\config', 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data',
    'C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Cookies', 'C:\\Users\\me\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\a\\logins.json',
    'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Credentials\\ABC', 'C:\\Users\\me\\AppData\\Roaming\\Exodus\\x', 'D:\\$Recycle.Bin\\x',
    'C:\\WINDOWS.\\x']) {
    assert.ok(g.blockedPath(p, WIN), p);
  }
});

test('ordinary files anywhere are allowed', () => {
  for (const p of ['C:\\Users\\me\\Documents\\notes.txt', 'C:\\Users\\me\\Desktop\\pic.png', 'D:\\games\\save.dat', 'C:\\code\\app\\.env']) {
    assert.equal(g.blockedPath(p, WIN), null, p);
  }
  assert.equal(g.blockedPath('/home/me/Downloads/a.zip', NIX), null);
});

test('Breeze’s own files are blocked even when the user allowed a parent', () => {
  const env = { ...WIN, allowed: ['C:\\Users\\me\\AppData\\Roaming'] };
  assert.match(g.blockedPath('C:\\Users\\me\\AppData\\Roaming\\Breeze Code\\breeze-state.json', env), /Breeze’s own/);
  assert.match(g.blockedPath('C:\\Program Files\\Breeze Code\\resources\\app.asar', WIN), /Breeze’s own/);
});

test('a path the user allowed by hand opens that place only', () => {
  const env = { ...WIN, allowed: ['C:\\Users\\me\\.ssh\\public'] };
  assert.equal(g.blockedPath('C:\\Users\\me\\.ssh\\public\\a.txt', env), null);
  assert.ok(g.blockedPath('C:\\Users\\me\\.ssh\\config', env));
});

test('key files and .env outside projects are blocked by name', () => {
  for (const p of ['/home/me/x/id_rsa', '/home/me/certs/server.pem', '/home/me/db.kdbx', '/home/me/other/.env', '/home/me/other/.env.local']) {
    assert.ok(g.blockedPath(p, NIX), p);
  }
  assert.equal(g.blockedPath('/home/me/code/app/.env', NIX), null);
  for (const p of ['/etc/passwd', '/usr/bin/sh', '/home/me/.gnupg/x', '/home/me/.mozilla/firefox/x']) assert.ok(g.blockedPath(p, NIX), p);
  assert.ok(g.blockedPath('relative/path', NIX));
});

test('secrets and card numbers in typed text', () => {
  assert.ok(g.looksLikeSecret('sk-ant-abcdefghijklmnopqrstuvwxyz123456'));
  assert.ok(g.looksLikeSecret('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.ok(g.looksLikeSecret('-----BEGIN OPENSSH PRIVATE KEY-----'));
  assert.ok(!g.looksLikeSecret('hello world'));
  assert.ok(g.looksLikeCard('4111 1111 1111 1111'));
  assert.ok(!g.looksLikeCard('4111 1111 1111 1112'));
  assert.ok(!g.looksLikeCard('call me at 555-1234'));
});

test('commands: never, always ask, destructive, ok', () => {
  assert.equal(g.commandVerdict('format D: /q'), 'never');
  assert.equal(g.commandVerdict('rm -rf /'), 'never');
  assert.equal(g.commandVerdict('diskpart'), 'never');
  assert.equal(g.commandVerdict('net user bob pass /add'), 'always-ask');
  assert.equal(g.commandVerdict('git push --force origin main'), 'always-ask');
  assert.equal(g.commandVerdict('rm -rf build'), 'destructive');
  assert.equal(g.commandVerdict('git push'), 'destructive');
  assert.equal(g.commandVerdict('taskkill /im notepad.exe'), 'destructive');
  assert.equal(g.commandVerdict('npm test'), 'ok');
});

test('the floor holds at Full auto', () => {
  const full = { level: 'full', unattended: true };
  assert.equal(g.toolVerdict('shell_run', { command: 'format C:' }, full).kind, 'block');
  assert.equal(g.toolVerdict('shell_run', { command: 'net user x y /add' }, full).kind, 'ask');
  assert.equal(g.toolVerdict('key_type', { text: 'x' }, { ...full, passwordField: true }).kind, 'block');
  assert.equal(g.toolVerdict('key_type', { text: 'sk-abcdefghijklmnopqrstuvwxyz' }, full).kind, 'block');
  assert.equal(g.toolVerdict('key_type', { text: '4111111111111111' }, full).kind, 'ask');
  assert.equal(g.toolVerdict('fs_delete', { path: 'x' }, { ...full, deleteCount: 51 }).kind, 'ask');
  assert.equal(g.toolVerdict('fs_delete', { path: 'x' }, { ...full, deleteCount: 50 }).kind, 'allow');
  assert.equal(g.toolVerdict('mouse_click', { x: 1, y: 2 }, full).kind, 'allow');
});

test('each level asks for what it should', () => {
  const at = level => ({ level, unattended: false });
  assert.equal(g.toolVerdict('fs_read', { path: 'x' }, at('ask')).kind, 'allow');
  assert.equal(g.toolVerdict('fs_write', { path: 'x' }, at('ask')).kind, 'ask');
  assert.equal(g.toolVerdict('mouse_click', {}, at('ask')).kind, 'ask');
  assert.equal(g.toolVerdict('fs_write', { path: 'x' }, { ...at('plan'), outsideProjects: false }).kind, 'allow');
  assert.equal(g.toolVerdict('fs_write', { path: 'x' }, { ...at('plan'), outsideProjects: true }).kind, 'ask');
  assert.equal(g.toolVerdict('fs_delete', { path: 'x' }, at('plan')).kind, 'ask');
  assert.equal(g.toolVerdict('shell_run', { command: 'rm -rf dist' }, at('plan')).kind, 'ask');
  assert.equal(g.toolVerdict('shell_run', { command: 'npm test' }, at('plan')).kind, 'allow');
  assert.equal(g.toolVerdict('fs_delete', { path: 'x' }, at('auto')).kind, 'allow');
});

test('unattended tasks at Ask and Approve plan get no device control', () => {
  assert.equal(g.deviceAllowed('ask', true), false);
  assert.equal(g.deviceAllowed('plan', true), false);
  assert.equal(g.deviceAllowed('plan', false), true);
  assert.equal(g.deviceAllowed('auto', true), true);
  assert.equal(g.toolVerdict('fs_read', {}, { level: 'plan', unattended: true }).kind, 'block');
});

test('screen tools are only offered to agents that can see', () => {
  const all = ['fs_read', 'shell_run', 'screen_capture', 'mouse_click', 'key_type'];
  assert.deepEqual(g.offeredDeviceTools(all, { device: true, level: 'auto', unattended: false, vision: false }), ['fs_read', 'shell_run']);
  assert.deepEqual(g.offeredDeviceTools(all, { device: true, level: 'auto', unattended: false, vision: true }), all);
  assert.deepEqual(g.offeredDeviceTools(all, { device: false, level: 'full', unattended: false, vision: true }), []);
  assert.deepEqual(g.offeredDeviceTools(all, { device: true, level: 'ask', unattended: true, vision: true }), []);
});
