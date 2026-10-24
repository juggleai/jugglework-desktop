import { app, BrowserWindow, ipcMain, screen, Menu } from "electron";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDesktopPet } from "../electron/pet-window.mjs";

// TIPS: 仅验证发布页的小跳资源与播放器，不连接账号、任务或主会话输入模块。
const output = mkdtempSync(join(tmpdir(), "juggle-celebrate-smoke-"));
app.setPath("userData", join(output, "profile"));
void app.whenReady().then(async () => {
  const main = new BrowserWindow({ show: false });
  const controller = createDesktopPet({ BrowserWindow, screen, ipcMain, Menu,
    preferencesPath: join(output, "pet.json"),
    preloadPath: resolve(import.meta.dirname, "../electron/pet-preload.mjs"),
    getMainWindow: () => main,
    loadPage: (window) => window.loadURL(process.env.JUGGLEWORK_PET_SMOKE_URL || "http://localhost:5173/pet.html"),
  });
  const report = { output, assertions: {}, rendererErrors: [] };
  try {
    main.webContents.send = (channel, payload) => {
      if (channel === "jugglework:pet:host-action") ipcMain.emit("jugglework:pet:host-reply", { sender: main.webContents }, { requestId: payload.requestId, result: {} });
    };
    await controller.setVisible(true);
    const pet = BrowserWindow.getAllWindows().find((window) => window !== main);
    pet.setPosition(80, 80);
    pet.webContents.on("console-message", (event) => { if (event.level === "error") report.rendererErrors.push(event.message); });
    const evaluate = (code) => pet.webContents.executeJavaScript(code);
    const waitFor = async (code) => {
      const deadline = Date.now() + 7000;
      while (Date.now() < deadline) { if (await evaluate(code)) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
      throw new Error(`动作验收超时: ${code}`);
    };
    ipcMain.emit("jugglework:pet:publish", { sender: main.webContents }, {
      contextKey: "celebrate-isolated", ready: true, syncing: false, partial: false,
      tasks: [], locale: "zh", theme: "light", editing: false, voicePhase: "idle", voiceAvailable: false,
    });
    await waitFor('document.querySelector(".pet-sprite")?.style.backgroundImage.includes("/typing.png")');
    report.assertions.revisedStripLoads = await evaluate('new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(image.naturalWidth===1920 && image.naturalHeight===416);image.onerror=()=>resolve(false);image.src=new URL("pets/juggle/celebrate.png?v=20261024",document.baseURI).href})');
    // TIPS: 清理窗口出现时可能触发的真实鼠标悬停，再记录一次完整、独立的进入事件。
    await evaluate('document.querySelector(".pet-character").dispatchEvent(new PointerEvent("pointerout",{bubbles:true,relatedTarget:null}))');
    await new Promise((resolve) => setTimeout(resolve, 4500));
    await evaluate(`(() => {
      const sprite=document.querySelector('.pet-sprite');
      window.__celebrateFrames=[];
      window.__celebrateObserver=new MutationObserver(()=>{
        const action=sprite.style.backgroundImage.includes('celebrate.png')?'celebrate':sprite.style.backgroundImage.includes('/typing.png')?'typing':'other';
        const frame=Math.round(-parseFloat(sprite.style.backgroundPosition)/104);
        const next=action+':'+frame;
        if(window.__celebrateFrames.at(-1)!==next)window.__celebrateFrames.push(next);
      });
      window.__celebrateObserver.observe(sprite,{attributes:true,attributeFilter:['style']});
      document.querySelector('.pet-character').dispatchEvent(new PointerEvent('pointerover',{bubbles:true,relatedTarget:null}));
    })()`);
    await waitFor('document.querySelector(".pet-sprite").style.backgroundImage.includes("celebrate.png?v=20261024") && document.querySelector(".pet-sprite").style.backgroundPosition.startsWith("-208px")');
    writeFileSync(join(output, "apex.png"), (await pet.webContents.capturePage()).toPNG());
    await waitFor('window.__celebrateFrames.includes("typing:0")');
    report.frames = await evaluate('window.__celebrateFrames');
    report.assertions.exactlyTwoHops = JSON.stringify(report.frames.filter((frame) => frame.startsWith("celebrate:"))) === JSON.stringify(["celebrate:0", "celebrate:1", "celebrate:2", "celebrate:3", "celebrate:4", "celebrate:0", "celebrate:1", "celebrate:2", "celebrate:3", "celebrate:4"]);
    report.assertions.returnsToTyping = report.frames.at(-1) === "typing:0";
    report.assertions.runtimeSizeUnchanged = await evaluate('document.querySelector(".pet-character").getBoundingClientRect().width === 104');
    await evaluate('window.__celebrateObserver.disconnect()');
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    process.exitCode = report.rendererErrors.length || Object.values(report.assertions).some((value) => !value) ? 1 : 0;
  } catch (error) { console.error(error); console.error(JSON.stringify(report)); process.exitCode = 1; }
  finally { controller.dispose(); main.destroy(); app.exit(process.exitCode || 0); }
});
