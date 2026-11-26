// Bounded, independent render check of the real annotation preload and page.
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  let controller;
  const windows = [];
  const issues = [];
  try {
    const { createMeetingAnnotation } = await import(pathToFileURL(path.resolve(__dirname, '../electron/meeting-annotation.mjs')));
    const endpoint = new BrowserWindow({ show: false });
    windows.push(endpoint);
    const sender = { sender: endpoint.webContents, senderFrame: endpoint.webContents.mainFrame };
    controller = createMeetingAnnotation({
      BrowserWindow: function(options) {
        const win = new BrowserWindow(options); windows.push(win);
        win.webContents.on('preload-error', () => issues.push('preload-error'));
        win.webContents.on('console-message', (_event, level, message) => {
          if (level >= 3) issues.push(String(message).replace(/https?:\/\/\S+/g, '[url]').slice(0, 300));
        });
        return win;
      }, screen, ipcMain, preloadPath: path.resolve(__dirname, '../electron/annotation-preload.cjs'),
      loadPage: (win, view) => win.loadURL(`http://localhost:5173/annotation.html?view=${view}`),
      getMainWindow: () => endpoint, getMeetingWindow: () => endpoint,
      getSharedDisplayId: () => screen.getPrimaryDisplay().id, clearShared() {},
    });
    await controller.open(sender);
    const toolbar = windows[2];
    const deadline = Date.now() + 15000;
    let result;
    do {
      result = await toolbar.webContents.executeJavaScript(`JSON.stringify({bridge:!!window.__JUGGLEWORK_ANNOTATION__,buttons:document.querySelectorAll('button').length,width:innerWidth,height:innerHeight,clipped:[...document.querySelectorAll('button')].filter(b=>{const r=b.getBoundingClientRect();return r.left<0||r.right>innerWidth||r.bottom>innerHeight}).map(b=>b.getAttribute('aria-label'))})`);
      if (JSON.parse(result).buttons) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    console.log(JSON.stringify({ stage: 'render', ...JSON.parse(result), issues }));
    process.exitCode = JSON.parse(result).buttons >= 16 ? 0 : 1;
  } catch (error) { console.log(JSON.stringify({ stage: 'failed', name: error.name })); process.exitCode = 1; }
  finally {
    controller?.close({ sender: windows[0]?.webContents, senderFrame: windows[0]?.webContents.mainFrame });
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    console.log(JSON.stringify({ stage: 'cleanup', confirmed: windows.every(win => win.isDestroyed()) }));
    app.exit(process.exitCode || 0);
  }
});
