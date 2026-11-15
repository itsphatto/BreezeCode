const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseTestOutput } = require('../src/main/testresults');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// Real node:test output (Node 24), paths shortened.
const NODE_SPEC = `✔ adds (0.5471ms)
✖ subtracts (0.6166ms)
▶ suite
  ✖ inner fails (0.0927ms)
✖ suite (0.251ms)
﹣ later (0.0724ms) # SKIP
ℹ tests 4
ℹ suites 1
ℹ pass 1
ℹ fail 2
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 73.6423

✖ failing tests:

test at test\\m.test.js:3:1
✖ subtracts (0.6166ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  2 !== 1

      at TestContext.<anonymous> (C:\\work\\demo\\test\\m.test.js:5:34)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1402:25) {
    generatedMessage: true,
    code: 'ERR_ASSERTION'
  }

test at test\\m.test.js:4:37
✖ inner fails (0.0927ms)
  Error: boom
      at TestContext.<anonymous> (C:\\work\\demo\\test\\m.test.js:4:69)
      at Test.runInAsyncScope (node:async_hooks:227:14)
`;

const NODE_TAP = `TAP version 13
# Subtest: adds
ok 1 - adds
  ---
  duration_ms: 0.532
  type: 'test'
  ...
# Subtest: subtracts
not ok 2 - subtracts
  ---
  duration_ms: 0.6743
  type: 'test'
  location: 'C:\\\\work\\\\demo\\\\test\\\\m.test.js:3:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    2 !== 1

  code: 'ERR_ASSERTION'
  stack: |-
    TestContext.<anonymous> (C:\\work\\demo\\test\\m.test.js:5:34)
    Test.runInAsyncScope (node:async_hooks:227:14)
  ...
# Subtest: suite
    # Subtest: inner fails
    not ok 1 - inner fails
      ---
      duration_ms: 0.0899
      type: 'test'
      location: 'C:\\\\work\\\\demo\\\\test\\\\m.test.js:4:37'
      failureType: 'testCodeFailure'
      error: 'boom'
      code: 'ERR_TEST_FAILURE'
      ...
    1..1
not ok 3 - suite
  ---
  duration_ms: 0.2449
  type: 'suite'
  location: 'C:\\\\work\\\\demo\\\\test\\\\m.test.js:4:6'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  ...
# Subtest: later
ok 4 - later # SKIP
1..4
# tests 4
# suites 1
# pass 1
# fail 2
# cancelled 0
# skipped 1
# todo 0
# duration_ms 71.4605
`;

const JEST = `FAIL src/math.test.js
  math
    ✓ adds (2 ms)
    ✕ subtracts (3 ms)

  ● math › subtracts

    expect(received).toBe(expected) // Object.is equality

    Expected: 2
    Received: 1

       5 | test('subtracts', () => {
    >  6 |   expect(sub(3, 2)).toBe(2);
         |                     ^
       7 | });

      at Object.toBe (src/math.test.js:6:21)
      at Promise.then.completed (node_modules/jest-circus/build/utils.js:298:28)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 skipped, 3 passed, 5 total
Snapshots:   0 total
Time:        0.512 s
`;

const VITEST = ` ❯ test/math.test.ts (2 tests | 1 failed) 4ms
   × math > subtracts 3ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/math.test.ts > math > subtracts
AssertionError: expected 1 to be 2 // Object.is equality

- Expected
+ Received

 ❯ test/math.test.ts:7:22
      5|   it('subtracts', () => {
      6|     const r = sub(3, 2);
      7|     expect(r).toBe(2);
       |                      ^

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
   Start at  10:12:01
   Duration  310ms
`;

const PYTEST = `============================= test session starts =============================
collected 3 items

tests/test_math.py .F.                                                   [100%]

================================== FAILURES ===================================
__________________________________ test_sub ___________________________________

    def test_sub():
>       assert sub(3, 2) == 2
E       assert 1 == 2
E        +  where 1 = sub(3, 2)

tests/test_math.py:7: AssertionError
=========================== short test summary info ===========================
FAILED tests/test_math.py::test_sub - assert 1 == 2
========================= 1 failed, 2 passed in 0.05s =========================
`;

