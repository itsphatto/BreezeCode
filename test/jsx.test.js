// Running .jsx and .tsx files: the plan (tsc writes CommonJS + source maps, node runs it) and a real run through it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runPlan, runSteps, jsxBuild } = require('../src/main/toolchains');
const { bundledTsc, jsxProject } = require('./helpers/jsxProject');

const H = 'C:\\app\\runtime\\breeze_stdio.h';
const node = { path: 'C:\\nodejs\\node.exe', name: 'node', version: 'v24.1.0' };
const tools = { node, binDirs: [] };
const TSC = 'C:\\app\\resources\\typescript\\tsc.exe';

test('runPlan for .tsx: tsc into <package>/build/jsx, a CommonJS marker, then node on the output', () => {
  const r = runPlan('C:\\p\\web\\src\\app.tsx', tools, 'win32', H, { tsc: TSC, jsRoot: 'C:\\p\\web' });
  assert.equal(r.steps.length, 3);
  const [build, pkg, run] = r.steps;
  assert.equal(build.file, TSC);
  assert.equal(build.cwd, 'C:\\p\\web\\src');
  assert.equal(build.args[0], 'C:\\p\\web\\src\\app.tsx');
  const flag = (name) => build.args[build.args.indexOf(name) + 1];
  assert.equal(flag('--jsx'), 'react-jsx');
  assert.equal(flag('--module'), 'commonjs');
  assert.equal(flag('--rootDir'), 'C:\\p\\web');
  assert.equal(flag('--outDir'), 'C:\\p\\web\\build\\jsx');
  for (const f of ['--noCheck', '--allowJs', '--sourceMap', '--resolveJsonModule', '--rewriteRelativeImportExtensions']) assert.ok(build.args.includes(f), f);
  assert.equal(build.display, 'tsc "app.tsx" --jsx react-jsx --outDir "..\\build\\jsx"');
  assert.equal(pkg.file, node.path);
  assert.deepEqual(pkg.args.slice(2), ['C:\\p\\web\\build\\jsx\\package.json']);
  assert.equal(run.file, node.path);
  assert.equal(run.args[0], '--enable-source-maps');
  assert.equal(run.args.at(-1), 'C:\\p\\web\\build\\jsx\\src\\app.js');
  assert.equal(run.cwd, 'C:\\p\\web\\src');
});

test('runPlan for .jsx works the same, and without a package folder builds next to the file', () => {
  const r = runPlan('/home/me/x/App.jsx', { ...tools, node: { ...node, path: '/usr/bin/node' } }, 'linux', H, { tsc: '/opt/tsc' });
  assert.equal(r.steps[0].args.includes('--allowJs'), true);
  assert.equal(r.steps[0].args[r.steps[0].args.indexOf('--outDir') + 1], '/home/me/x/build/jsx');
  assert.equal(r.steps[2].args.at(-1), '/home/me/x/build/jsx/App.js');
});

test('a package folder that does not hold the file is ignored', () => {
  const b = jsxBuild('C:\\p\\a\\x.tsx', 'win32', 'C:\\other');
  assert.equal(b.outDir, 'C:\\p\\a\\build\\jsx');
  assert.equal(b.entry, 'C:\\p\\a\\build\\jsx\\x.js');
});

test('runPlan for .tsx says what is missing: node, then the compiler', () => {
  assert.match(runPlan('C:\\p\\a.tsx', { binDirs: [] }, 'win32', H, { tsc: TSC }).error, /Node\.js wasn't found/);
  assert.match(runPlan('C:\\p\\a.jsx', tools, 'win32', H, {}).error, /needs the TypeScript compiler that comes with Breeze/);
});

test('runPlan for .tsx does not need a Node that strips types', () => {
  const old = { ...tools, node: { ...node, version: 'v20.11.0' } };
  assert.ok(runPlan('C:\\p\\a.tsx', old, 'win32', H, { tsc: TSC }).steps);
});

// ---- a real run through the plan ----

function runAll(plan) {
  return new Promise((resolve) => {
    let text = '';
    runSteps(plan.steps, {
      spawn, env: process.env,
      onStart() {}, onChild() {}, onData: t => { text += t; },
      onDone: code => resolve({ code, text }),
    });
  });
}
const realTools = { node: { path: process.execPath, name: 'node', version: process.version }, binDirs: [] };

test('a .tsx file runs: JSX, an extensionless and a .jsx import, JSON, react from node_modules, in a "type": "module" project', { skip: !bundledTsc(), timeout: 60000 }, async t => {
  const p = jsxProject();
  t.after(p.cleanup);
  const plan = runPlan(p.main, realTools, process.platform, H, { tsc: bundledTsc(), jsRoot: p.dir });
  const r = await runAll(plan);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /page <p><b>Hello world<\/b><\/p> react 19\.0\.0-stand-in 42/);
  assert.ok(fs.existsSync(path.join(p.dir, 'build', 'jsx', 'src', 'main.js.map')));
});

test('a thrown error in a .tsx file is reported at the source line', { skip: !bundledTsc(), timeout: 60000 }, async t => {
  const p = jsxProject();
  t.after(p.cleanup);
  const f = p.put('src/boom.tsx', 'const el = <i>x</i>;\nthrow new Error("boom " + el);\n');
  const r = await runAll(runPlan(f, realTools, process.platform, H, { tsc: bundledTsc(), jsRoot: p.dir }));
  assert.notEqual(r.code, 0);
  assert.match(r.text, /boom/);
  assert.match(r.text, /boom\.tsx:2/);
});

test('a syntax error shows the compiler\'s message and the program does not start', { skip: !bundledTsc(), timeout: 60000 }, async t => {
  const p = jsxProject();
  t.after(p.cleanup);
  const r = await runAll(runPlan(p.bad, realTools, process.platform, H, { tsc: bundledTsc(), jsRoot: p.dir }));
  assert.notEqual(r.code, 0);
  assert.match(r.text, /bad\.tsx\(1,12\): error TS\d+/);
  assert.doesNotMatch(r.text, /Cannot find module/);
});

test('a type error does not stop a program from running', { skip: !bundledTsc(), timeout: 60000 }, async t => {
  const p = jsxProject();
  t.after(p.cleanup);
  const f = p.put('src/loose.tsx', 'const n: number = "five";\nconsole.log("ran", n);\n');
  const r = await runAll(runPlan(f, realTools, process.platform, H, { tsc: bundledTsc(), jsRoot: p.dir }));
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /ran five/);
});
