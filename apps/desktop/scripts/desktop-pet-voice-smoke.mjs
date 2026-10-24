import { app, BrowserWindow, screen, ipcMain, Menu } from "electron";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createDesktopPet } from "../electron/pet-window.mjs";

// TIPS: 仅用隔离窗口和延迟宿主回执验证听写启动/取消，不访问真实麦克风或业务账号。
const output = mkdtempSync(join(tmpdir(), "juggle-pet-voice-"));
app.setPath("userData", join(output, "profile"));
void app.whenReady().then(async () => {
  const main = new BrowserWindow({ show: false });
  const controller = createDesktopPet({ BrowserWindow, screen, ipcMain, Menu, preferencesPath: join(output, "pet.json"), preloadPath: resolve(import.meta.dirname, "../electron/pet-preload.mjs"), getMainWindow: () => main, loadPage: win => win.loadURL(process.env.JUGGLEWORK_PET_SMOKE_URL || "http://127.0.0.1:5191/pet.html") });
  const report = { output, assertions: {}, actions: [], realMicrophoneUsed: false };
  let pet, replyLatest, replyStart, voiceTarget;
  const target = { key: "w:s", workspaceId: "w", sessionId: "s", title: "隔离听写测试", project: "隔离项目" };
  const publish = phase => ipcMain.emit("jugglework:pet:publish", { sender: main.webContents }, { contextKey: "voice-smoke", ready: true, syncing: false, partial: false, tasks: [], locale: "zh", theme: "light", voiceAvailable: true, voicePhase: phase, editing: false });
  main.webContents.send = (channel, payload) => {
    if (channel !== "jugglework:pet:host-action") return;
    report.actions.push(payload.action.type);
    const reply = result => ipcMain.emit("jugglework:pet:host-reply", { sender: main.webContents }, { requestId: payload.requestId, result });
    if (payload.action.type === "latest") replyLatest = () => reply({ target });
    else if (payload.action.type === "voice-start") { voiceTarget = payload.action.target; replyStart = () => reply({}); publish("requesting-permission"); }
    else { if (payload.action.type === "voice-cancel" || payload.action.type === "voice-stop") publish("idle"); reply({}); }
  };
  const evaluate = code => pet.webContents.executeJavaScript(code);
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  const wait = async predicate => { const end = Date.now() + 5000; while (!await predicate()) { if (Date.now() > end) throw new Error("听写启动/取消验收超时"); await new Promise(resolve => setTimeout(resolve, 25)); } };
  const open = async () => {
    controller.focus();
    await wait(() => evaluate('Boolean(document.querySelector(".pet-tools")) && !document.querySelectorAll(".pet-tools button")[1].disabled'));
    await evaluate('document.querySelectorAll(".pet-tools button")[1].click()');
    await wait(() => Boolean(replyLatest));
  };
  const escape = () => evaluate('document.querySelector("textarea").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  const count = action => report.actions.filter(type => type === action).length;
  try {
    await controller.setVisible(true);
    pet = BrowserWindow.getAllWindows().find(win => win !== main);
    publish("idle");
    for (const close of ["escape", "blur"]) {
      replyLatest = null;
      await open();
      if (close === "escape") await escape();
      else await evaluate('window.dispatchEvent(new Event("blur"))');
      await wait(() => evaluate('!document.querySelector("textarea")'));
      const starts = count("voice-start");
      replyLatest(); await pause();
      report.assertions[`${close}BeforeTargetPreventsVoiceStart`] = count("voice-start") === starts;
      report.assertions[`${close}KeepsInputClosedAfterTarget`] = await evaluate('!document.querySelector("textarea")');
      report.assertions[`${close}ClearsTargetLoadingHint`] = await evaluate('!document.querySelector(".pet-message")');
    }

    replyLatest = null;
    await open();
    const originalReply = replyLatest, requests = count("latest");
    await escape();
    await wait(() => evaluate('!document.querySelector("textarea")'));
    await open();
    originalReply();
    await wait(() => Boolean(replyStart));
    report.assertions.reopenedVoiceConsumesPendingTargetOnce = count("latest") === requests && count("voice-start") === 1;
    await wait(() => evaluate('Boolean(document.querySelector(".pet-voice"))'));
    const cancels = count("voice-cancel");
    await evaluate('document.querySelector(".pet-voice button:last-child").click()');
    await wait(() => count("voice-cancel") > cancels);
    report.assertions.cancelPassesWhileStartReceiptPending = true;
    replyStart(); await pause();
    report.assertions.cancelledStartCannotResumeFromLateReceipt = await evaluate('window.__JUGGLEWORK_PET__.getState().then(state => state.voicePhase === "idle")');

    await escape();
    await wait(() => evaluate('!document.querySelector("textarea")'));
    replyLatest = null; replyStart = null;
    await open(); replyLatest();
    await wait(() => Boolean(replyStart));
    await wait(() => evaluate('Boolean(document.querySelector(".pet-voice"))'));
    const stops = count("voice-stop");
    await evaluate('document.querySelector(".pet-voice button").click()');
    await wait(() => count("voice-stop") > stops);
    report.assertions.stopPassesWhileStartReceiptPending = true;
    replyStart(); await pause();

    await escape();
    await wait(() => evaluate('!document.querySelector("textarea")'));
    const savedTarget = { ...target, key: "w:saved", sessionId: "saved", title: "已有草稿的会话" };
    await evaluate(`(async () => window.__JUGGLEWORK_PET__.remember(${JSON.stringify({ drafts: { __quick__: "未发送的草稿" }, targets: {}, dismissed: {}, target: savedTarget })}, (await window.__JUGGLEWORK_PET__.getState()).contextKey))()`);
    await wait(() => evaluate('window.__JUGGLEWORK_PET__.getState().then(state => state.interaction?.drafts.__quick__ === "未发送的草稿")'));
    controller.focus();
    await wait(() => evaluate('Boolean(document.querySelector(".pet-tools")) && !document.querySelectorAll(".pet-tools button")[1].disabled'));
    const savedStarts = count("voice-start"), savedLookups = count("latest");
    replyStart = null;
    await evaluate('document.querySelectorAll(".pet-tools button")[1].click()');
    await wait(() => Boolean(replyStart));
    report.assertions.savedDraftStartsVoiceWithoutTargetLookup = count("voice-start") === savedStarts + 1 && count("latest") === savedLookups;
    report.assertions.savedDraftKeepsSelectedVoiceTarget = voiceTarget?.key === savedTarget.key;
    report.assertions.savedDraftSurvivesVoiceOpen = await evaluate('document.querySelector("textarea")?.value === "未发送的草稿"');
    await wait(() => evaluate('Boolean(document.querySelector(".pet-voice"))'));
    await evaluate('document.querySelector(".pet-voice button:last-child").click()');
    replyStart(); await pause();
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    process.exitCode = Object.values(report.assertions).every(Boolean) ? 0 : 1;
  } catch (error) { console.error(error); console.error(JSON.stringify(report)); process.exitCode = 1; }
  finally { controller.dispose(); main.destroy(); app.exit(process.exitCode ?? 0); }
});
