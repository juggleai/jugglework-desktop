// Verify real Chromium display capture from a meeting-style blank child window.
// Run with apps/app dev and a development Electron started with --inspect=9237.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const desktopPackage = fileURLToPath(new URL("../package.json", import.meta.url));
const permissionsPath = fileURLToPath(new URL("../electron/media-permissions.mjs", import.meta.url));
const port = Number(process.env.MEETING_QA_NATIVE_PORT || 9237);
const base = process.env.MEETING_QA_APP_URL || "http://localhost:5173";
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
if (!targets[0]?.webSocketDebuggerUrl) throw new Error("Electron native inspector is not available");
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
try {
  const expression = `(async()=>{
    const req=process.getBuiltinModule('module').createRequire(${JSON.stringify(desktopPackage)});
    const e=req('electron');
    const {installMediaPermissionHandlers}=req(${JSON.stringify(permissionsPath)});
    const ses=e.session.fromPartition('meeting-screen-regression-'+Date.now());
    const preferences={session:ses,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'};
    const w=new e.BrowserWindow({show:false,width:640,height:480,webPreferences:preferences});
    let child;let requests=0;
    w.webContents.setWindowOpenHandler(()=>({action:'allow',overrideBrowserWindowOptions:{show:true,width:640,height:480,webPreferences:preferences}}));
    w.webContents.on('did-create-window',c=>{child=c;});
    installMediaPermissionHandlers({defaultSession:ses},()=>w,()=>child);
    // Capture only this test page, not the OS desktop. Exercise Chromium's real
    // display permission path without changing the application's session handler.
    ses.setDisplayMediaRequestHandler((request,callback)=>{
      requests++;
      callback(requests===3?null:{video:request.frame});
    },{useSystemPicker:false});
    try {
      await w.loadURL(${JSON.stringify(base + "/tests/fixtures/meeting-screen-share/index.html")});
      await w.webContents.executeJavaScript("window.testChild=window.open('about:blank','screen-share-check','popup');testChild.document.write(document.documentElement.outerHTML);testChild.document.close();true",true);
      child.focus();
      const result=await child.webContents.executeJavaScript('window.runScreenCaptureCheck().catch(e=>({error:{name:e.name,message:e.message}}))',true);
      if(result.error)throw Error(JSON.stringify(result.error));
      if(requests!==3)throw Error('Expected two captures and one cancellation');
      return {...result,requests};
    } finally {
      if(child&&!child.isDestroyed())child.destroy();w.destroy();
      ses.setPermissionCheckHandler(null);ses.setPermissionRequestHandler(null);ses.setDisplayMediaRequestHandler(null);
    }
  })()`;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Screen capture regression timed out")), 30_000);
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
