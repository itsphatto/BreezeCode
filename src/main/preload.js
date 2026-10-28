// Exposes a narrow, typed bridge to the renderer. Every path is project-relative and checked in main.js.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);
const listen = (ch, cb) => {
  const h = (_e, ...args) => cb(...args);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('breeze', {
  version: process.argv.find(a => a.startsWith('--breeze-version='))?.slice(17) ?? '',
  fs: {
    openFolder: () => invoke('fs:openFolder'),
    createFolder: () => invoke('fs:createFolder'),
    restore: () => invoke('fs:restore'),
    closeFolder: () => invoke('fs:closeFolder'),
    recent: () => invoke('fs:recent'),
    openRecent: dir => invoke('fs:openRecent', dir),
    forgetRecent: dir => invoke('fs:forgetRecent', dir),
    readDir: rel => invoke('fs:readDir', rel),
    readFile: rel => invoke('fs:readFile', rel),
    writeFile: (rel, text) => invoke('fs:writeFile', rel, text),
    createFile: rel => invoke('fs:createFile', rel),
    createDir: rel => invoke('fs:createDir', rel),
    rename: (from, to) => invoke('fs:rename', from, to),
    trash: rel => invoke('fs:trash', rel),
    listFiles: () => invoke('fs:listFiles'),
    search: (query, matchCase) => invoke('fs:search', query, matchCase),
    fileUrl: rel => invoke('fs:fileUrl', rel),
    previewUrl: rel => invoke('fs:previewUrl', rel),
    onChange: cb => listen('fs:changed', cb),
    onWatchLost: cb => listen('fs:watchLost', cb),
    importFile: (dir, name, bytes) => invoke('fs:import', dir, name, bytes),
  },
  lint: {
    check: (code, ext) => invoke('lint:check', code, ext),
  },
  term: {
    cwd: () => invoke('term:cwd'),
    run: command => invoke('term:run', command),
    write: (id, text) => invoke('term:write', id, text),
    kill: id => invoke('term:kill', id),
    complete: word => invoke('term:complete', word),
    onData: cb => listen('term:data', cb),
    onExit: cb => listen('term:exit', cb),
  },
  run: {
    file: rel => invoke('run:file', rel),
  },
  sys: {
    detect: force => invoke('sys:detect', !!force),
    openExternal: url => invoke('sys:openExternal', url),
    runCommand: cmd => invoke('sys:runCommand', cmd),
    getPathForFile: file => {
      try {
        if (typeof webUtils?.getPathForFile === 'function') {
          return webUtils.getPathForFile(file);
        }
      } catch { /* older Electron: fall back to file.path */ }
      return file?.path || '';
    },
  },
  live: {
    status: () => invoke('live:status'),
    start: () => invoke('live:start'),
    stop: () => invoke('live:stop'),
  },
  llm: {
    connect: (url, key) => invoke('llm:connect', url, key),
    setModel: model => invoke('llm:setModel', model),
    disconnect: () => invoke('llm:disconnect'),
  },
  agent: {
    run: opts => invoke('agent:run', opts),
    stop: runId => invoke('agent:stop', runId),
    setModel: (agent, model, effort) => invoke('agent:setModel', { agent, model, effort }),
    usage: () => invoke('agent:usage'),
    onEvent: cb => listen('agent:event', cb),
  },
  team: {
    parse: t => invoke('team:parse', t),
    claim: o => invoke('team:claim', o),
    start: o => invoke('team:start', o),
    stop: id => invoke('team:stop', id),
    undo: o => invoke('team:undo', o),
  },
  git: {
    status: () => invoke('git:status'),
    log: () => invoke('git:log'),
    show: hash => invoke('git:show', hash),
    diff: (rel, staged) => invoke('git:diff', rel, staged),
    init: () => invoke('git:init'),
    stage: paths => invoke('git:stage', paths),
    unstage: (paths, hasCommits) => invoke('git:unstage', paths, hasCommits),
    discard: files => invoke('git:discard', files),
    commit: (message, all) => invoke('git:commit', message, all),
    branches: () => invoke('git:branches'),
    switchTo: (name, create, from) => invoke('git:switch', name, create, from),
    sync: op => invoke('git:sync', op),
    deleteBranch: name => invoke('git:deleteBranch', name),
    genCommitMsg: opts => invoke('git:genCommitMsg', opts),
  },
  auth: {
    user: () => invoke('auth:user'),
    accounts: () => invoke('auth:accounts'),
    switchTo: id => invoke('auth:switch', id),
    start: provider => invoke('auth:start', provider),
    cancel: () => invoke('auth:cancel'),
    signOut: () => invoke('auth:signOut'),
    remove: id => invoke('auth:remove', id),
    onEvent: cb => listen('auth:event', cb),
  },
  sync: {
    status: () => invoke('sync:status'),
    run: mode => invoke('sync:run', mode),
    clone: id => invoke('sync:clone', id),
    settings: local => invoke('sync:settings', local),
  },
  vibe: {
    status: () => invoke('vibe:status'),
    connect: (id, bounds) => invoke('vibe:connect', id, bounds),
    connectBounds: bounds => invoke('vibe:connectBounds', bounds),
    connectClose: () => invoke('vibe:connectClose'),
    disconnect: id => invoke('vibe:disconnect', id),
    show: (id, bounds) => invoke('vibe:show', id, bounds),
    bounds: bounds => invoke('vibe:bounds', bounds),
    mute: muted => invoke('vibe:mute', muted),
    hide: () => invoke('vibe:hide'),
  },
  discord: {
    set: activity => invoke('discord:set', activity),
    clear: () => invoke('discord:clear'),
  },
  win: {
    reload: () => invoke('win:reload'),
    toggleDevTools: () => invoke('win:devtools'),
    quit: () => invoke('win:quit'),
    edit: role => invoke('win:edit', role),
  },
});