const CARGO = `running 2 tests
test tests::adds ... ok
test tests::subs ... FAILED

failures:

---- tests::subs stdout ----

thread 'tests::subs' panicked at src/lib.rs:12:9:
assertion \`left == right\` failed
  left: 1
 right: 2
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace


failures:
    tests::subs

test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;

test('node:test spec output: counts, failures, the line each failed on', () => {
  const r = parseTestOutput(NODE_SPEC);
  assert.equal(r.runner, 'node:test');
  assert.deepEqual([r.passed, r.failed, r.skipped], [1, 2, 1]);
  // The stack's line (where the assert failed) wins over "test at" (where the test starts).
  assert.deepEqual(r.failures, [
    { name: 'subtracts', error: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:', file: 'C:\\work\\demo\\test\\m.test.js', line: 5 },
    { name: 'inner fails', error: 'Error: boom', file: 'C:\\work\\demo\\test\\m.test.js', line: 4 },
  ]);
});

test('node:test TAP output leaves out a suite that failed only through its test', () => {
  const r = parseTestOutput(NODE_TAP);
  assert.deepEqual([r.passed, r.failed, r.skipped], [1, 2, 1]);
  assert.deepEqual(r.failures, [
    { name: 'subtracts', error: 'Expected values to be strictly equal:', file: 'C:\\work\\demo\\test\\m.test.js', line: 5 },
    { name: 'inner fails', error: 'boom', file: 'C:\\work\\demo\\test\\m.test.js', line: 4 },
  ]);
});

test('Jest output', () => {
  const r = parseTestOutput(JEST);
  assert.equal(r.runner, 'Jest');
  assert.deepEqual([r.passed, r.failed, r.skipped], [3, 1, 1]);
  assert.deepEqual(r.failures, [{ name: 'math > subtracts', error: 'expect(received).toBe(expected) // Object.is equality', file: 'src/math.test.js', line: 6 }]);
});

test('Vitest output, with its colours', () => {
  const r = parseTestOutput(VITEST.replace('FAIL', '\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m'));
  assert.equal(r.runner, 'Vitest');
  assert.deepEqual([r.passed, r.failed, r.skipped], [1, 1, 0]);
  assert.deepEqual(r.failures, [{ name: 'math > subtracts', error: 'AssertionError: expected 1 to be 2 // Object.is equality', file: 'test/math.test.ts', line: 7 }]);
});

test('pytest output', () => {
  const r = parseTestOutput(PYTEST);
  assert.equal(r.runner, 'pytest');
  assert.deepEqual([r.passed, r.failed, r.skipped], [2, 1, 0]);
  assert.deepEqual(r.failures, [{ name: 'test_sub', error: 'assert 1 == 2', file: 'tests/test_math.py', line: 7 }]);
});

test('cargo test output, new and old panic lines', () => {
  const r = parseTestOutput(CARGO);
  assert.equal(r.runner, 'cargo test');
  assert.deepEqual([r.passed, r.failed, r.skipped], [1, 1, 0]);
  assert.deepEqual(r.failures, [{ name: 'tests::subs', error: 'assertion `left == right` failed', file: 'src/lib.rs', line: 12 }]);
  const old = CARGO.replace("panicked at src/lib.rs:12:9:\nassertion `left == right` failed", "panicked at 'boom', src/lib.rs:30:5");
  assert.deepEqual(parseTestOutput(old).failures[0], { name: 'tests::subs', error: 'boom', file: 'src/lib.rs', line: 30 });
});

test('a passing run has counts and no failures; other output is not a test run', () => {
  const r = parseTestOutput('ℹ tests 3\nℹ pass 3\nℹ fail 0\nℹ skipped 0\n');
  assert.deepEqual(r, { runner: 'node:test', passed: 3, failed: 0, skipped: 0, failures: [] });
  assert.equal(parseTestOutput('Compiled 12 files.\nDone in 1.2s'), null);
  assert.equal(parseTestOutput(''), null);
  assert.equal(parseTestOutput(null), null);
});

test('every agent type\'s command output reaches the result card', () => {
  const main = read('src/main/main.ts');
  assert.match(main, /function commandOutput\(runId: number, text: unknown\)/);
  assert.equal((main.match(/commandOutput\((?:runId|ctx\.runId), /g) ?? []).length, 3, 'Claude Code Bash results, Codex commands, local run_command');
  const teams = read('src/renderer/breeze/teams.ts');
  assert.match(teams, /tests: \(r, ev, tab\) => testsCard\(r, ev, tab\)/);
  assert.match(teams, /data-test-line/);
  // Claude Code on Windows runs commands with PowerShell too: it is allowed in build mode and its output is read.
  assert.match(main, /CLAUDE_SHELL_TOOLS = \['Bash', 'PowerShell'\]/);
  assert.match(main, /'--allowedTools', \.\.\.CLAUDE_SHELL_TOOLS/);
});

test('capture_preview reaches every agent type that can take a tool, and saves outside the project', () => {
  const { BREEZE_TOOLS } = require('../src/main/breezemcp');
  assert.ok(BREEZE_TOOLS.some(t => t.name === 'capture_preview'), 'Claude Code and Codex, through Breeze\'s MCP server');
  const main = read('src/main/main.ts');
  assert.match(main, /name: 'capture_preview'/, 'local models');
  assert.match(main, /capture_preview: \(ctx, a\) => capturePreview\(/);
  assert.match(main, /const dir = path\.join\(STASH_DIR\(\), crypto\.randomUUID\(\)\);\s+await fsp\.mkdir\(dir[\s\S]{0,300}showImage\(runId, file,/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)[\s\S]{0,120}will-navigate', e => e\.preventDefault\(\)/);
});
