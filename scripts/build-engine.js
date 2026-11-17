// Builds Breeze's Rust sidecars in release mode and copies each executable to runtime/:
// the document engine (engine/) and Breeze Agent's hands for Device Control (hands/).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const ext = process.platform === 'win32' ? '.exe' : '';
const SIDECARS = [
  { dir: 'engine', exe: 'breeze-engine' },
  { dir: 'hands', exe: 'breeze-hands' },
];

fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
for (const { dir, exe } of SIDECARS) {
  const manifest = path.join(root, dir, 'Cargo.toml');
  const build = spawnSync('cargo', ['build', '--release', '--manifest-path', manifest], { stdio: 'inherit', cwd: root });
  if (build.error && build.error.code === 'ENOENT') {
    console.error("Rust isn't installed. Get it from https://rustup.rs");
    process.exit(1);
  }
  if (build.error || build.status !== 0) process.exit(build.status || 1);
  fs.copyFileSync(path.join(root, dir, 'target', 'release', exe + ext), path.join(root, 'runtime', exe + ext));
  console.log('Built runtime/' + exe + ext);
}
