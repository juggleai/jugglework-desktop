// Standalone Windows Electron probe; never loads the app or the overlay fixture.
const { setTimeout: delay } = require('node:timers/promises');

async function withDeadline(pending, stage) {
  let timer;
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(stage)), 10_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function contains(area, rect) {
  return rect.x >= area.x && rect.y >= area.y &&
    rect.x + rect.width <= area.x + area.width && rect.y + rect.height <= area.y + area.height;
}

async function probeEdgeSizes({ BrowserWindow, screen, emit, settle = () => delay(200) }) {
  const { scaleFactor, workArea } = screen.getPrimaryDisplay();
  const length = 240;
  const thickness = 8;
  if (scaleFactor !== 1 || workArea.width < length + 80 || workArea.height < length + 80) {
    throw new Error('primary-display');
  }
  const x = workArea.x + Math.floor((workArea.width - length) / 2);
  const y = workArea.y + Math.floor((workArea.height - length) / 2);

  for (const resizable of [false, true]) {
    for (const orientation of ['horizontal', 'vertical']) {
      const horizontal = orientation === 'horizontal';
      const requestedDip = { x, y, width: horizontal ? length : thickness, height: horizontal ? thickness : length };
      const record = { type: 'edge-size', scaleFactor, resizable, orientation, requestedDip };
      emit({ type: 'edge-size-progress', stage: 'window-creating', resizable, orientation });
      const win = new BrowserWindow({
        ...requestedDip, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
        alwaysOnTop: false, focusable: false, skipTaskbar: true, hasShadow: false, thickFrame: false,
        roundedCorners: false, resizable, movable: false, minimizable: false, maximizable: false,
        fullscreenable: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      try {
        win.setIgnoreMouseEvents(true);
        emit({ type: 'edge-size-progress', stage: 'window-loading', resizable, orientation });
        await withDeadline(win.loadURL('data:text/html,<!doctype html><body style="margin:0;background:gold">'), 'window-load-timeout');
        win.setBounds(requestedDip);
        const beforeShowDip = win.getBounds();
        emit({ ...record, beforeShowDip });
        if (!contains(workArea, beforeShowDip)) throw new Error('primary-display');

        win.showInactive();
        await settle();
        const afterShowDip = win.getBounds();
        emit({ ...record, afterShowDip });
        if (!contains(workArea, afterShowDip)) throw new Error('primary-display');
      } finally {
        win.destroy();
      }
    }
  }
}

// Electron can load the application entry through its own loader instead of
// marking the entry as Node's require.main.
if (require.main === module || (process.versions.electron && process.type === 'browser')) {
  const emit = (record) => console.log(JSON.stringify(record));
  if (process.platform !== 'win32' || !process.versions.electron) {
    emit({ type: 'error', stage: 'windows-electron-required' });
    process.exit(1);
  } else {
    const { app, BrowserWindow, screen } = require('electron');
    app.on('window-all-closed', () => {}); // Keep running between cases.
    emit({ type: 'edge-size-progress', stage: 'waiting-for-ready', electron: process.versions.electron });
    withDeadline(app.whenReady(), 'ready-timeout').then(() => {
      emit({ type: 'edge-size-progress', stage: 'ready' });
      return probeEdgeSizes({ BrowserWindow, screen, emit });
    }).then(
      () => { emit({ type: 'edge-size-progress', stage: 'complete' }); app.quit(); },
      (error) => {
        const stages = ['primary-display', 'ready-timeout', 'window-load-timeout'];
        emit({ type: 'error', stage: stages.includes(error.message) ? error.message : 'edge-size-probe' });
        app.exit(1);
      },
    );
  }
}

module.exports = { probeEdgeSizes };
