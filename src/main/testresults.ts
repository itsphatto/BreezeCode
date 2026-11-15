// Test results in a command's output, for the result card in the chat: how many passed and failed, and for each
// failure its name, the first line of its error and where it failed. Covers node:test (spec and TAP), Jest, Vitest,
// pytest and cargo test. Plain functions with no Electron, so test/testresults.test.js can cover them.

type Runner = 'node:test' | 'Jest' | 'Vitest' | 'pytest' | 'cargo test';
interface TestFailure { name: string; error: string; file?: string; line?: number }
interface TestReport { runner: Runner; passed: number; failed: number; skipped: number; failures: TestFailure[] }

const MAX_FAILURES = 20;
const MAX_NAME = 200;
const MAX_ERROR = 300;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const clip = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const num = (re: RegExp, s: string) => Number(re.exec(s)?.[1] ?? 0);
const firstText = (lines: string[]) => lines.map(l => l.trim()).find(l => l && !/^[-─⎯=_~^|]+$/.test(l)) ?? '';

// The first place in some lines that points into a source file of the project: `path:line` or `path:line:col`,
// bare, in parentheses or as a file:// address. Library and Node's own frames are skipped.
const LOC = /(?:file:\/\/\/?)?((?:[A-Za-z]:)?[^\s()'"`:]*[^\s()'"`:\\/]\.(?:[cm]?[jt]sx?|py|rs)):(\d+)(?::\d+)?/;
function locIn(lines: string[]): { file: string; line: number } | null {
  for (const l of lines) {
    const m = LOC.exec(l);
    if (!m || /node_modules|node:internal|[\\/]internal[\\/]|site-packages|[\\/]rustc[\\/]|\.cargo[\\/]/.test(m[1])) continue;
    return { file: m[1], line: Number(m[2]) };
  }
  return null;
}
function failure(name: string, error: string, at: { file: string; line: number } | null): TestFailure {
  const f: TestFailure = { name: clip(name, MAX_NAME), error: clip(error, MAX_ERROR) };
  if (at) { f.file = at.file; f.line = at.line; }
  return f;
}
// Blocks of lines, each starting where `start` matches, up to the next start (or `stop`).
function blocks(lines: string[], start: RegExp, stop?: RegExp): { head: RegExpExecArray; body: string[] }[] {
  const out: { head: RegExpExecArray; body: string[] }[] = [];
  let cur: { head: RegExpExecArray; body: string[] } | null = null;
  for (const l of lines) {
    const m = start.exec(l);
    if (m) { cur = { head: m, body: [] }; out.push(cur); continue; }
    if (stop?.test(l)) { cur = null; continue; }
    cur?.body.push(l);
  }
  return out;
}

function parseCargo(text: string, lines: string[]): TestReport | null {
  const results = [...text.matchAll(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/gm)];
  if (!results.length) return null;
  const sum = (i: number) => results.reduce((n, m) => n + Number(m[i]), 0);
  const failures = blocks(lines, /^---- (\S+) stdout ----$/, /^(?:failures:|test result:)/).map(({ head, body }) => {
    const at = body.findIndex(l => /panicked at /.test(l));
    const panic = at >= 0 ? body[at] : '';
    // Rust 1.73 and later: "panicked at src/lib.rs:4:5:" with the message on the next line; before: "panicked at 'msg', src/lib.rs:4:5".
    const old = /panicked at '(.*)', /.exec(panic);
    return failure(head[1], old ? old[1] : firstText(at >= 0 ? body.slice(at + 1) : body), locIn([panic.replace(/^.*panicked at (?:'.*', )?/, '')]));
  });
  return { runner: 'cargo test', passed: sum(1), failed: sum(2), skipped: sum(3), failures };
}

function parsePytest(text: string, lines: string[]): TestReport | null {
  const summary = [...text.matchAll(/^=+ (.*\b(?:passed|failed|errors?|skipped|no tests ran)\b.*) in [\d.]+s.*=+$/gm)].at(-1)?.[1];
  if (!summary) return null;
  // The traceback of each test: "____ test_name ____" up to the next one; its "file.py:12: Error" lines say where.
  const sections = new Map(blocks(lines, /^_{3,} (.+?) _{3,}$/, /^=+ /).map(b => [b.head[1], b.body]));
  const failures: TestFailure[] = [];
  for (const l of lines) {
    const m = /^(?:FAILED|ERROR) (\S+?)(?:::(\S+))?(?: - (.*))?$/.exec(l);
    if (!m) continue;
    const name = m[2] ?? m[1];
    const body = sections.get(name.replaceAll('::', '.')) ?? sections.get(name.split('::').at(-1)!) ?? [];
    const here = body.map(b => /^(\S+\.py):(\d+): /.exec(b)).filter(Boolean).at(-1);
    failures.push(failure(name, m[3] ?? firstText(body.filter(b => /^E\s/.test(b)).map(b => b.slice(1))), here ? { file: here[1], line: Number(here[2]) } : { file: m[1], line: 0 }));
  }
  for (const f of failures) if (f.line === 0) { delete f.line; if (!/\.py$/.test(f.file ?? '')) delete f.file; }
  return { runner: 'pytest', passed: num(/(\d+) passed/, summary), failed: num(/(\d+) failed/, summary) + num(/(\d+) errors?/, summary), skipped: num(/(\d+) skipped/, summary), failures };
}

function parseJest(text: string, lines: string[]): TestReport | null {
  const summary = /^Tests:\s+(.*\d+ total.*)$/m.exec(text)?.[1];
  if (!summary) return null;
  const failures = blocks(lines, /^\s*● (.+)$/, /^(?:Test Suites:|Tests:)/)
    .filter(b => !/^Console$/.test(b.head[1].trim()))
    .map(({ head, body }) => failure(head[1].replaceAll(' › ', ' > '), firstText(body), locIn(body.filter(l => /^\s*at /.test(l)))));
  return { runner: 'Jest', passed: num(/(\d+) passed/, summary), failed: num(/(\d+) failed/, summary), skipped: num(/(\d+) skipped/, summary) + num(/(\d+) todo/, summary), failures };
}

function parseVitest(text: string, lines: string[]): TestReport | null {
  const summary = /^\s*Tests\s{2,}(.*\(\d+\))\s*$/m.exec(text)?.[1];
  if (!summary || !/passed|failed|skipped/.test(summary)) return null;
  const failures: TestFailure[] = [];
  for (const { head, body } of blocks(lines, /^\s*FAIL\s+(.+?)\s*$/, /^\s*(?:Test Files|Tests)\s{2,}|⎯{3,}/)) {
    const [file, ...names] = head[1].split(' > ');
    if (!names.length || failures.some(f => f.file === file && f.name === names.join(' > '))) continue; // a file that failed to load, or a repeat
    const at = locIn(body.filter(l => /^\s*❯ /.test(l)).map(l => l.replace(/^\s*❯ /, ''))) ?? { file, line: 0 };
    const f = failure(names.join(' > '), firstText(body), at);
    if (!f.line) delete f.line;
    failures.push(f);
  }
  return { runner: 'Vitest', passed: num(/(\d+) passed/, summary), failed: num(/(\d+) failed/, summary), skipped: num(/(\d+) skipped/, summary) + num(/(\d+) todo/, summary), failures };
}

function parseNodeTest(text: string, lines: string[]): TestReport | null {
  if (!/^[ℹ#] tests \d+\s*$/m.test(text) || !/^[ℹ#] pass \d+\s*$/m.test(text)) return null;
  const count = (k: string) => num(new RegExp(`^[ℹ#] ${k} (\\d+)\\s*$`, 'm'), text);
  const failures: TestFailure[] = [];
  const tap = /^\s*not ok \d+ - /m.test(text);
  if (tap) {
    // TAP: "not ok 2 - name" and a YAML block with location: and error:. A parent that failed only because a
    // subtest did is left out; the subtest is listed.
    for (const { head, body } of blocks(lines, /^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/, /^\s*(?:ok \d+ - |# (?:tests|Subtest))/)) {
      const yaml = body.slice(0, body.findIndex(l => /^\s*\.\.\.\s*$/.test(l)) + 1 || undefined);
      if (yaml.some(l => /failureType: 'subtestsFailed'/.test(l))) continue;
      const loc = yaml.map(l => /^\s*location: '(.+)'$/.exec(l)?.[1]).find(Boolean)?.replaceAll('\\\\', '\\');
      const errAt = yaml.findIndex(l => /^\s*error: /.test(l));
      const inline = errAt >= 0 ? yaml[errAt].replace(/^\s*error: /, '').replace(/^'(.*)'$/, '$1') : '';
      const error = inline && !/^[|>]-?$/.test(inline) ? inline : firstText(errAt >= 0 ? yaml.slice(errAt + 1) : []);
      // The failing line, from the stack, beats where the test starts (location:).
      const stackAt = yaml.findIndex(l => /^\s*stack: /.test(l));
      failures.push(failure(head[1], error, (stackAt >= 0 ? locIn(yaml.slice(stackAt + 1)) : null) ?? locIn([loc ?? ''])));
    }
  } else {
    // The spec reporter lists failures again at the end, each after "test at file:line:col".
    const end = lines.findIndex(l => /^✖ failing tests:/.test(l.trim()));
    const tail = end >= 0 ? lines.slice(end + 1) : lines;
    let at: { file: string; line: number } | null = null;
    for (const { head, body } of blocks(tail, /^\s*(?:test at (.+)|✖ (.+?)(?: \([\d.]+m?s\))?)\s*$/, /^[ℹ#] /)) {
      if (head[1]) { at = locIn([head[1]]); continue; }
      if (/^failing tests:$/.test(head[2])) continue;
      // A suite that failed because a test in it did adds nothing: its test is listed.
      if (!body.some(l => l.trim()) || /^\s*'?\d+ subtests? failed'?\s*$/.test(firstText(body))) { at = null; continue; }
      // The failing line, from the stack, beats where the test starts ("test at").
      failures.push(failure(head[2], firstText(body), locIn(body.filter(l => /^\s*at /.test(l))) ?? at));
      at = null;
    }
  }
  return { runner: 'node:test', passed: count('pass'), failed: count('fail') + count('cancelled'), skipped: count('skipped') + count('todo'), failures };
}

// The results of the last test run in `output`, or null when it holds none.
function parseTestOutput(output: unknown): TestReport | null {
  const text = String(output ?? '').replace(ANSI, '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return null;
  const lines = text.split('\n');
  for (const parse of [parseCargo, parsePytest, parseJest, parseVitest, parseNodeTest]) {
    const r = parse(text, lines);
    if (!r || r.passed + r.failed + r.skipped === 0) continue;
    r.failures = r.failures.filter(f => f.name).slice(0, MAX_FAILURES);
    return r;
  }
  return null;
}

export type { TestReport, TestFailure };
export { parseTestOutput, MAX_FAILURES };
