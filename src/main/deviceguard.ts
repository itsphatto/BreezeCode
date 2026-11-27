// Breeze Agent's Device Control rules: the block list no setting turns off, what counts as risky, and what each
// Control level lets a tool do. Plain functions with no Electron, so test/deviceguard.test.js can cover them.
// The agent reads files, pages and screenshots that may hide instructions (prompt injection), so these checks run
// in code on every device call; nothing here trusts what the agent says about its own actions.
import * as path from 'node:path';

export type ControlLevel = 'ask' | 'plan' | 'auto' | 'full';
export const CONTROL_LEVELS: ControlLevel[] = ['ask', 'plan', 'auto', 'full'];
export const isControlLevel = (v: unknown): v is ControlLevel => CONTROL_LEVELS.includes(v as ControlLevel);

// Where this computer keeps the things the block list protects. Filled from process.env and Electron in main.ts.
export interface GuardEnv {
  platform: string;
  home: string;
  userData: string;       // Breeze's own settings, memory, task store and the block list itself
  appDir: string;         // where Breeze is installed: its code and runtime
  appData?: string;       // %APPDATA% (Roaming)
  localAppData?: string;  // %LOCALAPPDATA%
  systemRoot?: string;    // %SystemRoot%, C:\Windows
  programFiles?: string[];
  projects?: string[];    // Breeze projects: a .env inside one is the project's, not blocked here
  allowed?: string[];     // paths the user allowed by hand in Settings (never Breeze's own)
}

const pathApi = (platform: string) => (platform === 'win32' ? path.win32 : path.posix);
// Windows paths ignore case and trailing dots/spaces; compare them folded.
function fold(p: string, platform: string): string {
  const api = pathApi(platform);
  const n = api.normalize(p).replace(/[\\/]+$/, '');
  return platform === 'win32' ? n.toLowerCase().replace(/[. ]+(?=\\|$)/g, '') : n;
}
function within(base: string, p: string, platform: string): boolean {
  const b = fold(base, platform), x = fold(p, platform);
  const sep = platform === 'win32' ? '\\' : '/';
  return x === b || x.startsWith(b.endsWith(sep) ? b : b + sep);
}

// Folders under home that hold keys, logins and wallets.
const HOME_SECRETS = [
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config/gh', '.config/gcloud', '.netrc', '.git-credentials',
  '.bitcoin', '.ethereum', '.electrum', '.password-store',
  // Browser profiles (passwords, cookies, sessions) on Linux and macOS
  '.mozilla', '.config/google-chrome', '.config/chromium', '.config/BraveSoftware', '.config/microsoft-edge',
  'Library/Keychains', 'Library/Cookies', 'Library/Application Support/Google/Chrome', 'Library/Application Support/Firefox',
  'Library/Application Support/BraveSoftware', 'Library/Application Support/Microsoft Edge', 'Library/Safari',
  'Library/Application Support/Exodus', 'Library/Application Support/Bitcoin',
];
// Under %LOCALAPPDATA% and %APPDATA% on Windows.
const LOCAL_SECRETS = ['Google/Chrome/User Data', 'Microsoft/Edge/User Data', 'BraveSoftware', 'Microsoft/Credentials', 'Microsoft/Vault', 'Microsoft/Protect'];
const ROAMING_SECRETS = ['Mozilla/Firefox', 'Opera Software', 'Microsoft/Credentials', 'Microsoft/Protect', 'Microsoft/Crypto', 'Microsoft/SystemCertificates', 'Bitcoin', 'Ethereum', 'Exodus', 'Electrum', 'atomic'];
const POSIX_SYSTEM = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/sbin', '/sys', '/usr', '/System', '/private', '/Library'];
// Key and vault files wherever they are.
const SECRET_FILE = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|kdbx|keychain|keystore|jks|ppk|gpg|asc)|known_hosts|authorized_keys|credentials(?:\.json)?|wallet\.dat|Login Data|Cookies|key[34]\.db|logins\.json|cookies\.sqlite)$/i;
const ENV_FILE = /^\.env(?:\..+)?$/i;

// Why the agent may not touch `abs`, or null. `abs` must already be absolute (and real, links followed, by the caller).
export function blockedPath(abs: string, env: GuardEnv): string | null {
  const { platform } = env;
  const api = pathApi(platform);
  if (!api.isAbsolute(abs)) return 'Device paths must be absolute.';
  const own = [env.userData, env.appDir].filter(Boolean);
  if (own.some(d => within(d, abs, platform))) return 'Breeze’s own files (settings, memory, the block list) are off limits.';
  if ((env.allowed ?? []).some(a => api.isAbsolute(a) && within(a, abs, platform))) return null;
  const home = env.home;
  const roots: string[] = [];
  if (platform === 'win32') {
    if (env.systemRoot) roots.push(env.systemRoot);
    roots.push(...(env.programFiles ?? []));
    const drive = api.parse(abs).root;
    roots.push(api.join(drive, '$Recycle.Bin'), api.join(drive, 'System Volume Information'));
    if (env.localAppData) roots.push(...LOCAL_SECRETS.map(s => api.join(env.localAppData!, s)));
    if (env.appData) roots.push(...ROAMING_SECRETS.map(s => api.join(env.appData!, s)));
  } else {
    roots.push(...POSIX_SYSTEM);
  }
  roots.push(...HOME_SECRETS.map(s => api.join(home, s)));
  if (roots.some(r => within(r, abs, platform))) return 'That place holds system files, keys, logins or wallets, which Breeze never touches.';
  const name = api.basename(abs);
  if (SECRET_FILE.test(name)) return `${name} looks like a key, password or wallet file, which Breeze never touches.`;
  if (ENV_FILE.test(name) && !(env.projects ?? []).some(p => within(p, abs, platform))) return '.env files outside your Breeze projects are off limits.';
  return null;
}

