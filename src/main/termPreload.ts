// The bridge for a terminal window (termwin.html): its own terminal and window buttons, nothing else.
import { contextBridge, ipcRenderer } from 'electron';

const invoke = (ch: string, ...args: unknown[]) => ipcRenderer.invoke(ch, ...args);
const listen = (ch: string, cb: (...args: unknown[]) => void) => {
  const h = (_e: unknown, ...args: unknown[]) => cb(...args);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('breezeTerm', {
  info: () => invoke('tw:info'),
  run: (command: string) => invoke('tw:run', command),
  write: (id: number, text: string) => invoke('tw:write', id, text),
  kill: (id: number) => invoke('tw:kill', id),
  onData: (cb: (...args: unknown[]) => void) => listen('tw:data', cb),
  onExit: (cb: (...args: unknown[]) => void) => listen('tw:exit', cb),
  win: {
    newTerminal: () => invoke('tw:new'),
    minimize: () => invoke('tw:minimize'),
    toggleMaximize: () => invoke('tw:toggleMaximize'),
    close: () => invoke('tw:close'),
    isMaximized: () => invoke('tw:isMaximized'),
    onMaximized: (cb: (...args: unknown[]) => void) => listen('tw:maximized', cb),
  },
});
