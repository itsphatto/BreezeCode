import { spawn, execFile, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
/**
 * Base error class for all Antigravity Agent errors.
 */
export class AntigravityAgentError extends Error {
    code;
    details;
    constructor(message, code = 'AGENT_ERROR', details) {
        super(message);
        this.name = 'AntigravityAgentError';
        this.code = code;
        this.details = details;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
/**
 * Error thrown or emitted when authentication has expired or credentials are required.
 */
export class AntigravityAuthError extends AntigravityAgentError {
    authEvent;
    constructor(authEvent) {
        super(`Antigravity authentication required: ${authEvent.reason}`, 'AUTH_REQUIRED', authEvent);
        this.name = 'AntigravityAuthError';
        this.authEvent = authEvent;
    }
}
/**
 * Error thrown when an agent operation (startup, request, shutdown) exceeds its timeout.
 */
export class AntigravityTimeoutError extends AntigravityAgentError {
    timeoutMs;
    operation;
    constructor(message, timeoutMs, operation) {
        super(message, 'TIMEOUT', { timeoutMs, operation });
        this.name = 'AntigravityTimeoutError';
        this.timeoutMs = timeoutMs;
        this.operation = operation;
    }
}
/**
 * Error thrown when the agent child process terminates unexpectedly or exits with a non-zero code.
 */
export class AntigravityProcessError extends AntigravityAgentError {
    exitCode;
    signal;
    stderrSummary;
    constructor(message, exitCode, signal, stderrSummary) {
        super(message, 'PROCESS_ERROR', { exitCode, signal, stderrSummary });
        this.name = 'AntigravityProcessError';
        this.exitCode = exitCode;
        this.signal = signal;
        this.stderrSummary = stderrSummary;
    }
}
/**
 * Regex patterns representing non-fatal telemetry, OpenTelemetry, diagnostic, or runtime chatter.
 * These lines arriving on stderr must NEVER crash or freeze the session.
 */
const NON_FATAL_STDERR_PATTERNS = [
    // OpenTelemetry / metrics / tracing logs
    /\[?(?:otel|telemetry|tracing)\]?/i,
    /\b(?:trace_id|span_id|otel\.trace_id|otel\.span_id)\s*=/i,
    /exporting\s+(?:traces|metrics|logs)/i,
    /open-telemetry/i,
    /exporter/i,
    // Common log level markers & JSON log formats
    /^\[?(?:DEBUG|INFO|TRACE|VERBOSE)\]?/i,
    /\blevel\s*=\s*['"]?(?:debug|info|trace|verbose)['"]?/i,
    /\{\s*"level"\s*:\s*"(?:debug|info|trace|verbose)"/i,
    // Node / Electron runtime messages and warnings
    /\(node:\d+\)\s*(?:ExperimentalWarning|DeprecationWarning):/i,
    /DevTools listening on\s+ws:\/\//i,
    /GPU process|GpuChannelHost|viz_main_impl|gl_surface|DirectX/i,
    /\[\d+:\d+\/\d+\.\d+:ERROR:/i, // Chromium/Electron standard stderr noise
    /GOMAXPROCS/i,
    // gRPC internal transport and keepalive chatter
    /\bGRPC_GO_LOG\b/i,
    /transport:\s*(?:loas|http2Client|keepalive)/i,
    /subchannel\s+(?:connecting|connected|ready)/i,
    /pick_first:\s+selected/i,
    /connectivity\s+state\s+changed/i,
];
/**
 * Regex patterns identifying authentication expiration, unauthorized responses, or login prompts.
 */
const AUTH_PATTERNS = [
    { pattern: /\bauth_expired\b/i, reason: 'auth_expired' },
    { pattern: /\b(?:UNAUTHENTICATED|unauthenticated)\b/i, reason: 'unauthenticated' },
    { pattern: /\b(?:HTTP\s*)?401\b/i, reason: 'http_401' },
    { pattern: /\b(?:HTTP\s*)?403\b.*(?:token|auth|permission|access|credential|unauthorized)/i, reason: 'permission_denied' },
    { pattern: /\btoken\s*(?:is\s*)?(?:expired|invalid|revoked)\b/i, reason: 'token_expired' },
    { pattern: /\b(?:please\s+)?login\s+required\b/i, reason: 'login_required' },
    { pattern: /\bnot\s+logged\s+in\b/i, reason: 'not_logged_in' },
    { pattern: /\b['"`]?(?:agy|antigravity)\s+(?:auth\s+)?login['"`]?/i, reason: 'login_command_required' },
    { pattern: /\boauth2?:\s*(?:cannot\s+fetch\s+token|token\s+expired)/i, reason: 'oauth_token_expired' },
    { pattern: /\bcredentials?\s+(?:expired|invalid|missing)\b/i, reason: 'credentials_invalid' },
];
/**
 * Regex for extracting OAuth or Google sign-in URLs.
 */
const AUTH_URL_PATTERN = /https?:\/\/(?:accounts\.google\.com|oauth2\.googleapis\.com|antigravity\.google|[a-zA-Z0-9.-]+\.google\.com\/[^\s"'>]*auth)[^\s"'>]*/i;
/**
 * Regex for extracting CLI login commands (e.g. 'agy login', 'antigravity auth login').
 */
const AUTH_COMMAND_PATTERN = /(?:agy|antigravity)\s+(?:auth\s+)?login(?:\s+--?[\w-]+)*/i;
/**
 * AntigravityAgentService
 *
 * Manages an Antigravity AI Agent subprocess with:
 * 1. Stream Isolation & Parsing (separated stdout/stderr, telemetry filtering, JSON-RPC & raw chunking).
 * 2. Auth Failure Detection & Graceful Fallback (scans streams, emits 'auth-required', triggerExternalAuth).
 * 3. Session Lifecycle (startup timeout, abrupt disconnect handling, graceful shutdown with force-kill fallback).
 */
export class AntigravityAgentService extends EventEmitter {
    status = 'idle';
    child = null;
    options = {};
    // Stream Buffers
    stdoutBuffer = '';
    stderrBuffer = '';
    recentStderrLogs = [];
    lastAuthEvent = null;
    accumulatedText = '';
    lastEmittedText = '';
    sessionId = '';
    // Lifecycle Timers & Requests
    startupTimer = null;
    isStopping = false;
    nextRequestId = 1;
    pendingRequests = new Map();
    constructor(options) {
        super();
        if (options) {
            this.options = { ...options };
        }
    }
    /**
     * Current session lifecycle status.
     */
    getStatus() {
        return this.status;
    }
    /**
     * Reference to the underlying Node.js ChildProcess, if active.
     */
    getChildProcess() {
        return this.child;
    }
    /**
     * The most recently detected authentication requirement event, if any.
     */
    getLastAuthEvent() {
        return this.lastAuthEvent;
    }
    /**
     * Recent lines collected from stderr (filtered and unfiltered).
     */
    getRecentStderr(count = 50) {
        return this.recentStderrLogs.slice(-count);
    }
    /**
     * Starts the Antigravity Agent subprocess.
     */
    async start(options) {
        if (this.status === 'running' || this.status === 'starting') {
            throw new AntigravityAgentError(`Cannot start Antigravity agent: session is already in state '${this.status}'.`, 'SESSION_ALREADY_ACTIVE');
        }
        if (options) {
            this.options = { ...this.options, ...options };
        }
        const execPath = this.options.executablePath || AntigravityAgentService.findExecutable();
        if (!execPath) {
            const err = new AntigravityAgentError('Antigravity executable could not be found. Please ensure Antigravity IDE or the agy CLI is installed.', 'EXECUTABLE_NOT_FOUND');
            this.setStatus('error');
            this.emit('error', err);
            throw err;
        }
        this.setStatus('starting');
        this.isStopping = false;
        this.stdoutBuffer = '';
        this.stderrBuffer = '';
        this.recentStderrLogs = [];
        this.lastAuthEvent = null;
        this.accumulatedText = '';
        this.lastEmittedText = '';
        this.sessionId = this.options.sessionId || '';
        const startupTimeoutMs = this.options.startupTimeoutMs ?? 15000;
        const baseCwd = this.options.cwd || process.cwd();
        const isWindows = process.platform === 'win32';
        // Prepare command-line arguments
        const args = this.buildSpawnArgs(execPath);
        // Merge environment variables
        const env = {
            ...process.env,
            ...this.options.env,
            ANTIGRAVITY_AGENT_SESSION: '1',
            // Suppress color escape codes in stream output to keep parser clean
            NO_COLOR: '1',
            FORCE_COLOR: '0',
        };
        return new Promise((resolve, reject) => {
            let settled = false;
            const finishStartup = (err) => {
                if (settled)
                    return;
                settled = true;
                if (this.startupTimer) {
                    clearTimeout(this.startupTimer);
                    this.startupTimer = null;
                }
                if (err) {
                    this.setStatus('error');
                    reject(err);
                }
                else {
                    this.setStatus('running');
                    resolve();
                }
            };
            // Set startup timeout timer
            this.startupTimer = setTimeout(() => {
                const stderrSnippet = this.recentStderrLogs.slice(-5).join('; ');
                const timeoutErr = new AntigravityTimeoutError(`Antigravity agent failed to start within ${startupTimeoutMs}ms. ${stderrSnippet ? `Stderr: ${stderrSnippet}` : ''}`, startupTimeoutMs, 'startup');
                this.stop().catch(() => { });
                finishStartup(timeoutErr);
            }, startupTimeoutMs);
            try {
                const spawnOptions = {
                    cwd: baseCwd,
                    env,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsHide: true,
                };
                // On Windows, .bat/.cmd scripts must run through cmd.exe, so the command line is quoted for it (see cmdLine)
                let child;
                if (isWindows && /\.(?:bat|cmd)$/i.test(execPath)) {
                    const line = AntigravityAgentService.cmdLine(execPath, args);
                    child = spawn(line.file, line.args, { ...spawnOptions, ...line.options });
                }
                else {
                    child = spawn(execPath, args, spawnOptions);
                }
                this.child = child;
                // Configure stream encoding for UTF-8 isolation
                child.stdout?.setEncoding('utf8');
                child.stderr?.setEncoding('utf8');
                // Setup stream listeners
                this.setupStreams(child, finishStartup);
                // Send initial prompt if provided in options
                if (this.options.prompt && child.stdin && !child.stdin.destroyed) {
                    try {
                        child.stdin.write(this.options.prompt + '\n');
                    }
                    catch {
                        // Process may exit before reading prompt; its exit handler will catch this
                    }
                }
                // Check if process spawned and remains running after a microtick
                setImmediate(() => {
                    if (child.exitCode !== null) {
                        const code = child.exitCode;
                        finishStartup(new AntigravityProcessError(`Antigravity agent exited immediately with code ${code}`, code, null, this.recentStderrLogs.slice(-6).join('\n')));
                    }
                    else if (!settled) {
                        // Process successfully spawned and stdio channels connected
                        finishStartup();
                    }
                });
            }
            catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                finishStartup(new AntigravityAgentError(`Failed to spawn Antigravity agent: ${error.message}`, 'SPAWN_ERROR', error));
            }
        });
    }
    /**
     * Sends raw string data to the agent's stdin.
     */
    async send(payload) {
        if (!this.child || !this.child.stdin || this.child.stdin.destroyed || this.status !== 'running') {
            throw new AntigravityAgentError(`Cannot send data: agent is not running (status: ${this.status}).`, 'SESSION_NOT_RUNNING');
        }
        return new Promise((resolve, reject) => {
            this.child.stdin.write(payload, 'utf8', (err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
    }
    /**
     * Sends a structured JSON or JSON-RPC message to the agent.
     */
    async sendJson(message) {
        const json = JSON.stringify(message);
        // LSP-compliant header or newline-delimited depending on protocol
        await this.send(`${json}\n`);
    }
    /**
     * Sends a JSON-RPC request and returns a Promise for the response.
     */
    async sendRequest(method, params, timeoutMs = 30000) {
        const id = this.nextRequestId++;
        const request = {
            jsonrpc: '2.0',
            id,
            method,
            params,
        };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new AntigravityTimeoutError(`JSON-RPC request '${method}' (id: ${id}) timed out after ${timeoutMs}ms`, timeoutMs, `request:${method}`));
            }, timeoutMs);
            this.pendingRequests.set(id, {
                resolve: resolve,
                reject,
                timer,
            });
            this.sendJson(request).catch((err) => {
                clearTimeout(timer);
                this.pendingRequests.delete(id);
                reject(err);
            });
        });
    }
    /**
     * Gracefully stops the agent session, falling back to force-kill after a grace period.
     */
    async stop(forceTimeoutMs) {
        if (this.status === 'stopped' || this.status === 'idle') {
            return;
        }
        this.isStopping = true;
        this.setStatus('stopping');
        if (this.startupTimer) {
            clearTimeout(this.startupTimer);
            this.startupTimer = null;
        }
        const child = this.child;
        if (!child || child.exitCode !== null) {
            this.cleanupChildProcess();
            this.setStatus('stopped');
            return;
        }
        const graceMs = forceTimeoutMs ?? this.options.shutdownTimeoutMs ?? 3000;
        return new Promise((resolve) => {
            let forceKillTimer = null;
            const onExit = () => {
                if (forceKillTimer) {
                    clearTimeout(forceKillTimer);
                    forceKillTimer = null;
                }
                this.cleanupChildProcess();
                this.setStatus('stopped');
                resolve();
            };
            child.once('exit', onExit);
            // Attempt graceful shutdown: end stdin and send SIGTERM
            try {
                if (child.stdin && !child.stdin.destroyed) {
                    child.stdin.end();
                }
                child.kill('SIGTERM');
            }
            catch {
                // Child might already be dead
            }
            // Fallback timer: if the process does not exit in grace period, force kill it
            forceKillTimer = setTimeout(() => {
                if (child.exitCode === null) {
                    this.emit('warning', `Agent did not terminate within ${graceMs}ms; force killing process PID ${child.pid}...`);
                    this.forceKillProcessTree(child.pid);
                }
            }, graceMs);
        });
    }
    /**
     * Disposes of all resources, terminates any running process, and clears listeners.
     */
    async dispose() {
        await this.stop(1000);
        this.clearAllPendingRequests('Session disposed');
        this.removeAllListeners();
    }
    /**
     * Triggers the user's default external browser safely to complete OAuth authentication
     * without blocking the IDE or sidebar child process.
     *
     * @param url Optional target URL to open; defaults to the last captured auth URL.
     */
    async triggerExternalAuth(url) {
        const targetUrl = url || this.lastAuthEvent?.url;
        if (!targetUrl) {
            this.emit('warning', 'triggerExternalAuth called without a target URL and no auth URL was captured.');
            return false;
        }
        // 1. Try Electron shell.openExternal if running inside an Electron environment
        try {
            // Check if Electron is available in main or renderer context
            const electron = typeof require !== 'undefined' ? require('electron') : null;
            if (electron?.shell?.openExternal) {
                await electron.shell.openExternal(targetUrl);
                this.emit('debug', `Opened external auth URL via Electron shell: ${targetUrl}`);
                return true;
            }
        }
        catch {
            // Electron not available or require threw; proceed to OS fallback
        }
        // 2. Fall back to detached OS-level browser opener
        return new Promise((resolve) => {
            try {
                const platform = process.platform;
                let cmd;
                let args;
                if (platform === 'win32') {
                    cmd = 'cmd.exe';
                    // start "" "url" correctly handles URLs with query parameters & ampersands
                    args = ['/c', 'start', '""', targetUrl];
                }
                else if (platform === 'darwin') {
                    cmd = 'open';
                    args = [targetUrl];
                }
                else {
                    cmd = 'xdg-open';
                    args = [targetUrl];
                }
                const opener = spawn(cmd, args, {
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: true,
                });
                opener.on('error', (err) => {
                    this.emit('warning', `Failed to launch browser via '${cmd}': ${err.message}`);
                    resolve(false);
                });
                opener.unref();
                this.emit('debug', `Opened external auth URL via OS command (${cmd}): ${targetUrl}`);
                resolve(true);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.emit('warning', `Error launching browser: ${msg}`);
                resolve(false);
            }
        });
    }
    // =========================================================================
    // Stream Isolation & Parsing Internals
    // =========================================================================
    setupStreams(child, onEarlySignal) {
        // 1. STDOUT Handling: Safely handles structured JSON-RPC messages and raw string chunking
        child.stdout?.on('data', (chunk) => {
            this.handleStdoutChunk(chunk);
        });
        // 2. STDERR Handling: Stream isolation and filtering of non-fatal telemetry logs and warnings
        child.stderr?.on('data', (chunk) => {
            this.handleStderrChunk(chunk);
        });
        // 3. Process Error Handling
        child.on('error', (err) => {
            this.emit('warning', `Child process error: ${err.message}`);
            if (this.status === 'starting') {
                onEarlySignal(err);
            }
            else {
                this.emit('error', err);
            }
        });
        // 4. Process Abrupt Disconnect & Exit Handling
        child.on('close', (code, signal) => {
            this.handleProcessExit(code, signal);
        });
    }
    /**
     * Processes incoming stdout chunks. Handles both LSP Content-Length framing and
     * newline-delimited JSON or raw text.
     */
    handleStdoutChunk(chunk) {
        this.stdoutBuffer += chunk;
        this.parseStdoutBuffer();
    }
    /**
     * Robust parser for stdout buffer supporting:
     * - Content-Length: <n>\r\n\r\n{...} (LSP / JSON-RPC header framing)
     * - Line-delimited JSON payloads: {...}\n
     * - Plain string chunking
     */
    parseStdoutBuffer() {
        let progressed = true;
        while (progressed && this.stdoutBuffer.length > 0) {
            progressed = false;
            // Check for LSP / JSON-RPC header framing
            const headerMatch = /^(?:\r?\n)*Content-Length:\s*(\d+)\r?\n\r?\n/i.exec(this.stdoutBuffer);
            if (headerMatch) {
                const headerLen = headerMatch[0].length;
                const contentLength = parseInt(headerMatch[1], 10);
                if (this.stdoutBuffer.length >= headerLen + contentLength) {
                    const payload = this.stdoutBuffer.slice(headerLen, headerLen + contentLength);
                    this.stdoutBuffer = this.stdoutBuffer.slice(headerLen + contentLength);
                    progressed = true;
                    this.processParsedPayload(payload);
                    continue;
                }
                else {
                    // Awaiting full body chunk
                    break;
                }
            }
            // Check for newline-delimited message
            const newlineIndex = this.stdoutBuffer.indexOf('\n');
            if (newlineIndex !== -1) {
                const line = this.stdoutBuffer.slice(0, newlineIndex);
                this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
                progressed = true;
                this.processStdoutLine(line.trim());
            }
        }
    }
    /**
     * Processes a single parsed JSON or string payload extracted from stdout.
     */
    processParsedPayload(raw) {
        const trimmed = raw.trim();
        if (!trimmed)
            return;
        // Scan for authentication failure patterns in payload
        this.checkAndEmitAuth(trimmed);
        try {
            const parsed = JSON.parse(trimmed);
            this.dispatchJsonMessage(parsed);
        }
        catch {
            // Plain text payload
            this.emit('text', trimmed);
            this.emit('output', {
                type: 'text',
                text: trimmed,
                timestamp: Date.now(),
            });
        }
    }
    /**
     * Processes a single newline-delimited stdout line.
     */
    processStdoutLine(line) {
        if (!line)
            return;
        // Scan for authentication failure patterns
        this.checkAndEmitAuth(line);
        // Try parsing as JSON
        if ((line.startsWith('{') && line.endsWith('}')) || (line.startsWith('[') && line.endsWith(']'))) {
            try {
                const parsed = JSON.parse(line);
                this.dispatchJsonMessage(parsed);
                return;
            }
            catch {
                // Not valid JSON, fall through to raw string handling
            }
        }
        // Plain text line
        this.emit('text', line);
        this.emit('output', {
            type: 'text',
            text: line,
            timestamp: Date.now(),
        });
    }
    /**
     * Dispatches parsed JSON messages to RPC handlers and normalized event streams.
     */
    dispatchJsonMessage(msg) {
        // 1. Handle agy native stream-json event types
        if (msg && typeof msg.event === 'string') {
            if (msg.event === 'init') {
                const convId = msg.conversation_id || msg.init?.conversation_id;
                if (convId)
                    this.sessionId = convId;
                this.emit('output', {
                    type: 'session',
                    id: convId,
                    text: convId,
                    raw: msg,
                    timestamp: Date.now(),
                });
                return;
            }
            if (msg.event === 'step_update') {
                const su = msg.step_update;
                if (!su)
                    return;
                // User input echo step from agy: safely ignore so it is not treated as output/note
                if (su.step_type === 'user_input') {
                    return;
                }
                if (su.step_type === 'agent_response') {
                    if (typeof su.text_delta === 'string') {
                        this.accumulatedText += su.text_delta;
                        this.emit('text', this.accumulatedText);
                    }
                    // Only emit output text event when the response step reaches DONE
                    if (su.state === 'DONE') {
                        const turnText = this.accumulatedText.trim();
                        if (turnText && turnText !== this.lastEmittedText) {
                            this.lastEmittedText = turnText;
                            this.emit('output', {
                                type: 'text',
                                text: turnText,
                                raw: msg,
                                timestamp: Date.now(),
                            });
                        }
                        this.accumulatedText = '';
                    }
                    return;
                }
                if (su.step_type === 'tool') {
                    // If the tool execution is still starting ('ACTIVE'), skip to avoid duplicate tool cards
                    if (su.state === 'ACTIVE') {
                        return;
                    }
                    const toolName = su.tool_name || su.tool_info?.name || 'tool';
                    const params = su.tool_info?.parameters || {};
                    let label = toolName;
                    if (params.CommandLine)
                        label = `$ ${params.CommandLine}`;
                    else if (params.TargetFile || params.AbsolutePath) {
                        const p = params.TargetFile || params.AbsolutePath;
                        label = `File: ${path.basename(p)}`;
                        this.emit('output', { type: 'file', path: p, timestamp: Date.now() });
                    }
                    else if (params.Query) {
                        label = `Search: ${params.Query}`;
                    }
                    if (su.tool_info?.error) {
                        this.emit('output', {
                            type: 'note',
                            text: `Tool error (${toolName}): ${su.tool_info.error.message || ''}`,
                            timestamp: Date.now(),
                        });
                    }
                    else {
                        this.emit('output', {
                            type: 'tool',
                            kind: toolName,
                            label,
                            ok: su.state !== 'ERROR',
                            raw: msg,
                            timestamp: Date.now(),
                        });
                    }
                    return;
                }
                if (su.step_type === 'plan') {
                    this.emit('output', {
                        type: 'plan',
                        text: su.text_delta || su.content || '',
                        raw: msg,
                        timestamp: Date.now(),
                    });
                    return;
                }
                // Consume any other agy step_update cleanly
                return;
            }
            if (msg.event === 'result') {
                const res = msg.result;
                const resText = (res?.response || this.accumulatedText || '').trim();
                if (resText && resText !== this.lastEmittedText) {
                    this.lastEmittedText = resText;
                    this.emit('text', resText);
                    this.emit('output', { type: 'text', text: resText, timestamp: Date.now() });
                }
                this.accumulatedText = '';
                this.emit('output', {
                    type: 'done',
                    ok: res?.status === 'SUCCESS',
                    raw: msg,
                    timestamp: Date.now(),
                });
                return;
            }
            // Consume any other agy event (heartbeat, telemetry, etc.) without falling through
            return;
        }
        const isRpc = msg && (msg.jsonrpc === '2.0' || typeof msg.id !== 'undefined' || typeof msg.method === 'string');
        if (isRpc) {
            this.emit('jsonrpc', msg);
            // Check if this matches a pending sendRequest response
            if (typeof msg.id !== 'undefined' && this.pendingRequests.has(msg.id)) {
                const pending = this.pendingRequests.get(msg.id);
                clearTimeout(pending.timer);
                this.pendingRequests.delete(msg.id);
                if (msg.error) {
                    pending.reject(new AntigravityAgentError(msg.error.message || 'JSON-RPC call failed', String(msg.error.code || 'RPC_ERROR'), msg.error.data));
                }
                else {
                    pending.resolve(msg.result);
                }
            }
        }
        // Normalize into Breeze IDE agent event types
        const eventType = msg.t || msg.type;
        if (eventType) {
            const outputEvent = {
                type: eventType,
                text: msg.text || msg.content || (typeof msg.result === 'string' ? msg.result : undefined),
                kind: msg.kind,
                label: msg.label,
                path: msg.path || msg.file,
                ok: msg.ok,
                raw: msg,
                timestamp: Date.now(),
            };
            this.emit('output', outputEvent);
        }
        else if (typeof msg.text === 'string' && msg.text.trim()) {
            // General output event: only emit if non-empty string text is provided
            this.emit('output', {
                type: 'note',
                text: msg.text,
                raw: msg,
                timestamp: Date.now(),
            });
        }
    }
    /**
     * Handles incoming stderr data with complete stream isolation.
     * Telemetry logs, traces, and debug messages are safely filtered out so they never
     * crash or freeze the session.
     */
    handleStderrChunk(chunk) {
        this.stderrBuffer += chunk;
        const lines = this.stderrBuffer.split('\n');
        this.stderrBuffer = lines.pop() || '';
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line)
                continue;
            // Scan stderr for auth failure patterns or login URLs (very common in CLI tools)
            this.checkAndEmitAuth(line);
            // Store in rolling stderr history (capped at 200 items)
            this.recentStderrLogs.push(line);
            if (this.recentStderrLogs.length > 200) {
                this.recentStderrLogs.shift();
            }
            // Check if the line is non-fatal telemetry or debug
            if (this.isNonFatalStderr(line)) {
                this.emit('debug', line);
            }
            else {
                // Emit as a non-fatal warning so the sidebar remains responsive
                this.emit('warning', line);
            }
        }
    }
    /**
     * Determines if a stderr message is non-fatal telemetry, OpenTelemetry trace, or debug output.
     */
    isNonFatalStderr(line) {
        return NON_FATAL_STDERR_PATTERNS.some((pat) => pat.test(line));
    }
    /**
     * Scans a text line for authentication errors and emits 'auth-required' if detected.
     */
    checkAndEmitAuth(text) {
        let matchedReason = null;
        for (const { pattern, reason } of AUTH_PATTERNS) {
            if (pattern.test(text)) {
                matchedReason = reason;
                break;
            }
        }
        // Check for OAuth / Google sign-in URLs
        const urlMatch = AUTH_URL_PATTERN.exec(text);
        const cmdMatch = AUTH_COMMAND_PATTERN.exec(text);
        if (matchedReason || urlMatch) {
            const authEvent = {
                type: 'auth-required',
                reason: matchedReason || 'auth_url_detected',
                url: urlMatch ? urlMatch[0] : undefined,
                command: cmdMatch ? cmdMatch[0] : 'agy login',
                rawText: text,
                timestamp: Date.now(),
            };
            this.lastAuthEvent = authEvent;
            this.emit('auth-required', authEvent);
            this.emit('output', {
                type: 'auth-required',
                text: authEvent.rawText,
                raw: authEvent,
                timestamp: authEvent.timestamp,
            });
            if (this.options.autoOpenAuth && authEvent.url) {
                this.triggerExternalAuth(authEvent.url).catch(() => { });
            }
            return true;
        }
        return false;
    }
    /**
     * Handles process exit or unexpected termination.
     */
    handleProcessExit(code, signal) {
        const wasStopping = this.isStopping;
        this.cleanupChildProcess();
        // Flush any remaining characters in stdoutBuffer
        if (this.stdoutBuffer.trim()) {
            this.processStdoutLine(this.stdoutBuffer.trim());
            this.stdoutBuffer = '';
        }
        // Flush any accumulated text if it was not emitted before exit
        const remainingText = this.accumulatedText.trim();
        if (remainingText && remainingText !== this.lastEmittedText) {
            this.lastEmittedText = remainingText;
            this.emit('text', remainingText);
            this.emit('output', { type: 'text', text: remainingText, timestamp: Date.now() });
            this.accumulatedText = '';
        }
        this.setStatus('stopped');
        this.emit('exit', code, signal);
        if (!wasStopping && code !== 0 && code !== null) {
            // Abrupt disconnect or non-zero exit code
            if (this.lastAuthEvent) {
                // Process exited due to unresolved auth failure
                this.emit('error', new AntigravityAuthError(this.lastAuthEvent));
            }
            else {
                const stderrSummary = this.recentStderrLogs.slice(-6).join('\n');
                const err = new AntigravityProcessError(`Antigravity agent disconnected abruptly (exit code ${code}${signal ? `, signal ${signal}` : ''})`, code, signal, stderrSummary);
                this.emit('error', err);
            }
        }
        this.clearAllPendingRequests(`Process exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`);
    }
    setStatus(newStatus) {
        if (this.status !== newStatus) {
            this.status = newStatus;
            this.emit('status-change', newStatus);
        }
    }
    cleanupChildProcess() {
        if (this.child) {
            this.child.removeAllListeners();
            this.child = null;
        }
    }
    clearAllPendingRequests(reason) {
        for (const [id, req] of this.pendingRequests.entries()) {
            clearTimeout(req.timer);
            req.reject(new AntigravityAgentError(`Pending request cancelled: ${reason}`, 'REQUEST_CANCELLED'));
        }
        this.pendingRequests.clear();
    }
    forceKillProcessTree(pid) {
        if (!pid)
            return;
        if (process.platform === 'win32') {
            execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, (err) => {
                if (err) {
                    this.emit('debug', `taskkill error on PID ${pid}: ${err.message}`);
                }
            });
        }
        else {
            try {
                process.kill(pid, 'SIGKILL');
            }
            catch (err) {
                // Process might have already exited
            }
        }
    }
    buildSpawnArgs(execPath) {
        if (this.options.args && this.options.args.length > 0) {
            return this.options.args;
        }
        const mode = this.options.mode || 'plan';
        const isLangServer = /language_server/i.test(execPath);
        // If calling language_server directly, use 'agentapi' mode
        if (isLangServer) {
            return ['agentapi'];
        }
        // Default arguments for agy CLI:
        const args = [];
        // Set mode: 'auto' for build, 'plan' for plan/ask
        if (mode === 'build') {
            args.push('--mode', 'auto');
        }
        else {
            args.push('--mode', 'plan');
        }
        // Only a build run with Full access on skips agy's permission checks; ask, plan and commit messages never do
        if (mode === 'build' && this.options.fullAccess === true) {
            args.push('--dangerously-skip-permissions');
        }
        // Specify the model chosen by the user
        const model = this.options.model || 'claude-sonnet-4-6';
        args.push('--model', model);
        // Set reasoning effort only where agy accepts it (see effortFlag)
        const effort = AntigravityAgentService.effortFlag(model, this.options.effort);
        if (effort) {
            args.push('--effort', effort);
        }
        // Output format: stream-json
        args.push('--output-format', 'stream-json');
        // Resume conversation if session ID is provided
        if (this.options.sessionId) {
            args.push('--conversation', this.options.sessionId);
        }
        // Run prompt non-interactively
        if (this.options.prompt) {
            args.push('--print', this.options.prompt);
        }
        return args;
    }
    /**
     * How to run a .cmd/.bat shim with `args` through cmd.exe without it reading any of them as its own syntax
     * (& | > % ^…). Node's `shell: true` only joins the arguments with spaces, so a prompt like "a & b" ran b.
     * Each argument is quoted for the program's own parser, then every cmd.exe metacharacter is ^-escaped twice:
     * once for this command line and once more for the %* the shim passes on. cmd.exe ends a command at a line
     * break, so line breaks become spaces rather than cutting the rest of the prompt off.
     */
    static cmdLine(execPath, args) {
        if (execPath.includes('"'))
            throw new Error(`Can't run ${execPath} through cmd.exe`);
        const meta = /([()\][%!^"`<>&|;, *?])/g;
        const quote = (arg) => {
            const a = String(arg).replace(/\r?\n|\r/g, ' ')
                .replace(/(\\*)"/g, '$1$1\\"') // backslashes before a quote are doubled, the quote escaped
                .replace(/(\\*)$/, '$1$1'); // and so are trailing ones, which sit before the closing quote
            return `"${a}"`.replace(meta, '^$1').replace(meta, '^$1');
        };
        const line = [`"${execPath}"`, ...args.map(quote)].join(' ');
        const comspec = process.env.ComSpec || 'cmd.exe';
        return { file: comspec, args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } };
    }
    /**
     * The --effort value agy takes for this model, or null to leave the flag off.
     * agy rejects the flag for Claude models ("--effort is not supported") and for ids that already
     * carry their level (gemini-3.8-flash-low, gpt-oss-120b-medium: "conflicts with --effort=…"),
     * and only knows low|medium|high|xhigh|max, so Breeze's "extra" becomes "xhigh".
     */
    static effortFlag(model, effort) {
        const e = String(effort || '').toLowerCase();
        const flag = e === 'extra' ? 'xhigh' : e;
        if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(flag))
            return null;
        if (/^claude-/i.test(model) || /-(low|medium|high|xhigh|max)$/i.test(model))
            return null;
        return flag;
    }
    // =========================================================================
    // Static Discovery Helpers
    // =========================================================================
    /**
     * Searches known system paths to locate the Antigravity executable.
     */
    static findExecutable(customPath) {
        if (customPath && fs.existsSync(customPath)) {
            return customPath;
        }
        const home = os.homedir();
        const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        const isWindows = process.platform === 'win32';
        const candidatePaths = isWindows
            ? [
                // 1. Official agy CLI in AppData\Local\agy\bin
                path.join(localAppData, 'agy', 'bin', 'agy.exe'),
                // 2. Antigravity CLI in ~/.gemini
                path.join(home, '.gemini', 'antigravity-cli', 'bin', 'agy.cmd'),
                // 3. Global npm bin
                path.join(appData, 'npm', 'agy.cmd'),
                // 4. Antigravity IDE Windows CLI wrapper
                path.join(localAppData, 'Programs', 'Antigravity IDE', 'bin', 'antigravity-ide.cmd'),
                // 5. Antigravity IDE agentapi.bat wrapper
                path.join(home, '.gemini', 'antigravity-ide', 'bin', 'agentapi.bat'),
                // 6. Antigravity IDE executable
                path.join(localAppData, 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe'),
                // 7. Antigravity language server binary
                path.join(localAppData, 'Programs', 'Antigravity IDE', 'resources', 'app', 'extensions', 'antigravity', 'bin', 'language_server_windows_x64.exe'),
            ]
            : [
                // POSIX candidate paths
                path.join(home, '.gemini', 'antigravity-cli', 'bin', 'agy'),
                '/usr/local/bin/agy',
                '/opt/homebrew/bin/agy',
                path.join(home, '.gemini', 'antigravity-ide', 'bin', 'agentapi'),
                '/Applications/Antigravity IDE.app/Contents/MacOS/Antigravity IDE',
            ];
        for (const p of candidatePaths) {
            try {
                if (p && fs.existsSync(p)) {
                    return p;
                }
            }
            catch {
                // Ignore access permission errors during path probing
            }
        }
        return null;
    }
    /**
     * Fetches models supported by Antigravity CLI directly via 'agy models',
     * with fallback to standard Antigravity models.
     */
    static DEFAULT_MODELS = [
        'claude-sonnet-4-6',
        'gemini-3.8-flash-high',
        'claude-opus-4-6-thinking',
        'gemini-3.8-flash-medium',
        'gemini-3.8-flash-low',
        'gpt-oss-120b-medium',
    ];
    // Model ids from the output of 'agy models', or the defaults when it lists none.
    static parseModels(out) {
        const parsed = out.split(/\r?\n/)
            .map((l) => l.trim().split(/\s+/)[0])
            .filter((m) => m && !m.startsWith('Fetching') && !m.startsWith('Usage') && !m.startsWith('Error'));
        return parsed.length > 0 ? parsed : [...AntigravityAgentService.DEFAULT_MODELS];
    }
    static getAvailableModels(customBin) {
        const bin = customBin || AntigravityAgentService.findExecutable();
        if (!bin)
            return [...AntigravityAgentService.DEFAULT_MODELS];
        try {
            return AntigravityAgentService.parseModels(execFileSync(bin, ['models'], { encoding: 'utf8', timeout: 4000, windowsHide: true }));
        }
        catch {
            return [...AntigravityAgentService.DEFAULT_MODELS];
        }
    }
    /** Like getAvailableModels, without blocking the process while the CLI runs. */
    static getAvailableModelsAsync(customBin) {
        const bin = customBin || AntigravityAgentService.findExecutable();
        if (!bin)
            return Promise.resolve([...AntigravityAgentService.DEFAULT_MODELS]);
        return new Promise((resolve) => {
            execFile(bin, ['models'], { encoding: 'utf8', timeout: 4000, windowsHide: true }, (err, stdout) => {
                resolve(err ? [...AntigravityAgentService.DEFAULT_MODELS] : AntigravityAgentService.parseModels(stdout));
            });
        });
    }
    /**
     * Returns true if an Antigravity executable is installed and available.
     */
    static isAvailable(customPath) {
        return !!AntigravityAgentService.findExecutable(customPath);
    }
}
// Ensure CommonJS module compatibility
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AntigravityAgentService;
    Object.assign(module.exports, {
        AntigravityAgentService,
        AntigravityAgentError,
        AntigravityAuthError,
        AntigravityTimeoutError,
        AntigravityProcessError,
    });
}
export default AntigravityAgentService;
