"use strict";
/* ================= Discord ================= */
// Rich Presence through the Discord app on this computer (main.js talks to it); updates are coalesced.
const discordSince = Date.now();
let discordTimer;
let discordLive = false; // connected and showing
function discordActivity() {
    const working = Object.values(agentsDef).find(a => a.status === 'working');
    const inBox = appState.mode === 'box';
    const file = active ? baseName(active) : null;
    if (!appState.discordDetails) {
        let details = 'Writing code';
        if (working)
            details = 'Vibe coding with agents';
        else if (inBox)
            details = 'Chatting with an agent';
        return { details, state: 'Breeze Code', start: discordSince, dev: appState.devMode };
    }
    let details = inBox ? 'Chatting in Breeze Space' : 'Idle';
    if (working)
        details = `${working.name}: ${working.task}`;
    else if (!inBox && file)
        details = `Editing ${file}`;
    const lang = !inBox && active ? langOf(active)[1] : '';
    const where = rootInfo ? `in ${rootInfo.name}` : 'Breeze Code';
    const icon = !inBox && !working && active ? discordIcon(active) : undefined;
    return { details, state: lang && !working ? `${lang} · ${where}` : where, start: discordSince, icon, lang: lang || undefined, dev: appState.devMode };
}
// The file's language icon for the big presence picture (names of the PNGs main.js links to, from vscord's set).
const DISCORD_ICONS = {
    html: 'html', htm: 'html', xml: 'xml', svg: 'svg', vue: 'vue', css: 'css', scss: 'scss', sass: 'scss', less: 'less',
    styl: 'stylus', pcss: 'postcss',
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx', json: 'json', jsonc: 'json',
    json5: 'json', hjson: 'hjson',
    md: 'markdown', markdown: 'markdown', mdx: 'markdownx', rst: 'restructuredtext', adoc: 'asciidoc', tex: 'tex',
    latex: 'tex', typ: 'typst', txt: 'text', log: 'log', ipynb: 'jupyter',
    py: 'python', pyw: 'python', pyx: 'cython', java: 'java', jar: 'jar', kt: 'kotlin', kts: 'kotlin', scala: 'scala',
    sc: 'scala', groovy: 'groovy', gradle: 'gradle', clj: 'clojure', cljs: 'clojure', cljc: 'clojure',
    rs: 'rust', go: 'go', zig: 'zig', nim: 'nim', odin: 'odin', v: 'v', d: 'd', cr: 'crystal', gleam: 'gleam',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', mm: 'objective-c',
    cs: 'csharp', csx: 'csharp', csproj: 'csproj', fs: 'fsharp', fsx: 'fsharp', vb: 'vb', xaml: 'xaml',
    cshtml: 'razor', razor: 'razor', cu: 'cuda', asm: 'assembly', s: 'assembly', wasm: 'wasm', wat: 'wasm',
    glsl: 'glsl', vert: 'glsl', frag: 'glsl', hlsl: 'hlsl', metal: 'metal', ino: 'arduino',
    rb: 'ruby', erb: 'ruby', php: 'php', pl: 'perl', pm: 'perl', lua: 'lua', luau: 'luau', r: 'r', jl: 'julia',
    dart: 'dart', swift: 'swift', ex: 'elixir', exs: 'elixir', heex: 'heex', erl: 'erlang', hrl: 'erlang',
    hs: 'haskell', lhs: 'haskell', elm: 'elm', ml: 'ocaml', mli: 'ocaml', re: 'reasonml', rei: 'reasonml',
    purs: 'purescript', rkt: 'racket', lisp: 'lisp', el: 'lisp', coffee: 'coffee', hx: 'haxe', mojo: 'mojo',
    gd: 'godot', rpy: 'renpy', qml: 'qml', vala: 'vala', lean: 'lean', agda: 'agda', sol: 'solidity',
    f90: 'fortran', f95: 'fortran', cob: 'cobol', pas: 'pascal', vhd: 'vhdl', vhdl: 'vhdl', sv: 'systemverilog',
    ahk: 'ahk', au3: 'autoit', applescript: 'applescript', bf: 'brainfuck', sqf: 'sqf', nut: 'squirrel',
    svelte: 'svelte', astro: 'astro', ejs: 'ejs', hbs: 'handlebars', handlebars: 'handlebars', pug: 'pug',
    twig: 'twig', jinja: 'jinja', j2: 'jinja', templ: 'templ', marko: 'marko',
    sql: 'sql', graphql: 'graphql', gql: 'graphql', prisma: 'prisma', http: 'http',
    yml: 'yaml', yaml: 'yaml', toml: 'toml', tf: 'terraform', tfvars: 'terraform', nix: 'nix', cmake: 'cmake',
    sh: 'shell', bash: 'shell', zsh: 'shell', ksh: 'shell', fish: 'shell',
    ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', bat: 'bat', cmd: 'bat',
};
// Files known by their name rather than their extension (matched in lower case).
const DISCORD_FILES = {
    '.gitignore': 'git', '.gitattributes': 'git', '.gitmodules': 'git', '.gitkeep': 'git', '.mailmap': 'git',
    '.gitlab-ci.yml': 'gitlab', '.travis.yml': 'travis', 'appveyor.yml': 'appveyor', '.editorconfig': 'editorconfig',
    'package.json': 'npm', 'package-lock.json': 'npm', '.npmrc': 'npm', '.npmignore': 'npm', 'yarn.lock': 'yarn',
    '.yarnrc': 'yarn', '.yarnrc.yml': 'yarn', 'bower.json': 'bower', 'cargo.toml': 'cargo', 'cargo.lock': 'cargo',
    'gemfile': 'gemfile', 'gemfile.lock': 'gemfile', 'makefile': 'makefile', 'gnumakefile': 'makefile',
    'cmakelists.txt': 'cmake', 'build.bazel': 'bazel', 'workspace': 'bazel', 'procfile': 'heroku',
    'vercel.json': 'vercel', 'firebase.json': 'firebase', 'turbo.json': 'turbo', 'nodemon.json': 'nodemon',
    '.flowconfig': 'flowconfig', '.vscodeignore': 'vscodeignore', 'gulpfile.js': 'gulp', 'gruntfile.js': 'gruntfile',
    'vue.config.js': 'vueconfig',
};
// Config files whose names start the same whatever their extension (vite.config.ts, .eslintrc.json, ...).
const DISCORD_PREFIXES = [
    ['vite.config.', 'viteconfig'], ['vitest.config.', 'vitestconfig'], ['astro.config.', 'astroconfig'],
    ['tailwind.config.', 'tailwind'], ['postcss.config.', 'postcss'], ['webpack.config.', 'webpack'],
    ['jest.config.', 'jest'], ['babel.config.', 'babel'], ['.babelrc', 'babel'], ['eslint.config.', 'eslint'],
    ['.eslintrc', 'eslint'], ['.eslintignore', 'eslint'], ['prettier.config.', 'prettier'], ['.prettierrc', 'prettier'],
    ['.prettierignore', 'prettier'], ['docker-compose', 'docker'], ['compose.y', 'docker'], ['build.gradle', 'gradle'],
    ['settings.gradle', 'gradle'],
];
function discordIcon(path) {
    const name = baseName(path).toLowerCase();
    const byName = DISCORD_FILES[name] ?? DISCORD_PREFIXES.find(([p]) => name.startsWith(p))?.[1];
    if (byName)
        return byName;
    if (name.endsWith('.d.ts'))
        return 'typescript-def';
    const lexer = langOf(path)[0];
    if (lexer === 'docker')
        return 'docker';
    if (lexer === 'env')
        return 'env';
    return DISCORD_ICONS[extOf(path)] ?? 'text';
}
// Settings → Discord shows this state; there is no status bar button any more.
let discordState = { state: 'off', why: '' };
function renderDiscord(state, why = '') {
    discordState = { state, why };
    refreshSettings();
}
async function pushDiscord() {
    if (!appState.discord)
        return;
    try {
        await api.discord.set(discordActivity());
        if (!discordLive)
            renderDiscord('on');
        discordLive = true;
    }
    catch (e) {
        discordLive = false;
        // Said once, in a toast; Settings only shows "Not connected" until it comes back.
        if (discordState.state !== 'error')
            toast(errMsg(e));
        renderDiscord('error');
    }
}
function queueDiscord() {
    if (!appState.discord)
        return;
    clearTimeout(discordTimer);
    discordTimer = setTimeout(() => void pushDiscord(), 1200);
}
async function discordOn(details) {
    appState.discordDetails = details;
    try {
        const r = await api.discord.set(discordActivity());
        appState.discord = true;
        discordLive = true;
        saveApp();
        renderDiscord('on');
        toast(r.user ? `Showing on Discord as ${r.user}` : 'Discord presence on');
        return true;
    }
    catch (e) {
        toast(errMsg(e));
        return false;
    }
}
function discordOff() {
    appState.discord = false;
    discordLive = false;
    saveApp();
    clearTimeout(discordTimer);
    renderDiscord('off');
    background(api.discord.clear());
}
