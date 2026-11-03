// The bridge for a terminal window (termwin.html): its own terminal and window buttons, nothing else.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);
const listen = (ch, cb) => {
  const h = (_e, ...args) => cb(...args);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('breezeTerm', {
  info: () => invoke('tw:info'),
  run: command => invoke('tw:run', command),
  write: (id, text) => invoke('tw:write', id, text),
  kill: id => invoke('tw:kill', id),
  onData: cb => listen('tw:data', cb),
  onExit: cb => listen('tw:exit', cb),
  win: {
    newTerminal: () => invoke('tw:new'),
    minimize: () => invoke('tw:minimize'),
    toggleMaximize: () => invoke('tw:toggleMaximize'),
    close: () => invoke('tw:close'),
    isMaximized: () => invoke('tw:isMaximized'),
    onMaximized: cb => listen('tw:maximized', cb),
  },
});
