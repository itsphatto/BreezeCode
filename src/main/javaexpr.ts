// A small Java expression evaluator for the Java debugger (debugJava.ts). JDWP itself has no evaluator, so the
// watch list, the console and breakpoint conditions are read here: literals, variables and fields (a.b, arr[i],
// arr.length), arithmetic, comparisons, && || !, ?:, string concatenation and String's side-effect-free methods.
// Other method calls would need the JVM to run code (JDWP InvokeMethod) and are refused with a clear message.
// Differences from Java, on purpose: == on two Strings compares their text, and long values are JS numbers
// (exact up to 2^53).
import type { DebugValue } from './debugTypes';

export interface Val { type: string; value: unknown; row?: DebugValue }
export interface Resolver {
  name(id: string): Promise<Val>;            // a local, or a field of `this`
  field(of: Val, name: string): Promise<Val>;
  element(of: Val, index: number): Promise<Val>;
}

type Node =
  | { k: 'lit'; v: Val }
  | { k: 'name'; id: string }
  | { k: 'field'; of: Node; name: string }
  | { k: 'index'; of: Node; index: Node }
  | { k: 'call'; of: Node; name: string; args: Node[] }
  | { k: 'unary'; op: string; arg: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'cond'; test: Node; yes: Node; no: Node };

