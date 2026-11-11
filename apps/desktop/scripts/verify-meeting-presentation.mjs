// Validate focus layout geometry and incoming chat toasts in real Chromium.
// Run with apps/app dev and a development Electron started with --inspect=9237.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const port = Number(process.env.MEETING_QA_NATIVE_PORT || 9237);
const base = process.env.MEETING_QA_APP_URL || "http://localhost:5173";
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
if (!targets[0]?.webSocketDebuggerUrl) throw new Error("Electron native inspector is not available");
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
try {
  const expression = `(async()=>{
    const e=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');
    const preferences={nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'};
    const w=new e.BrowserWindow({show:false,width:1000,height:760,webPreferences:preferences});
    try {
      await w.loadURL(${JSON.stringify(base + "/tests/fixtures/meeting-presentation/index.html")});
      const result=await w.webContents.executeJavaScript('window.runMeetingPresentationCheck()',true);
      return result;
    } finally {w.destroy();}
  })()`;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Meeting presentation regression timed out")), 30_000);
    ws.on("message", raw => {
      const response = JSON.parse(String(raw));
      if (response.id !== 1) return;
      clearTimeout(timer);
      if (response.error || response.result?.exceptionDetails) reject(new Error(JSON.stringify(response)));
      else resolve(response.result.result.value);
    });
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  console.log(JSON.stringify(result, null, 2));
} finally { ws.close(); }
