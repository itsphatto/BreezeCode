// A tiny React-style project in a temp folder, for the .jsx/.tsx run and debug tests. `react` is a stand-in in the
// project's node_modules (the real one must resolve from there too), the package.json says "type": "module" (the
// output must still run), and the source uses an extensionless import, an import spelled with .jsx and a JSON import.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The TypeScript compiler Breeze ships (the same file main.ts uses), or null when node_modules lacks it.
function bundledTsc() {
  const exe = path.join(__dirname, '..', '..', 'node_modules', '@typescript', `typescript-${process.platform}-${process.arch}`, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc');
  return fs.existsSync(exe) ? exe : null;
}

function jsxProject() {
  // A space in the folder name on purpose: paths with spaces must work end to end.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze jsx '));
  const put = (rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
  put('package.json', '{"name":"demo","type":"module"}\n');
  put('node_modules/react/package.json', '{"name":"react","version":"19.0.0","main":"index.js"}\n');
  put('node_modules/react/index.js', 'exports.version = "19.0.0-stand-in";\n');
  put('node_modules/react/jsx-runtime.js', 'exports.jsx = exports.jsxs = (type, props) => (typeof type === "function" ? type(props) : `<${type}>${[].concat(props.children ?? []).join("")}</${type}>`);\n');
  put('src/data.json', '{"who":"world"}\n');
  put('src/Greeting.jsx', 'export function Greeting({ name }) {\n  return <b>Hello {name}</b>;\n}\n');
  const main = put('src/main.tsx', [
    'import { Greeting } from "./Greeting.jsx";',
    'import { version } from "react";',
    'import data from "./data.json";',
    'type Props = { n: number };',
    'function double(p: Props): number {',
    '  const twice = p.n * 2;',
    '  return twice;',
    '}',
    'const page = <p><Greeting name={data.who} /></p>;',
    'console.log("page", page, "react", version, double({ n: 21 }));',
    '',
  ].join('\n'));
  const bad = put('src/bad.tsx', 'const a = <div>;\n');
  return { dir, main, bad, put, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { bundledTsc, jsxProject };
