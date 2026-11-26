// Own synthetic window only; real meeting stylesheet, no media or account state.
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 620, height: 56, show: false, frame: false, webPreferences: { sandbox: true } });
  let ok = false;
  try {
    await win.loadURL('data:text/html,' + encodeURIComponent(`<html><head><style>html,body{margin:0;height:100%;overflow:hidden}</style></head><body>
      <div class="meeting-ui meeting-compact meeting-sharing-bar"><div class="compact-speaking">你正在共享屏幕</div>
      <div class="compact-controls"><button class="sharing-stop">停止共享</button>${['展开会议','麦克风','摄像头','标注','离开会议'].map(x => `<button aria-label="${x}">●</button>`).join('')}</div></div></body></html>`));
    const css = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../../app/src/react-app/domains/meeting/meeting.css'), 'utf8');
    await win.webContents.insertCSS(css);
    const result = await win.webContents.executeJavaScript(`(()=>{const bar=document.querySelector('.meeting-sharing-bar'),buttons=[...document.querySelectorAll('button')];return {direction:getComputedStyle(bar).flexDirection,clipped:buttons.filter(b=>{const r=b.getBoundingClientRect();return r.left<0||r.right>innerWidth||r.top<0||r.bottom>innerHeight}).length,stopWidth:buttons[0].getBoundingClientRect().width,bodyOverflow:document.body.scrollHeight>innerHeight}})()`);
    ok = result.direction === 'row' && result.clipped === 0 && result.stopWidth >= 80 && !result.bodyOverflow;
    console.log(JSON.stringify({ pass: ok, ...result }));
  } finally { win.destroy(); console.log(JSON.stringify({ cleanup: win.isDestroyed() })); app.exit(ok ? 0 : 1); }
});
