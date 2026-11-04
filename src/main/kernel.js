// Notebook kernels: one Python process per open notebook (runtime/breeze_kernel.py), so a cell's variables are
// there for the next. Requests and replies are JSON lines; every reply names its request's id.
// Emits 'message' (notebook, msg) for each reply and 'state' (notebook, 'idle' | 'busy' | 'dead').
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

class Kernels extends EventEmitter {
  // `python()` resolves to { cmd, env } for the Python to run (the one F5 uses).
  constructor({ script, python }) {
    super();
    this.script = script;
    this.python = python;
    this.kernels = new Map(); // notebook → { child, queue: [id], buf }
  }

  async start(nb, cwd) {
    const old = this.kernels.get(nb);
    if (old && !old.dead) return old;
    const { cmd, env } = await this.python();
    const child = spawn(cmd, ['-u', this.script], { cwd, env: { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const k = { child, pending: new Set(), buf: '', dead: false, err: '' };
    this.kernels.set(nb, k);
    const dec = new StringDecoder('utf8');
    child.stdout.on('data', b => {
      k.buf += dec.write(b);
      for (let i = k.buf.indexOf('\n'); i !== -1; i = k.buf.indexOf('\n')) {
        const line = k.buf.slice(0, i);
        k.buf = k.buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'done') k.pending.delete(msg.id);
        this.emit('message', nb, msg);
        if (msg.type === 'done' && !k.pending.size) this.emit('state', nb, 'idle');
      }
    });
    // Python's own errors before the kernel runs (a bad interpreter, say); a cell's errors come as messages.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', t => { k.err = (k.err + t).slice(-4000); });
    child.stdin.on('error', () => { /* the kernel ended */ });
    const gone = e => {
      if (k.dead) return;
      k.dead = true;
      const why = e?.code === 'ENOENT' ? `Python wasn't found (${cmd})` : k.err.trim() || 'The kernel stopped';
      for (const id of k.pending) {
        this.emit('message', nb, { id, type: 'error', ename: 'KernelDied', evalue: why, traceback: [why] });
        this.emit('message', nb, { id, type: 'done' });
      }
      k.pending.clear();
      if (this.kernels.get(nb) === k) this.kernels.delete(nb);
      this.emit('state', nb, 'dead');
    };
    child.on('error', gone);
    child.on('exit', () => gone());
    return k;
  }

  async run(nb, cwd, id, code) {
    const k = await this.start(nb, cwd);
    if (k.dead) throw new Error(k.err.trim() || 'The kernel stopped');
    k.pending.add(id);
    this.emit('state', nb, 'busy');
    k.child.stdin.write(JSON.stringify({ id, code: String(code) }) + '\n');
  }

  // Stopping a cell stops the kernel (its variables go too): Windows has no gentle way to interrupt a child.
  stop(nb) {
    const k = this.kernels.get(nb);
    if (!k) return;
    this.kernels.delete(nb);
    k.child.kill();
  }
  stopAll() { for (const nb of [...this.kernels.keys()]) this.stop(nb); }
}

module.exports = { Kernels };