/* ----- Secrets and payments in text the agent wants to type ----- */
const SECRET_TEXT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}/,       // API keys (OpenAI, Anthropic, Stripe style)
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,            // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/,                    // AWS access keys
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,           // Slack tokens
  /\bAIza[0-9A-Za-z_-]{35}\b/,               // Google API keys
  /\bAQ\.[0-9A-Za-z_-]{40,}/,                // Google API keys, newer format
];
export const looksLikeSecret = (text: string): boolean => SECRET_TEXT.some(r => r.test(text));
// A card number: 13 to 19 digits (spaces or dashes between) that pass the Luhn check.
export function looksLikeCard(text: string): boolean {
  for (const m of text.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

/* ----- Commands ----- */
// Never run, at any level: they wipe drives or the system.
const NEVER_COMMANDS = [/\bformat(?:\.com)?\s+[a-z]:/i, /\bdiskpart\b/i, /\bFormat-Volume\b/i, /\bClear-Disk\b/i, /\bmkfs(?:\.\w+)?\b/i, /\bdd\s+[^|]*of=\/dev\//i,
  /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(?:--no-preserve-root\s+)?\/(?:\s|$)/i, /\bbcdedit\b/i, /\bcipher\s+\/w/i, /\bvssadmin\s+delete\b/i];
// Always asked, even in Full auto: user accounts, money, mass deletes, turning off protection.
const ALWAYS_ASK_COMMANDS = [/\bnet\s+user\b/i, /\b(?:New|Remove|Set)-LocalUser\b/i, /\buser(?:add|del|mod)\b/i, /\bpasswd\b/i,
  /\bSet-MpPreference\b/i, /\bnetsh\s+advfirewall\b/i, /\bSet-ExecutionPolicy\b/i, /\breg\s+(?:add|delete)\b/i, /\bschtasks\s+\/create\b/i,
  /\bshutdown\b/i, /\bRestart-Computer\b/i, /\bStop-Computer\b/i, /\bgit\s+push\b[^\n]*(?:--force|-f\b)/i];
// Destructive enough to ask at Approve plan.
const DESTRUCTIVE_COMMANDS = [/\brm\s+-[a-z]*r/i, /\b(?:del|erase|rd|rmdir)\s+\/[sq]/i, /\bRemove-Item\b[^\n]*-Recurse/i, /\bgit\s+(?:push|reset\s+--hard|clean\s+-[a-z]*f)/i,
  /\b(?:taskkill|Stop-Process|kill|pkill|killall)\b/i, /\bcurl\b[^\n]*\|\s*(?:sh|bash|iex)/i, /\b(?:iwr|Invoke-WebRequest|Invoke-Expression|iex)\b/i, /\bnpm\s+publish\b/i];

// A command that names a blocked place. Commands can't be path-checked like file tools, so this reads the text:
// it stops the plain cases, not a command built to hide what it reads (the block list on file tools is the real floor).
const BLOCKED_WORDS = /(?:^|[\\/\s"'])\.(?:ssh|gnupg|aws|azure|kube|netrc|git-credentials|password-store)\b|Login Data|logins\.json|key[34]\.db|cookies\.sqlite|wallet\.dat|\bid_(?:rsa|dsa|ecdsa|ed25519)\b|\.kdbx\b|Microsoft[\\/](?:Credentials|Protect|Vault|Crypto)|User Data[\\/]|Mozilla[\\/]Firefox|Keychains|cmdkey\b|vaultcmd\b|Get-StoredCredential|\bsecurity\s+(?:find|dump)-|breeze-state\.json|agent-tasks\.json|agent-memory\.json|agent-allowed\.json/i;
export function mentionsBlocked(cmd: string, env: Pick<GuardEnv, 'userData' | 'appDir'>): boolean {
  if (BLOCKED_WORDS.test(cmd)) return true;
  const low = cmd.toLowerCase().replace(/\//g, '\\');
  return [env.userData, env.appDir].filter(Boolean).some(d => low.includes(d.toLowerCase().replace(/\//g, '\\')));
}

export function commandVerdict(cmd: string): 'never' | 'always-ask' | 'destructive' | 'ok' {
  if (NEVER_COMMANDS.some(r => r.test(cmd))) return 'never';
  if (ALWAYS_ASK_COMMANDS.some(r => r.test(cmd))) return 'always-ask';
  if (DESTRUCTIVE_COMMANDS.some(r => r.test(cmd))) return 'destructive';
  return 'ok';
}

/* ----- Tools and what each level lets them do ----- */
export const DEVICE_READ_TOOLS = ['fs_read', 'fs_list', 'process_list', 'screen_capture'];
export const DEVICE_SCREEN_TOOLS = ['screen_capture', 'mouse_move', 'mouse_click', 'key_type', 'key_press'];
export const MASS_DELETE = 50;

export interface ToolContext {
  level: ControlLevel;
  unattended: boolean;   // a schedule or trigger started the task: nobody may be watching
  deleteCount?: number;  // files fs_delete would remove (counted by the caller)
  outsideProjects?: boolean; // the path is outside every Breeze project
  passwordField?: boolean;   // key_type: the focused control is a password box
}
export type Verdict = { kind: 'allow' } | { kind: 'ask'; why: string } | { kind: 'block'; why: string };
const allow: Verdict = { kind: 'allow' };
const ask = (why: string): Verdict => ({ kind: 'ask', why });
const block = (why: string): Verdict => ({ kind: 'block', why });

// Whether device tools are offered at all to a task with this level.
export function deviceAllowed(level: ControlLevel, unattended: boolean): boolean {
  return !(unattended && (level === 'ask' || level === 'plan'));
}

// What happens when the agent calls `tool` with `args`. Paths are checked by blockedPath before this.
export function toolVerdict(tool: string, args: Record<string, unknown>, ctx: ToolContext): Verdict {
  if (!deviceAllowed(ctx.level, ctx.unattended)) return block('Device Control is off for tasks that start on their own at this Control level.');
  const text = typeof args.text === 'string' ? args.text : '';
  const cmd = typeof args.command === 'string' ? args.command : '';
  // The floor: the same at every level.
  if (tool === 'key_type') {
    if (ctx.passwordField) return block('The focused box is a password field. Breeze never types into one.');
    if (looksLikeSecret(text)) return block('That text looks like a key or token. Breeze never types secrets.');
    if (looksLikeCard(text)) return ask('That text looks like a card number. Sending money always needs your OK.');
  }
  if (tool === 'shell_run') {
    const v = commandVerdict(cmd);
    if (v === 'never') return block('That command can wipe a drive or the system. Breeze never runs it.');
    if (v === 'always-ask') return ask(`This command changes accounts, security or power: ${cmd.slice(0, 120)}`);
  }
  if (tool === 'fs_delete' && (ctx.deleteCount ?? 1) > MASS_DELETE) return ask(`This deletes ${ctx.deleteCount} files.`);
  if (DEVICE_READ_TOOLS.includes(tool)) return allow;
  // Above the floor, each level decides.
  if (ctx.level === 'auto' || ctx.level === 'full') return allow;
  if (ctx.level === 'ask') return ask(describe(tool, args));
  // Approve plan: only destructive actions and anything outside the projects ask.
  if (tool === 'fs_delete' || tool === 'fs_move' || tool === 'process_kill') return ask(describe(tool, args));
  if (tool === 'shell_run' && commandVerdict(cmd) === 'destructive') return ask(describe(tool, args));
  if ((tool === 'fs_write') && ctx.outsideProjects) return ask(describe(tool, args));
  if (tool === 'system_set' && (args.what === 'wifi' || args.what === 'window')) return ask(describe(tool, args));
  return allow;
}

// One line the approval card shows.
export function describe(tool: string, args: Record<string, unknown>): string {
  const s = (k: string) => String(args[k] ?? '').slice(0, 160);
  switch (tool) {
    case 'fs_write': return `Write ${s('path')}`;
    case 'fs_delete': return `Delete ${s('path')}`;
    case 'fs_move': return `Move ${s('from')} to ${s('to')}`;
    case 'shell_run': return `Run: ${s('command')}`;
    case 'app_launch': return `Open ${s('target')}`;
    case 'process_kill': return `End process ${s('pid') || s('name')}`;
    case 'mouse_move': return `Move the mouse to ${s('x')}, ${s('y')}`;
    case 'mouse_click': return `Click ${s('button') || 'left'} at ${s('x')}, ${s('y')}`;
    case 'key_type': return `Type “${s('text').slice(0, 60)}”`;
    case 'key_press': return `Press ${s('keys')}`;
    case 'system_set': return `Set ${s('what')} to ${s('value')}`;
    default: return tool;
  }
}

// Which tools a task gets: device tools only with the toggle on and the level allowing it, screen tools only for
// agents that can see pictures.
export function offeredDeviceTools(all: string[], { device, level, unattended, vision }: { device: boolean; level: ControlLevel; unattended: boolean; vision: boolean }): string[] {
  if (!device || !deviceAllowed(level, unattended)) return [];
  return all.filter(t => vision || !DEVICE_SCREEN_TOOLS.includes(t));
}
