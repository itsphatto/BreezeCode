// Builds the Rust document engine (engine/) in release mode and copies the executable to runtime/.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const manifest = path.join(root, 'engine', 'Cargo.toml');
const exe = process.platform === 'win32' ? 'breeze-engine.exe' : 'breeze-engine';

const build = spawnSync('cargo', ['build', '--release', '--manifest-path', manifest], { stdio: 'inherit', cwd: root });
if (build.error && build.error.code === 'ENOENT') {
  console.error("Rust isn't installed. Get it from https://rustup.rs");
  process.exit(1);
}
if (build.error || build.status !== 0) process.exit(build.status || 1);

fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
fs.copyFileSync(path.join(root, 'engine', 'target', 'release', exe), path.join(root, 'runtime', exe));
console.log('Built runtime/' + exe);
