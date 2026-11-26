const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__JUGGLEWORK_ANNOTATION__', {
  init: () => ipcRenderer.invoke('jugglework:semantic-annotation:init'),
  onState(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('jugglework:semantic-annotation:state', listener);
    return () => ipcRenderer.removeListener('jugglework:semantic-annotation:state', listener);
  },
  onAction() { return () => {}; },
  command: command => ipcRenderer.send('jugglework:semantic-annotation:command', command),
  history() {},
  scene() {},
});