// ---- tokens ----
const TOKEN = /\s*(?:(0[xX][\da-fA-F]+[lL]?|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?[lLfFdD]?)|("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)+')|([A-Za-z_$][\w$]*)|(\|\||&&|==|!=|<=|>=|[-+*/%<>!()[\].,?:]))/y;
interface Tok { num?: string; str?: string; chr?: string; id?: string; op?: string; at: number }
function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(TOKEN.lastIndex))) break;
    const from = TOKEN.lastIndex;
    const m = TOKEN.exec(src);
    if (!m) { const at = src.length - src.slice(from).trimStart().length; throw new Error(`Unexpected "${src[at]}" at ${at + 1}`); }
    out.push({ num: m[1], str: m[2], chr: m[3], id: m[4], op: m[5], at: TOKEN.lastIndex - m[0].trimStart().length });
  }
  return out;
}
// The body of a "string" or 'c' literal: Java's escapes are JSON's, plus \' (and a bare " inside a char).
function unescape(body: string): string {
  try { return JSON.parse('"' + body.replace(/\\(.)|"/g, (m, esc) => (esc === undefined ? '\\"' : esc === "'" ? "'" : m)) + '"'); } catch { throw new Error(`Bad escape in ${body}`); }
}

// ---- parser (lowest precedence first) ----
export function parse(src: string): Node {
  const toks = tokenize(src);
  let i = 0;
  const peek = (op: string) => toks[i]?.op === op;
  const eat = (op: string) => { if (!peek(op)) throw new Error(toks[i] ? `Expected "${op}" at ${toks[i].at + 1}` : `Expected "${op}" at the end`); i++; };
  const binary = (ops: string[], next: () => Node) => (): Node => {
    let a = next();
    while (toks[i]?.op && ops.includes(toks[i].op!)) { const op = toks[i++].op!; a = { k: 'bin', op, a, b: next() }; }
    return a;
  };
  const primary = (): Node => {
    const t = toks[i++];
    if (!t) throw new Error('The expression ends too soon');
    if (t.num !== undefined) return { k: 'lit', v: numberLit(t.num) };
    if (t.str !== undefined) return { k: 'lit', v: { type: 'String', value: unescape(t.str.slice(1, -1)) } };
    if (t.chr !== undefined) {
      const s = unescape(t.chr.slice(1, -1));
      if (s.length !== 1) throw new Error(`${t.chr} isn't one character`);
      return { k: 'lit', v: { type: 'char', value: s.charCodeAt(0) } };
    }
    if (t.id === 'true' || t.id === 'false') return { k: 'lit', v: { type: 'boolean', value: t.id === 'true' } };
    if (t.id === 'null') return { k: 'lit', v: { type: 'null', value: null } };
    if (t.id !== undefined) return { k: 'name', id: t.id };
    if (t.op === '(') { const e = cond(); eat(')'); return e; }
    throw new Error(`Unexpected "${t.op}" at ${t.at + 1}`);
  };
  const postfix = (): Node => {
    let e = primary();
    for (;;) {
      if (peek('.')) {
        i++;
        const name = toks[i++]?.id;
        if (!name) throw new Error('Expected a name after "."');
        if (peek('(')) {
          i++;
          const args: Node[] = [];
          if (!peek(')')) { do args.push(cond()); while (peek(',') && ++i); }
          eat(')');
          e = { k: 'call', of: e, name, args };
        } else e = { k: 'field', of: e, name };
      } else if (peek('[')) { i++; const index = cond(); eat(']'); e = { k: 'index', of: e, index }; }
      else return e;
    }
  };
  const unary = (): Node => (peek('!') || peek('-') || peek('+') ? { k: 'unary', op: toks[i++].op!, arg: unary() } : postfix());
  const mul = binary(['*', '/', '%'], unary);
  const add = binary(['+', '-'], mul);
  const rel = binary(['<', '<=', '>', '>='], add);
  const eq = binary(['==', '!='], rel);
  const and = binary(['&&'], eq);
  const or = binary(['||'], and);
  const cond = (): Node => {
    const test = or();
    if (!peek('?')) return test;
    i++;
    const yes = cond();
    eat(':');
    return { k: 'cond', test, yes, no: cond() };
  };
  if (!toks.length) throw new Error('Type an expression');
  const e = cond();
  if (i < toks.length) throw new Error(`Unexpected "${toks[i].op ?? toks[i].id ?? toks[i].num ?? '…'}" at ${toks[i].at + 1}`);
  return e;
}
function numberLit(text: string): Val {
  const suffix = text.slice(-1).toLowerCase();
  if (/^0x/i.test(text)) return { type: suffix === 'l' ? 'long' : 'int', value: Number.parseInt(text.replace(/[lL]$/, ''), 16) };
  if (suffix === 'l') return { type: 'long', value: Number(text.slice(0, -1)) };
  if (suffix === 'f') return { type: 'float', value: Number(text.slice(0, -1)) };
  if (suffix === 'd') return { type: 'double', value: Number(text.slice(0, -1)) };
  return { type: /[.eE]/.test(text) ? 'double' : 'int', value: Number(text) };
}

// ---- values ----
const INTS: Record<string, string> = { int: 'int', short: 'int', byte: 'int', Integer: 'int', Short: 'int', Byte: 'int', long: 'long', Long: 'long' };
const FLOATS: Record<string, string> = { float: 'float', Float: 'float', double: 'double', Double: 'double' };
// A row the debugger shows (debugJava.show) as a value to compute with.
export function fromRow(row: DebugValue): Val {
  const { type, value } = row;
  if (type === '' && value === 'null') return { type: 'null', value: null, row };
  if (type === 'String') return { type, value: JSON.parse(value), row };
  if (type === 'boolean' || type === 'Boolean') return { type: 'boolean', value: value === 'true', row };
  if (type === 'char' || type === 'Character') return { type: 'char', value: (JSON.parse('"' + value.slice(1, -1) + '"') as string).charCodeAt(0), row };
  if (INTS[type]) return { type: INTS[type], value: Number(value), row };
  if (FLOATS[type]) return { type: FLOATS[type], value: Number(value), row };
  return { type, value: null, row }; // an object or array: its row has the ref to read it by
}
export function show(v: Val): string {
  if (v.row && v.type !== 'String' && !isPrim(v)) return v.row.value;
  if (v.type === 'null') return 'null';
  if (v.type === 'String') return JSON.stringify(v.value);
  if (v.type === 'char') return `'${String.fromCharCode(v.value as number)}'`;
  return String(v.value);
}
const isNum = (v: Val) => v.type === 'int' || v.type === 'long' || v.type === 'float' || v.type === 'double' || v.type === 'char';
const isPrim = (v: Val) => isNum(v) || v.type === 'boolean';
const isArray = (v: Val) => v.type.endsWith('[]');
const textOf = (v: Val | undefined): string => (!v ? '' : v.type === 'String' ? (v.value as string) : v.type === 'char' ? String.fromCharCode(v.value as number) : v.type === 'null' ? 'null' : isPrim(v) ? String(v.value) : v.row?.value ?? '');
function num(v: Val | undefined, op: string): number {
  if (!v) throw new Error(`${op} is missing a number`);
  if (!isNum(v)) throw new Error(`${op} needs numbers, not ${v.type === 'null' ? 'null' : v.type}`);
  return v.value as number;
}
function bool(v: Val, what: string): boolean {
  if (v.type !== 'boolean') throw new Error(`${what} needs true or false, not ${show(v)}`);
  return v.value as boolean;
}
// Java's binary numeric promotion: double > float > long > int (char and short count as int).
const promote = (a: Val, b: Val) => (a.type === 'double' || b.type === 'double' ? 'double' : a.type === 'float' || b.type === 'float' ? 'float' : a.type === 'long' || b.type === 'long' ? 'long' : 'int');
function arith(op: string, a: Val, b: Val): Val {
  const type = promote(a, b);
  const x = num(a, op), y = num(b, op);
  const whole = type === 'int' || type === 'long';
  if (whole && (op === '/' || op === '%') && y === 0) throw new Error('ArithmeticException: / by zero');
  let r = op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : op === '/' ? x / y : x % y;
  if (whole) r = Math.trunc(r);
  if (type === 'int') r |= 0; // wraps like a Java int
  if (type === 'float') r = Math.fround(r);
  return { type, value: r };
}
function equal(a: Val, b: Val): boolean {
  if (isNum(a) && isNum(b)) return a.value === b.value;
  if (a.type === 'boolean' && b.type === 'boolean') return a.value === b.value;
  if (a.type === 'null' || b.type === 'null') return a.type === b.type;
  if (a.type === 'String' && b.type === 'String') return a.value === b.value;
  throw new Error(`Can't compare ${show(a)} and ${show(b)} with ==: compare their fields instead`);
}

const STRING_METHODS: Record<string, (s: string, args: (Val | undefined)[]) => Val> = {
  length: s => ({ type: 'int', value: s.length }),
  isEmpty: s => ({ type: 'boolean', value: s.length === 0 }),
  isBlank: s => ({ type: 'boolean', value: s.trim().length === 0 }),
  equals: (s, [x]) => ({ type: 'boolean', value: x?.type === 'String' && x.value === s }),
  equalsIgnoreCase: (s, [x]) => ({ type: 'boolean', value: x?.type === 'String' && (x.value as string).toLowerCase() === s.toLowerCase() }),
  contains: (s, [x]) => ({ type: 'boolean', value: s.includes(textOf(x)) }),
  startsWith: (s, [x]) => ({ type: 'boolean', value: s.startsWith(textOf(x)) }),
  endsWith: (s, [x]) => ({ type: 'boolean', value: s.endsWith(textOf(x)) }),
  indexOf: (s, [x]) => ({ type: 'int', value: s.indexOf(textOf(x)) }),
  charAt: (s, [x]) => {
    const n = num(x, 'charAt');
    if (n < 0 || n >= s.length) throw new Error(`StringIndexOutOfBoundsException: index ${n}, length ${s.length}`);
    return { type: 'char', value: s.charCodeAt(n) };
  },
  trim: s => ({ type: 'String', value: s.trim() }),
  toUpperCase: s => ({ type: 'String', value: s.toUpperCase() }),
  toLowerCase: s => ({ type: 'String', value: s.toLowerCase() }),
  substring: (s, [a, b]) => ({ type: 'String', value: s.substring(num(a, 'substring'), b ? num(b, 'substring') : undefined) }),
};
const ARITY: Record<string, number> = { equals: 1, equalsIgnoreCase: 1, contains: 1, startsWith: 1, endsWith: 1, indexOf: 1, charAt: 1 };

export async function evaluate(node: Node, r: Resolver): Promise<Val> {
  const ev = (n: Node) => evaluate(n, r);
  switch (node.k) {
    case 'lit': return node.v;
    case 'name': return r.name(node.id);
    case 'field': {
      const of = await ev(node.of);
      if (of.type === 'null') throw new Error(`NullPointerException: reading .${node.name} of null`);
      if (isArray(of) && node.name === 'length') return { type: 'int', value: Number(/\[(\d+)\]$/.exec(of.row?.value ?? '')?.[1] ?? 0) };
      if (isPrim(of) || of.type === 'String') throw new Error(`${show(of)} has no field ${node.name}`);
      return r.field(of, node.name);
    }
    case 'index': {
      const of = await ev(node.of);
      if (of.type === 'null') throw new Error('NullPointerException: indexing null');
      if (!isArray(of)) throw new Error(`${show(of)} isn't an array`);
      const n = num(await ev(node.index), 'An index');
      if (!Number.isInteger(n)) throw new Error('An index must be a whole number');
      return r.element(of, n);
    }
    case 'call': {
      const of = await ev(node.of);
      if (of.type === 'null') throw new Error(`NullPointerException: calling ${node.name}() on null`);
      const method = of.type === 'String' ? STRING_METHODS[node.name] : undefined;
      if (!method) throw new Error(`Java's debugger can't run methods (${node.name}()). Strings can use length(), equals(), contains(), startsWith(), isEmpty() and similar`);
      const args = [];
      for (const a of node.args) args.push(await ev(a));
      if (ARITY[node.name] !== undefined && args.length !== ARITY[node.name]) throw new Error(`${node.name}() takes ${ARITY[node.name]} argument`);
      return method(of.value as string, args);
    }
    case 'unary': {
      const v = await ev(node.arg);
      if (node.op === '!') return { type: 'boolean', value: !bool(v, '!') };
      const n = num(v, node.op);
      const type = v.type === 'char' ? 'int' : v.type;
      return { type, value: node.op === '-' ? (type === 'int' ? -n | 0 : -n) : n };
    }
    case 'cond': return bool(await ev(node.test), 'The ?: test') ? ev(node.yes) : ev(node.no);
    case 'bin': {
      const { op } = node;
      if (op === '&&') return { type: 'boolean', value: bool(await ev(node.a), '&&') && bool(await ev(node.b), '&&') };
      if (op === '||') return { type: 'boolean', value: bool(await ev(node.a), '||') || bool(await ev(node.b), '||') };
      const a = await ev(node.a), b = await ev(node.b);
      if (op === '+' && (a.type === 'String' || b.type === 'String')) return { type: 'String', value: textOf(a) + textOf(b) };
      if (op === '==' || op === '!=') return { type: 'boolean', value: equal(a, b) === (op === '==') };
      if (op === '<' || op === '<=' || op === '>' || op === '>=') {
        const x = num(a, op), y = num(b, op);
        return { type: 'boolean', value: op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y };
      }
      return arith(op, a, b);
    }
  }
}

// A breakpoint's hit count, as the page writes it: a bare number (from that hit on), or >=, >, ==, <, <=, % and a number.
const HIT_RE = /^\s*(>=|<=|==|=|>|<|%)?\s*(\d+)\s*$/;
export function hitMatches(hitCondition: string, hits: number): boolean | null {
  const m = HIT_RE.exec(hitCondition);
  if (!m) return null;
  const n = Number(m[2]);
  switch (m[1] || '>=') {
    case '>=': return hits >= n;
    case '>': return hits > n;
    case '==': case '=': return hits === n;
    case '<': return hits < n;
    case '<=': return hits <= n;
    default: return n > 0 && hits % n === 0;
  }
}
// A logpoint's text with each {expression} filled in; one that fails shows its error in place.
export async function formatLog(msg: string, r: Resolver): Promise<string> {
  let out = '';
  for (const seg of msg.split(/(\{[^{}]*\})/)) {
    if (/^\{[^{}]*\}$/.test(seg) && seg.slice(1, -1).trim()) {
      try { out += textOf(await evaluate(parse(seg.slice(1, -1)), r)); } catch (e) { out += `<error: ${(e as Error).message}>`; }
    } else out += seg;
  }
  return out;
}
// Why a condition or log message wouldn't parse, or null. Parses only: nothing is read from the program.
export function checkJavaBp(bp: { condition?: string; hitCondition?: string; logMessage?: string }): string | null {
  const cond = (bp.condition || '').trim().replace(/;$/, '');
  if (cond) { try { parse(cond); } catch (e) { return `Condition: ${(e as Error).message}`; } }
  for (const seg of (bp.logMessage || '').split(/(\{[^{}]*\})/)) {
    if (!/^\{[^{}]*\}$/.test(seg) || !seg.slice(1, -1).trim()) continue;
    try { parse(seg.slice(1, -1)); } catch (e) { return `Log message ${seg}: ${(e as Error).message}`; }
  }
  if ((bp.hitCondition || '').trim() && hitMatches(bp.hitCondition!, 0) === null) return `Hit count "${bp.hitCondition}": use a number, or an operator (>=, >, ==, %) and a number`;
  return null;
}
