"use strict";
/* ================= Terminal window ================= */
// The page of a terminal window (Terminal → New Terminal Window): a prompt, the output and the window's own buttons.
// It talks to main through its own small bridge (termPreload.js). The whole file is one function so that none of its
// names reach the global scope the main window's scripts share with it when they are type-checked together.
(() => {
    const api = window.breezeTerm;
    const el = (id) => document.getElementById(id);
    const body = el('twBody'), out = el('twOut'), line = el('twLine'), ps = el('twPs');
    const before = el('twBefore'), caret = el('twCaret'), after = el('twAfter');
    const input = el('twInput'), killBtn = el('twKill');
    const quietly = (p) => { p.catch(() => { }); };
    /* ----- Theme and font size: the main window's (Settings → Appearance), kept in step while both are open ----- */
    const read = (key, fallback) => {
        try {
            const v = localStorage.getItem(key);
            return v == null ? fallback : JSON.parse(v);
        }
        catch {
            return fallback;
        }
    };
    const applyPrefs = () => {
        const theme = read('breeze.theme', 'dark');
        document.documentElement.dataset.theme = ['dark', 'contrast', 'light'].includes(theme) ? theme : 'dark';
        const size = Math.min(24, Math.max(10, Number(read('breeze.codeSize', 13)) || 13));
        document.documentElement.style.setProperty('--code-size', `${size}px`);
    };
    applyPrefs();
    window.addEventListener('storage', e => { if (e.key === 'breeze.theme' || e.key === 'breeze.codeSize')
        applyPrefs(); });
    let style = {};
    let pendingEsc = ''; // an escape code split across two chunks
    const xterm256 = (n) => {
        if (n < 16)
            return `var(--ansi-${n})`;
        if (n < 232) {
            const v = (c) => (c ? 55 + c * 40 : 0);
            const k = n - 16;
            return `rgb(${v(Math.floor(k / 36))}, ${v(Math.floor(k / 6) % 6)}, ${v(k % 6)})`;
        }
        const g = (n - 232) * 10 + 8;
        return `rgb(${g}, ${g}, ${g})`;
    };
    function applySgr(codes) {
        for (let i = 0; i < codes.length; i++) {
            const c = codes[i];
            if (c === 0)
                style = {};
            else if (c === 1)
                style.b = true;
            else if (c === 2)
                style.d = true;
            else if (c === 3)
                style.i = true;
            else if (c === 4)
                style.u = true;
            else if (c === 22)
                style.b = style.d = false;
            else if (c === 23)
                style.i = false;
            else if (c === 24)
                style.u = false;
            else if (c >= 30 && c <= 37)
                style.fg = `var(--ansi-${c - 30})`;
            else if (c >= 90 && c <= 97)
                style.fg = `var(--ansi-${c - 82})`;
            else if (c >= 40 && c <= 47)
                style.bg = `var(--ansi-${c - 40})`;
            else if (c >= 100 && c <= 107)
                style.bg = `var(--ansi-${c - 92})`;
            else if (c === 39)
                style.fg = undefined;
            else if (c === 49)
                style.bg = undefined;
            else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
                const col = xterm256(codes[i + 2] ?? 0);
                if (c === 38)
                    style.fg = col;
                else
                    style.bg = col;
                i += 2;
            }
            else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
                const col = `rgb(${codes[i + 2] ?? 0}, ${codes[i + 3] ?? 0}, ${codes[i + 4] ?? 0})`;
                if (c === 38)
                    style.fg = col;
                else
                    style.bg = col;
                i += 4;
            }
        }
    }
    function appendText(text, cls = '') {
        if (!text)
            return;
        const plain = !cls && !style.fg && !style.bg && !style.b && !style.d && !style.i && !style.u;
        if (plain) {
            out.append(text);
            return;
        }
        const span = document.createElement('span');
        span.className = [cls, style.b && 'a-b', style.d && 'a-d', style.i && 'a-i', style.u && 'a-u'].filter(Boolean).join(' ');
        if (style.fg)
            span.style.color = style.fg;
        if (style.bg)
            span.style.background = style.bg;
        span.textContent = text;
        out.append(span);
    }
    // Escape codes: colours (CSI … m) are applied, any other CSI and OSC (titles, links) are left out.
    const ESC = /\x1b(?:\[([0-9;?]*)([ -/]*[@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
    function write(chunk) {
        let text = pendingEsc + chunk;
        pendingEsc = '';
        const cut = text.lastIndexOf('\x1b');
        if (cut >= 0 && !/^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/.test(text.slice(cut))) {
            pendingEsc = text.slice(cut);
            text = text.slice(0, cut);
        }
        text = text.replace(/\r+\n/g, '\n').replace(/\r/g, '');
        let last = 0;
        for (const m of text.matchAll(ESC)) {
            appendText(text.slice(last, m.index));
            if (m[2] === 'm')
                applySgr((m[1] || '0').split(';').map(Number));
            last = (m.index ?? 0) + m[0].length;
        }
        appendText(text.slice(last));
        scrollDown();
    }
    const endsWithNewline = () => !out.lastChild || /\n$/.test(out.lastChild.textContent ?? '');
    const writeLine = (text, cls = '') => { if (!endsWithNewline())
        out.append('\n'); appendText(text + '\n', cls); scrollDown(); };
    let scrollRaf = 0;
    function scrollDown() {
        if (scrollRaf)
            return;
        scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; body.scrollTop = body.scrollHeight; });
    }
    /* ----- The prompt line ----- */
    let cwd = '';
    let platform = '';
    let proc = null;
    let runMark = null; // the circle of the command that's running
    const promptText = () => (platform === 'win32'
        ? `PS ${cwd.replace(/^([a-z]):/, (_m, d) => d.toUpperCase() + ':')}> `
        : `${cwd} $ `);
    function renderInput() {
        const v = input.value, at = input.selectionDirection === 'backward' ? input.selectionStart : input.selectionEnd;
        before.textContent = v.slice(0, at);
        caret.textContent = v[at] && v[at] !== '\n' ? v[at] : ' ';
        after.textContent = v.slice(at + (v[at] && v[at] !== '\n' ? 1 : 0));
        scrollDown();
    }
    function setBusy(id) {
        proc = id;
        line.classList.toggle('busy', id != null);
        killBtn.disabled = id == null;
    }
    // What was typed stays in the output as a line of its own, under a circle that later shows how it ended.
    function freezeLine(cmd) {
        if (!endsWithNewline())
            out.append('\n');
        const mark = document.createElement('span');
        mark.className = 'tw-mark';
        const row = document.createElement('span');
        row.append(mark, promptText(), cmd, '\n');
        out.append(row);
        style = {};
        return mark;
    }
    const finish = (mark, code) => {
        if (!mark)
            return;
        mark.classList.add(code === 0 ? 'ok' : 'fail');
        mark.title = code == null ? 'Stopped' : `Exit code ${code}`;
    };
    /* ----- Commands ----- */
    const HISTORY_KEY = 'breeze.termWinHistory';
    const history = read(HISTORY_KEY, []).filter(h => typeof h === 'string').slice(-200);
    let hIdx = history.length;
    async function submit() {
        const cmd = input.value.replace(/\r?\n$/, '');
        input.value = '';
        renderInput();
        if (proc != null) { // the running program asked for input
            appendText(cmd + '\n', 'tw-dim');
            quietly(api.write(proc, cmd + '\n'));
            return;
        }
        const mark = freezeLine(cmd);
        if (!cmd.trim())
            return;
        if (history.at(-1) !== cmd) {
            history.push(cmd);
            if (history.length > 200)
                history.shift();
        }
        hIdx = history.length;
        try {
            localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
        }
        catch { /* storage off */ }
        if (/^\s*(?:cls|clear)\s*$/i.test(cmd)) {
            out.textContent = '';
            return;
        }
        if (/^\s*exit\s*$/i.test(cmd)) {
            quietly(api.win.close());
            return;
        }
        const r = await api.run(cmd).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));
        if (r.error) {
            writeLine(r.error, 'tw-err');
            finish(mark, 1);
        }
        if (r.cwd) {
            cwd = r.cwd;
            ps.textContent = promptText();
            finish(mark, 0);
        }
        if (r.id != null) {
            runMark = mark;
            setBusy(r.id);
        }
        scrollDown();
    }
    function stop() {
        if (proc == null)
            return;
        quietly(api.kill(proc));
        appendText('^C\n', 'tw-dim');
    }
    api.onData((id, chunk) => { if (id === proc)
        write(chunk); });
    api.onExit((id, code) => {
        if (id !== proc)
            return;
        write(''); // flush a held-back escape code
        pendingEsc = '';
        finish(runMark, code);
        runMark = null;
        setBusy(null);
        if (!endsWithNewline())
            out.append('\n');
        scrollDown();
    });
    /* ----- Keys ----- */
    input.addEventListener('keydown', e => {
        const ctrl = e.ctrlKey || e.metaKey;
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void submit();
            return;
        }
        if (ctrl && e.key.toLowerCase() === 'c' && !e.shiftKey && !e.altKey) {
            const sel = window.getSelection()?.toString() ?? '';
            if (sel) {
                e.preventDefault();
                quietly(navigator.clipboard.writeText(sel));
                window.getSelection()?.removeAllRanges();
                return;
            }
            if (input.selectionStart !== input.selectionEnd)
                return; // copies the selected input
            e.preventDefault();
            if (proc != null) {
                stop();
                return;
            }
            finish(freezeLine(input.value + '^C'), null);
            input.value = '';
            renderInput();
            return;
        }
        if (ctrl && e.key.toLowerCase() === 'l') {
            e.preventDefault();
            out.textContent = '';
            return;
        }
        if (e.key === 'Tab') {
            e.preventDefault();
            return;
        }
        if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && proc == null && !input.value.includes('\n')) {
            e.preventDefault();
            hIdx = Math.max(0, Math.min(history.length, hIdx + (e.key === 'ArrowUp' ? -1 : 1)));
            input.value = history[hIdx] ?? '';
            input.setSelectionRange(input.value.length, input.value.length);
            renderInput();
        }
    });
    for (const ev of ['input', 'keyup', 'select', 'click'])
        input.addEventListener(ev, renderInput);
    document.addEventListener('selectionchange', () => { if (document.activeElement === input)
        renderInput(); });
    // A click in the terminal types there, unless it was the end of selecting some output to copy.
    body.addEventListener('mouseup', () => { if (!window.getSelection()?.toString())
        input.focus(); });
    const focused = (on) => document.body.classList.toggle('focused', on);
    input.addEventListener('focus', () => focused(true));
    input.addEventListener('blur', () => focused(false));
    window.addEventListener('focus', () => { if (!window.getSelection()?.toString())
        input.focus(); });
    /* ----- Title bar ----- */
    el('twNew').onclick = () => quietly(api.win.newTerminal());
    el('twClear').onclick = () => { out.textContent = ''; input.focus(); };
    killBtn.onclick = () => { stop(); input.focus(); };
    el('twMin').onclick = () => quietly(api.win.minimize());
    el('twMax').onclick = () => quietly(api.win.toggleMaximize());
    el('twClose').onclick = () => quietly(api.win.close());
    const max = el('twMax');
    const showMaximized = (on) => {
        max.title = on ? 'Restore' : 'Maximize';
        max.setAttribute('aria-label', max.title);
        max.querySelector('svg').innerHTML = on
            ? '<rect x=".5" y="2.5" width="7" height="7"/><path d="M2.5 2.5V.5h7v7h-2"/>'
            : '<rect x=".5" y=".5" width="9" height="9"/>';
    };
    api.win.onMaximized(showMaximized);
    void api.win.isMaximized().then(showMaximized, () => { });
    void api.info().then(i => {
        cwd = i.cwd;
        platform = i.platform;
        if (platform === 'darwin')
            document.documentElement.classList.add('mac');
        const folder = cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd;
        const title = `Terminal - ${folder} - Breeze Code`;
        document.title = title;
        el('twTitle').textContent = title;
        ps.textContent = promptText();
        renderInput();
        input.focus();
    });
})();
