// What the DebugManager (debug.ts) and its backends (debugPython, debugNode, debugGdb, debugJava, debugDotnet) share.
import type { DebugValue } from './cdp';

export type { DebugValue };

// A breakpoint as the editor sends it (line is 1-based).
export interface Bp { line: number; enabled?: boolean; condition?: string; hitCondition?: string; logMessage?: string }

export interface DebugFrame { id: number; name: string; file: string | null; line: number; col: number }

// An event the manager emits to the page: { type: 'state' | 'paused' | 'output' | 'breakpoints' | 'exited' | 'error', … }.
export interface DebugEvent { type: string; [key: string]: unknown }

export type DebugState = 'starting' | 'running' | 'paused' | 'stopped';

// The manager's side of a session, as a backend sees it.
export interface Host {
  root: string;
  file: string;
  stopOnEntry: boolean;
  pid(): number | null;
  bps(): Map<string, Bp[]>;
  exceptions(): string;
  emit(ev: DebugEvent): void;
  setState(state: DebugState): void;
  output(stream: 'stdout' | 'stderr' | 'console', text: string): void;
  alive(): boolean;
  warn(e: unknown): void;
  within<T>(p: Promise<T>, ms: number, what: string): Promise<T>;
  rel(abs: unknown): string | null;
}

// What a backend's prepare() hands the manager for launching the program (a port, a flag, arguments).
export interface Launch { port?: number; ts?: boolean; args?: string[]; [key: string]: unknown }

// One debugger backend: the manager spawns the process and owns its stdio; the backend speaks the debug protocol.
export interface Backend {
  cmd: string;
  env(): NodeJS.ProcessEnv;
  prepare(): Promise<Launch>;
  connect(): Promise<void>;
  stderr(text: string): string | null | undefined;
  exited?(): void;
  close(): void;
  disconnect(): Promise<void>;
  killFirst?: boolean;
  pause(): Promise<void>;
  resume(): Promise<void>;
  step(kind: string): Promise<void>;
  runTo(file: string, line: number): Promise<void>;
  setBreakpoints(file: string, bps: Bp[]): Promise<void>;
  setExceptions(mode: string): Promise<unknown>;
  scopes(frameId: number): Promise<DebugValue[]>;
  children(ref: number): Promise<DebugValue[]>;
  evaluate(expr: string, frameId: number | undefined, context: string): Promise<DebugValue>;
  setValue(ref: number, name: string, value: string): Promise<DebugValue>;
}
