// Writes breeze.config.json from .env so the packaged app (which can't see .env) has its client ids.
// GitHub uses device flow (no secret); Google's desktop-app secret is not confidential. Nothing else is bundled.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* use real env */ }
const e = k => (process.env[k] || process.env[k + ' '] || '').trim();
const cfg = {
  github: { clientId: e('BREEZE_GITHUB_CLIENT_ID') },
  google: { clientId: e('BREEZE_GOOGLE_CLIENT_ID'), clientSecret: e('BREEZE_GOOGLE_CLIENT_SECRET') },
  discord: { clientId: e('BREEZE_DISCORD_CLIENT_ID') },
};
fs.writeFileSync(path.join(root, 'breeze.config.json'), JSON.stringify(cfg, null, 2) + '\n');
console.log('breeze.config.json written:', Object.entries({ github: cfg.github.clientId, google: cfg.google.clientId, discord: cfg.discord.clientId }).map(([k, v]) => `${k}=${v ? 'set' : 'MISSING'}`).join(' '));
