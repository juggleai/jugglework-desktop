import { app, BrowserWindow, ipcMain, screen, Menu } from "electron";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDesktopPet } from "../electron/pet-window.mjs";
const output = mkdtempSync(join(tmpdir(), "juggle-pet-review-"));
app.setPath("userData", join(output, "profile"));
void app.whenReady().then(async () => {
const main = new BrowserWindow({ show: false });
await main.loadURL("about:blank");
const controller = createDesktopPet({ BrowserWindow, screen, ipcMain, Menu, preferencesPath: join(output, "pet.json"), preloadPath: resolve(import.meta.dirname, "../electron/pet-preload.mjs"), getMainWindow: () => main, loadPage: (win) => win.loadURL(process.env.JUGGLEWORK_PET_SMOKE_URL || "http://127.0.0.1:5191/pet.html") });
// TIPS: 使用隔离账号目录和延迟回执验证真实原生窗口，不连接业务服务。
let pet;
const assertions = {};
const A = { key: "p:a", workspaceId: "p", sessionId: "a", project: "project", title: "Old A" };
const B = { ...A, key: "p:b", sessionId: "b", title: "Latest B" };
let latestCount = 0, replyLatest, replySend, replySendQueued, replySendError, replyOrdinaryError, sent = [];
const originalSend = main.webContents.send.bind(main.webContents);
main.webContents.send = (channel, payload) => {
  if (channel !== "jugglework:pet:host-action") return originalSend(channel, payload);
  const reply = (result) => ipcMain.emit("jugglework:pet:host-reply", { sender: main.webContents }, { requestId: payload.requestId, result });
  const action = payload.action;
  if (action.type === "latest") { latestCount++; if (latestCount === 2) replyLatest = () => reply({ target: B }); else reply({ target: latestCount === 1 ? A : B }); }
  else if (action.type === "send") {
    sent.push(action); replySend = () => reply({ delivery: "sent" });
    replySendQueued = () => reply({ delivery: "queued" });
    replyOrdinaryError = () => ipcMain.emit("jugglework:pet:host-reply", { sender:main.webContents }, { requestId:payload.requestId, error:"隔离测试：提交失败" });
    replySendError = () => ipcMain.emit("jugglework:pet:host-reply", { sender:main.webContents }, { requestId:payload.requestId, error:"发送结果待确认，请核对原任务" });
  }
  else if (action.type === "sessions") reply({ targets:[A,B] });
  else reply({});
};
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
const evaluate = async (code) => {
  try { return await pet.webContents.executeJavaScript(code); }
  catch (error) { throw new Error(`${error.message}\nUI expression: ${code}`); }
};
const wait = async (predicate) => { const until = Date.now() + 6000; while(Date.now() < until) { if (await predicate()) return; await pause(); } throw new Error("timeout"); };
const uiWait = (code) => wait(() => evaluate(code));
const field = '.pet-composer textarea';
const draft = (value) => evaluate(`(() => { const field=document.querySelector(${JSON.stringify(field)}); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(value)}); field.dispatchEvent(new Event('input',{bubbles:true})); })()`);
const open = async () => { controller.focus(); await uiWait('Boolean(document.querySelector(".pet-tools"))'); await evaluate('document.querySelector(".pet-tools button").click()'); await uiWait('Boolean(document.querySelector(".pet-composer textarea"))'); };
const send = async () => { replySend = null; await evaluate('document.querySelector(".pet-send").click()'); await wait(() => Boolean(replySend)); };
try {
  await controller.setVisible(true); pet=BrowserWindow.getAllWindows().find(win=>win!==main);
  ipcMain.emit("jugglework:pet:publish", { sender:main.webContents }, { contextKey:"review", ready:true, syncing:false, partial:false, tasks:[], locale:"en", theme:"light", editing:false, voicePhase:"idle" });
  await uiWait('Boolean(document.querySelector(".pet-character"))');
  await open(); await uiWait('document.querySelector(".pet-target").textContent.includes("Old A")');
  await draft("initial"); await send(); replySend(); await uiWait('Boolean(document.querySelector(".pet-tools"))');
  assertions.successDoesNotLeaveConfirmationMessage = await evaluate('!document.querySelector(".pet-message")');
  await open(); await wait(()=>Boolean(replyLatest)); await draft("while latest is loading");
  const beforeLoadingSend = sent.length;
  assertions.loadingDisablesButton = await evaluate('document.querySelector(".pet-send").disabled');
  await evaluate('document.querySelector(".pet-send").click(); document.querySelector(".pet-composer textarea").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
  await pause();
  assertions.loadingBlocksEnterAndButton = sent.length === beforeLoadingSend;
  replyLatest(); await uiWait('document.querySelector(".pet-target").textContent.includes("Latest B")');
  await send(); assertions.resolvedSendUsesLatestTarget = sent.at(-1).target.key === B.key;
  replySend(); await uiWait('Boolean(document.querySelector(".pet-tools"))');

  await open(); await uiWait('document.querySelector(".pet-target").textContent.includes("Latest B")');
  await draft("queued draft"); await send(); replySendQueued();
  await uiWait('document.querySelector(".pet-message")?.textContent.includes("Added to queue")');
  assertions.queuedHintAppears = true;
  const queuedAt = Date.now();
  await uiWait('!document.querySelector(".pet-message")');
  assertions.queuedHintExpires = Date.now() - queuedAt >= 2500;

  await open(); await uiWait('document.querySelector(".pet-target").textContent.includes("Latest B")');
  await draft("failed draft"); await send(); replyOrdinaryError();
  await uiWait('document.querySelector(".pet-message")?.textContent.includes("提交失败")');
  assertions.submitErrorKeepsDraft = await evaluate('document.querySelector(".pet-composer textarea").value === "failed draft"');
  const errorAt = Date.now();
  await new Promise(resolve => setTimeout(resolve, 1000));
  await draft("queued after error"); await send(); replySendQueued();
  await uiWait('document.querySelector(".pet-message")?.textContent.includes("Added to queue")');
  const newerAt = Date.now();
  await new Promise(resolve => setTimeout(resolve, 2200));
  assertions.newFeedbackSurvivesPreviousTimeout = await evaluate('document.querySelector(".pet-message")?.textContent.includes("Added to queue")');
  await uiWait('!document.querySelector(".pet-message")');
  assertions.submitErrorHintExpires = newerAt - errorAt < 3000 && Date.now() - newerAt >= 2500;
  if (await evaluate('Boolean(document.querySelector(".pet-composer textarea"))')) await evaluate('document.querySelector(".pet-composer textarea").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');

  await open(); await uiWait('document.querySelector(".pet-target").textContent.includes("Latest B")');
  await draft("submitted text"); await send(); await draft("new unsent text typed during request"); replySend();
  await uiWait('!document.querySelector(".pet-send").disabled');
  const afterEditingDuringSend = await evaluate('window.__JUGGLEWORK_PET__.getState().then(s=>s.interaction)');
  assertions.acceptancePreservesNewDraft = afterEditingDuringSend.drafts.__quick__ === "new unsent text typed during request";
  assertions.acceptanceKeepsNewDraftEditor = await evaluate('document.querySelector(".pet-composer textarea").value === "new unsent text typed during request"');

  await draft("submitted before hide"); await send(); const acknowledgeHiddenSend=replySend;
  await controller.setVisible(false);
  await controller.setVisible(true); pet=BrowserWindow.getAllWindows().find(win=>win!==main);
  await uiWait('Boolean(document.querySelector(".pet-character"))');
  await open(); await uiWait('document.querySelector(".pet-composer textarea").value === "submitted before hide"');
  assertions.reopenedPendingSendDisabled = await evaluate('document.querySelector(".pet-send").disabled');
  const beforePendingSend=sent.length;
  await evaluate('document.querySelector(".pet-composer textarea").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
  await pause(); assertions.reopenedPendingSendBlocksEnter = sent.length === beforePendingSend;
  await controller.setVisible(false); acknowledgeHiddenSend(); await pause();
  await controller.setVisible(true); pet=BrowserWindow.getAllWindows().find(win=>win!==main);
  await uiWait('Boolean(document.querySelector(".pet-character"))');
  const afterHiddenSend = await evaluate('window.__JUGGLEWORK_PET__.getState().then(s=>s.interaction)');
  assertions.hiddenAcceptanceClearsOriginalDraft = afterHiddenSend.drafts.__quick__ === "";
  await open(); await uiWait('document.querySelector(".pet-target").textContent.includes("Latest B")');
  assertions.reopenedAcceptedDraftIsEmpty = await evaluate('document.querySelector(".pet-composer textarea").value === "" && document.querySelector(".pet-send").disabled');

  // TIPS: A的延迟成功回执只能关闭A；B卡与快捷输入中的新编辑都必须继续保留。
  ipcMain.emit("jugglework:pet:publish", { sender: main.webContents }, {
    contextKey:"review",ready:true,syncing:false,partial:false,locale:"en",theme:"light",voicePhase:"idle",
    tasks:[A,B].map(target=>({...target,turnKey:target.sessionId,state:"running",statusText:"Working",canStop:true})),
  });
  await evaluate('document.querySelector(".pet-composer textarea").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  const showCards = async () => {
    controller.focus(); await uiWait('document.querySelector(".pet-tools")?.dataset.visible === "true"');
    await evaluate('document.querySelectorAll(".pet-tools button")[2].click()');
    await uiWait('document.querySelector(".pet-card")');
    await evaluate('document.querySelector(".pet-card").click()');
    await uiWait('document.querySelectorAll(".pet-card").length===2');
  };
  const cardDraft = (text) => evaluate(`(()=>{const e=document.querySelector('.pet-follow textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await showCards();
  await evaluate('document.querySelectorAll(".pet-card")[0].querySelector(".pet-card-actions button").click()');
  await uiWait('document.querySelector(".pet-follow textarea")'); await cardDraft('submit A');
  const previousSend=replySend;
  await evaluate('document.querySelector(".pet-follow .pet-send").click()'); await wait(()=>replySend!==previousSend);
  const receiptA=replySend;
  await evaluate('document.querySelectorAll(".pet-card")[1].querySelector(".pet-card-actions button").click()');
  await uiWait('document.querySelector(".pet-follow textarea")?.getAttribute("aria-label")?.includes("Latest B")');
  await cardDraft('unsent B'); receiptA(); await pause();
  assertions.lateCardReceiptKeepsOtherCardEditor = await evaluate('document.querySelector(".pet-follow textarea")?.value === "unsent B" && document.querySelectorAll(".pet-card").length===2');

  await evaluate('document.querySelectorAll(".pet-tools button")[2].click()');
  await open(); await draft('quick A pending');
  const previousQuick=replySend;await send();await wait(()=>replySend!==previousQuick);const quickReceipt=replySend;
  await evaluate('document.querySelector(".pet-composer textarea").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await showCards();
  await evaluate('document.querySelectorAll(".pet-card")[0].querySelector(".pet-card-actions button").click()');
  await uiWait('document.querySelector(".pet-follow textarea")');await cardDraft('new card editor');quickReceipt();await pause();
  assertions.lateQuickReceiptKeepsTaskListAndCardEditor = await evaluate('document.querySelector(".pet-task-panel")?.dataset.visible === "true" && document.querySelector(".pet-follow textarea")?.value === "new card editor"');
  await cardDraft('unknown A');const previousUnknown=replySendError;
  await evaluate('document.querySelector(".pet-follow .pet-send").click()');await wait(()=>replySendError!==previousUnknown);replySendError();
  await uiWait('document.querySelector(".pet-follow .pet-send")?.disabled');
  await evaluate('document.querySelectorAll(".pet-tools button")[2].click()');await open();
  await evaluate('document.querySelector(".pet-input-plus").click()');await uiWait('document.querySelectorAll(".pet-session-option").length===2');
  await evaluate('document.querySelector(".pet-session-option").click()');await draft('retry A');
  const beforeUnknownRetry=sent.length;
  assertions.unconfirmedCardAlsoDisablesQuickInput = await evaluate('document.querySelector(".pet-send").disabled');
  await evaluate('document.querySelector(".pet-composer textarea").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');await pause();
  assertions.unconfirmedTaskBlocksOtherEntryEnter = sent.length===beforeUnknownRetry;
  await uiWait('Boolean(document.querySelector(".pet-message button"))');
  await evaluate('document.querySelector(".pet-message button").click()');
  await uiWait('!document.querySelector(".pet-send").disabled');
  await send();await wait(()=>sent.length===beforeUnknownRetry+1);replySend();
  assertions.checkedRetryReleasesOnlyAfterExplicitAction = true;

  // TIPS: 已读/关闭保留宿主任务事实；无铃铛时仍能从编辑入口恢复草稿，且不覆盖普通快捷输入。
  for (const removal of ["read", "dismiss"]) {
    const completed = { ...A, key: `p:${removal}`, sessionId: removal, title: `Recover ${removal}`, turnKey: `turn-${removal}`, state: "completed", statusText: "Completed", canStop: false };
    ipcMain.emit("jugglework:pet:publish", { sender: main.webContents }, {
      contextKey: `recover-${removal}`, ready: true, syncing: false, partial: false, locale: "en", theme: "light", voicePhase: "idle", tasks: [completed],
    });
    controller.focus();
    await uiWait('document.querySelector(".pet-tools")?.dataset.visible === "true" && document.querySelectorAll(".pet-tools button").length === 3');
    await evaluate('document.querySelectorAll(".pet-tools button")[2].click()');
    await uiWait('document.querySelector(".pet-card")');
    await evaluate('document.querySelector(".pet-card").click()');
    await uiWait('document.querySelector(".pet-card-actions")');
    await evaluate('document.querySelector(".pet-card-actions button").click()');
    await uiWait('document.querySelector(".pet-follow textarea")');
    await cardDraft(`unsent ${removal}`);
    await evaluate(`document.querySelector(${JSON.stringify(removal === "read" ? ".pet-title" : ".pet-close")}).click()`);
    await uiWait('!document.querySelector(".pet-card") && !document.querySelector("textarea")');
    await uiWait('document.querySelector(".pet-sprite").style.backgroundImage.includes("typing.png")');
    assertions[`${removal}ClearsHiddenEditorAndReturnsIdle`] = true;
    assertions[`${removal}ExposesSavedDraftInTaskPanel`] = removal === "read"
      ? await evaluate('Boolean(document.querySelector(".pet-drafts button"))')
      : await evaluate('document.querySelectorAll(".pet-tools button").length === 2');
    if (removal === "read") await evaluate('document.querySelectorAll(".pet-tools button")[2].click()');
    await uiWait('document.querySelectorAll(".pet-tools button").length === 2');
    assertions[`${removal}DraftDoesNotCreateBell`] = true;

    await controller.setVisible(false); await controller.setVisible(true);
    pet = BrowserWindow.getAllWindows().find(win => win !== main);
    await uiWait('Boolean(document.querySelector(".pet-character"))');
    await open(); await uiWait('document.querySelector(".pet-target").textContent.includes("Latest B")');
    await draft(`independent quick ${removal}`);
    await evaluate('document.querySelector(".pet-drafts button").click()');
    await uiWait(`document.querySelector(".pet-composer textarea")?.value === ${JSON.stringify(`unsent ${removal}`)}`);
    assertions[`${removal}RecoversAfterHideWithOriginalTarget`] = await evaluate(`document.querySelector(".pet-target").textContent.includes(${JSON.stringify(completed.title)}) && document.querySelector(".pet-input-plus").disabled`);
    await draft(`recovered ${removal}`); await send();
    assertions[`${removal}RecoveredSendTargetsOriginalTask`] = sent.at(-1).target.key === completed.key && sent.at(-1).draftKey === completed.key;
    replySend(); await uiWait('Boolean(document.querySelector(".pet-tools"))');
    const saved = await evaluate('window.__JUGGLEWORK_PET__.getState().then(s => s.interaction)');
    assertions[`${removal}AcceptanceClearsOnlyRecoveredDraft`] = saved.drafts[completed.key] === "" && saved.drafts.__quick__ === `independent quick ${removal}`;
    await open(); await uiWait(`document.querySelector(".pet-composer textarea")?.value === ${JSON.stringify(`independent quick ${removal}`)}`);
    assertions[`${removal}DefaultDraftAndTargetRemainSeparate`] = await evaluate('document.querySelector(".pet-target").textContent.includes("Latest B") && !document.querySelector(".pet-drafts")');
  }
  console.log(JSON.stringify({ output, assertions },null,2));
  if (Object.values(assertions).some(value=>!value)) process.exitCode=1;
} catch(error) { console.error(error); process.exitCode=1; }
finally { controller.dispose(); main.destroy(); app.exit(process.exitCode||0); }

});
