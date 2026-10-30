import { app, BrowserWindow, ipcMain, screen, Menu } from "electron";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createDesktopPet } from "../electron/pet-window.mjs";

// TIPS: 仅验证隔离原生窗口和展示交互；不连接服务端、不读取生产账号、不发送真实任务。
const output = mkdtempSync(join(tmpdir(), "juggle-pet-smoke-"));
app.setPath("userData", join(output, "profile"));
void app.whenReady().then(async () => {
const main = new BrowserWindow({ show: false });
await main.loadURL(process.env.JUGGLEWORK_PET_SMOKE_URL || "http://127.0.0.1:5191/pet.html");
main.webContents.setZoomFactor(1.1);
const controller = createDesktopPet({ BrowserWindow, screen, ipcMain, Menu, preferencesPath: join(output, "pet.json"), preloadPath: resolve(import.meta.dirname, "../electron/pet-preload.mjs"), getMainWindow: () => main, loadPage: (window) => window.loadURL(process.env.JUGGLEWORK_PET_SMOKE_URL || "http://127.0.0.1:5191/pet.html") });
const errors = [];
const report = { output, assertions: {}, errors, actions: [], realBackend: false };
try {
  let latestRequests = 0;
  let failNextOpen = false;
  const fixtureTarget = { key: "fixture:root", workspaceId: "fixture", sessionId: "root", project: "隔离展示测试", title: "ios-review" };
  const otherTarget = { key: "other:history", workspaceId: "other", sessionId: "history", project: "另一个项目", title: "历史会话" };
  const capabilityTargets = [
    { id: "extension:vision", group: "plugins", kind: "extension", name: "Vision", description: "看图" },
    { id: "mcp:calendar", group: "mcp", kind: "mcp", name: "Calendar", description: "日历" },
    { id: "skill:review", group: "skills", kind: "skill", name: "Review", description: "代码检查" },
  ];
  let releaseConnections;
  let sessionTargets = [fixtureTarget, otherTarget, ...Array.from({ length: 12 }, (_, index) => ({ ...otherTarget, key: `other:history-${index}`, sessionId: `history-${index}`, title: `历史会话 ${index + 1}` }))];
  // 演示宿主只回执展示动作，避免遗留等待中的测试IPC。
  const originalSend = main.webContents.send.bind(main.webContents);
  main.webContents.send = (channel, payload) => {
    if (channel === "jugglework:pet:host-action") {
      report.actions.push(payload.action);
      if (payload.action.type === "open" && failNextOpen) {
        failNextOpen = false;
        ipcMain.emit("jugglework:pet:host-reply", { sender: main.webContents }, { requestId: payload.requestId, error: "隔离测试：打开失败" });
        return;
      }
      if (payload.action.type === "capabilities" && payload.action.scope === "connections") {
        releaseConnections = () => ipcMain.emit("jugglework:pet:host-reply", { sender: main.webContents }, { requestId: payload.requestId, result: { capabilities: capabilityTargets.filter((item) => item.group === "mcp") } });
        return;
      }
      const result = payload.action.type === "send" ? { delivery: "sent" }
        : payload.action.type === "capabilities" ? { capabilities: payload.action.scope === "basic" ? capabilityTargets.filter((item) => item.group !== "mcp") : capabilityTargets.filter((item) => item.group === "mcp") }
        : payload.action.type === "sessions" ? { targets: sessionTargets }
        : payload.action.type === "latest" && ++latestRequests === 1 ? { target: fixtureTarget } : {};
      ipcMain.emit("jugglework:pet:host-reply", { sender: main.webContents }, { requestId: payload.requestId, result });
    }
    else originalSend(channel, payload);
  };
  await controller.setVisible(true);
  const pet = BrowserWindow.getAllWindows().find((window) => window !== main);
  let latestLayout;
  ipcMain.on("jugglework:pet:layout", (_event, value) => { latestLayout = value; });
  pet.webContents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
  pet.webContents.on("render-process-gone", (_event, details) => errors.push(JSON.stringify(details)));
  ipcMain.emit("jugglework:pet:publish", { sender: main.webContents }, { contextKey: "isolated-smoke", ready: true, syncing: false, partial: false, locale: "zh", theme: "light", editing: false, voicePhase: "idle", voiceAvailable: false, tasks: [
    { ...fixtureTarget, turnKey: "turn-1", state: "running", statusText: "正在思考", progressText: "已运行命令", canStop: true },
    { key: "fixture:logo", workspaceId: "fixture", sessionId: "logo", project: "隔离展示测试", title: "设计蓝色文档编辑器 Logo", turnKey: "turn-2", state: "resumable", stopped: true, statusText: "已停止", canStop: false },
    { key: "fixture:done", workspaceId: "fixture", sessionId: "done", project: "隔离展示测试", title: "日报", turnKey: "turn-done", state: "completed", statusText: "已完成", progressText: "Ben 今日日报（10 月 23 日）", canStop: false },
  ] });
  const evaluate = async (code) => {
    try { return await pet.webContents.executeJavaScript(code); }
    catch (error) { throw new Error(`${error.message}\nUI expression: ${code}`); }
  };
  const captureReference = async (name) => {
    // 对照图只给隔离预览画布铺白底，发布页及透明像素检查仍使用透明背景。
    await evaluate('document.documentElement.style.background = "#fff"');
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await new Promise((resolve) => setTimeout(resolve, 120));
    writeFileSync(join(output, `reference-${name}.png`), (await pet.webContents.capturePage()).toPNG());
    await evaluate('document.documentElement.style.removeProperty("background")');
  };
  const waitFor = async (code) => {
    const until = Date.now() + 5000;
    while (Date.now() < until) { if (await evaluate(code)) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
    throw new Error(`UI assertion timed out: ${code}`);
  };
  await waitFor('Boolean(document.querySelector(".pet-character"))');
  const before = pet.getBounds();
  const char = await evaluate('(()=>{const r=document.querySelector(".pet-character").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()');
  report.assertions.codexMatchedSize = Math.abs(char.width - 104) < 1 && Math.abs(char.height - 112.667) < 1;
  report.assertions.independentOfMainZoom = pet.webContents.getZoomFactor() === 1 && main.webContents.getZoomFactor() === 1.1;
  report.assertions.nativeWidthStable = Math.abs(pet.getBounds().width - 400) < 1;
  await waitFor('getComputedStyle(document.querySelector(".pet-bubble")).opacity === "1"');
  report.assertions.idleShowsSmallBubble = await evaluate('(()=>{const bubble=document.querySelector(".pet-bubble"), style=getComputedStyle(document.querySelector(".pet-control-surface")); return style.width === "24px" && style.height === "6px" && bubble.dataset.visible === "true"})()');
  report.assertions.bubbleCloserByOneCapsuleHeight = await evaluate('document.querySelector(".pet-bubble").getBoundingClientRect().top - document.querySelector(".pet-controls").getBoundingClientRect().top === -6');
  await waitFor('getComputedStyle(document.querySelector(".pet-control-surface")).backgroundColor === "rgb(0, 164, 66)"');
  report.assertions.unreadCompletionFillsBubbleGreen = true;
  const restingState = await evaluate('window.__JUGGLEWORK_PET__.getState()');
  ipcMain.emit("jugglework:pet:publish", { sender: main.webContents }, { ...restingState, tasks: restingState.tasks.filter((task) => task.state !== "completed") });
  await waitFor('document.querySelector(".pet-bubble").dataset.completed === "false"');
  await new Promise((resolve) => setTimeout(resolve, 220));
  report.assertions.noUnreadCompletionRestoresNeutralBubble = await evaluate('getComputedStyle(document.querySelector(".pet-control-surface")).backgroundColor !== "rgb(0, 164, 66)"');
  await captureReference("idle-bubble-neutral");
  ipcMain.emit("jugglework:pet:publish", { sender: main.webContents }, restingState);
  await waitFor('getComputedStyle(document.querySelector(".pet-control-surface")).backgroundColor === "rgb(0, 164, 66)"');
  report.assertions.hiddenToolbarCannotReceiveInput = await evaluate('document.querySelector(".pet-tools").inert && !document.querySelector(".pet-controls").hasAttribute("data-pet-hit")');
  const slot = await evaluate('(()=>{const r=document.querySelector(".pet-controls").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width}})()');
  const hits = (x, y) => latestLayout?.regions.some((rect) => x >= rect.x && y >= rect.y && x <= rect.x + rect.width && y <= rect.y + rect.height);
  report.assertions.collapsedToolbarSidesPassThrough = !hits(slot.x + 4, slot.y + 10) && !hits(slot.x + slot.width - 4, slot.y + 10) && hits(slot.x + slot.width / 2, slot.y + 2);
  await captureReference("idle-bubble");
  await evaluate('window.__petSurface = document.querySelector(".pet-control-surface"); document.querySelector(".pet-bubble").click()');
  await waitFor('document.querySelector(".pet-tools").dataset.visible === "true"');
  report.assertions.bubbleInflatesIntoToolbar = await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {const surface=document.querySelector(".pet-control-surface"); resolve(surface === window.__petSurface && getComputedStyle(surface).opacity === "1" && ["width", "height"].every(property => surface.getAnimations().some(animation => animation.transitionProperty === property && animation.effect.getTiming().duration === 260))) })))');
  await waitFor('getComputedStyle(document.querySelector(".pet-tools")).opacity === "1"');
  await evaluate('document.activeElement.blur(); document.querySelector(".pet-root").dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: null }))');
  await waitFor('document.querySelector(".pet-tools").dataset.visible === "false"');
  report.assertions.toolbarDeflatesIntoSameBubble = await evaluate('document.querySelector(".pet-control-surface") === window.__petSurface && ["width", "height"].every(property => document.querySelector(".pet-control-surface").getAnimations().some(animation => animation.transitionProperty === property && animation.effect.getTiming().duration === 260))');
  await waitFor('getComputedStyle(document.querySelector(".pet-tools")).opacity === "0" && getComputedStyle(document.querySelector(".pet-bubble")).opacity === "1"');
  await waitFor('getComputedStyle(document.querySelector(".pet-control-surface")).width === "24px" && getComputedStyle(document.querySelector(".pet-control-surface")).height === "6px"');
  const collapsed = await evaluate('(()=>{const r=document.querySelector(".pet-character").getBoundingClientRect();return {x:r.x,y:r.y,height:document.querySelector(".pet-root").getBoundingClientRect().height}})()');
  const collapsedBounds = pet.getBounds();
  report.assertions.toolbarTransitionKeepsCharacterAnchor = Math.abs(before.x + char.x - collapsedBounds.x - collapsed.x) <= 1 && Math.abs(before.y + char.y - collapsedBounds.y - collapsed.y) <= 1;
  controller.focus();
  await waitFor('document.activeElement === document.querySelector(".pet-tools button")');
  report.assertions.firstFocusFindsNewToolbar = true;
  await waitFor('getComputedStyle(document.querySelector(".pet-tools")).opacity === "1"');
  await evaluate('document.activeElement.blur(); window.__JUGGLEWORK_PET__.keyboard(false)');
  await evaluate('document.querySelector(".pet-character").dispatchEvent(new PointerEvent("pointerup",{bubbles:true}))');
  await waitFor('document.querySelectorAll(".pet-tools button").length === 3');
  report.assertions.unconfiguredVoiceDisabled = await evaluate('document.querySelectorAll(".pet-tools button")[1].disabled');
  report.assertions.voiceHintMatchesComposer = await evaluate('document.querySelectorAll(".pet-tools button")[1].title === "未配置语音模型，请前往设置配置"');
  await waitFor('getComputedStyle(document.querySelector(".pet-control-surface")).width === "120px"');
  report.assertions.largeAndSmallBubblesShareTopAndCenter = await evaluate('(()=>{const surface=document.querySelector(".pet-control-surface").getBoundingClientRect(), slot=document.querySelector(".pet-controls").getBoundingClientRect(), tools=document.querySelector(".pet-tools").getBoundingClientRect();return surface.top === slot.top-6 && surface.top === tools.top && surface.x+surface.width/2 === slot.x+slot.width/2 && surface.width === tools.width && surface.height === tools.height})()');
  report.assertions.compactReferenceToolbar = await evaluate('(()=>{const r=document.querySelector(".pet-tools").getBoundingClientRect();return Math.abs(r.width-120)<1 && Math.abs(r.height-40)<1})()');
  writeFileSync(join(output, "toolbar.png"), (await pet.webContents.capturePage()).toPNG());
  await captureReference("toolbar");
  // TIPS: 结束态锚点相同也可能中间闪一帧；逐帧记录人物与视口底边的距离，覆盖原生扩缩窗等待期。
  await evaluate(`(() => {
    window.__bellFrames = []; window.__samplingBell = true; window.__bellCharacter = document.querySelector('.pet-character');
    const sample = () => {
      if (!window.__samplingBell) return;
      const node = document.querySelector('.pet-character'), rect = node.getBoundingClientRect();
      window.__bellFrames.push({ gap: innerHeight - rect.bottom, clipped: rect.top < 0 || rect.bottom > innerHeight, same: node === window.__bellCharacter, image: node.querySelector('.pet-sprite').style.backgroundImage });
      requestAnimationFrame(sample);
    }; sample();
  })()`);
  const fourthTask = { ...restingState.tasks[0], key: "fixture:extra", sessionId: "extra", title: "额外任务" };
  ipcMain.emit("jugglework:pet:publish", { sender: main.webContents }, { ...restingState, tasks: [...restingState.tasks, fourthTask] });
  await waitFor('document.querySelector(".pet-badge")?.textContent === "4"');
  await evaluate('document.querySelectorAll(".pet-tools button")[2].click()');
  await waitFor('document.querySelector(".pet-title strong")?.textContent === "ios-review"');
  report.assertions.bellOpensStackFirst = await evaluate('document.querySelector(".pet-task-panel").dataset.folded === "true" && document.querySelectorAll(".pet-card").length === 1 && !document.querySelector(".pet-stack-count") && !document.querySelector(".pet-badge")');
  report.assertions.stackFadesIn = await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.querySelector(".pet-task-panel").getAnimations().some(animation => animation.transitionProperty === "opacity" && animation.effect.getTiming().duration === 180)))))');
  await waitFor('getComputedStyle(document.querySelector(".pet-task-panel")).opacity === "1"');
  let matchingLayers = true, frontIsLargest = true;
  for (const count of [1, 2, 4]) {
    const tasks = count === 4 ? [...restingState.tasks, fourthTask] : restingState.tasks.slice(0, count);
    ipcMain.emit("jugglework:pet:publish", { sender: main.webContents }, { ...restingState, tasks });
    await waitFor(`document.querySelector(".pet-card-shell")?.dataset.stackSize === "${count}"`);
    const geometry = await evaluate('(()=>{const shell=document.querySelector(".pet-card-shell");return {layers:shell.querySelectorAll(".pet-stack-layer").length,widths:[shell.querySelector(".pet-card"),...shell.querySelectorAll(".pet-stack-layer")].map(node=>node.getBoundingClientRect().width)}})()');
    matchingLayers &&= geometry.layers === count - 1;
    frontIsLargest &&= geometry.widths.every((width, index, all) => index === 0 || width < all[index - 1]);
  }
  report.assertions.stackLayerCountMatchesOneTwoAndFourReminders = matchingLayers;
  report.assertions.stackFrontIsLargestAndBacksShrink = frontIsLargest;
  ipcMain.emit("jugglework:pet:publish", { sender: main.webContents }, restingState);
  await waitFor('document.querySelector(".pet-card-shell")?.dataset.stackSize === "3"');
  await evaluate('document.querySelectorAll(".pet-tools button")[2].click()');
  await waitFor('document.querySelector(".pet-task-panel")?.dataset.visible === "false"');
  report.assertions.stackFadesOutAndImmediatelyDisablesInput = await evaluate('document.querySelector(".pet-task-panel").inert && !document.querySelector(".pet-task-panel").hasAttribute("data-pet-hit") && document.querySelector(".pet-task-panel").dataset.folded === "true" && document.querySelector(".pet-task-panel").getAnimations().some(animation => animation.transitionProperty === "opacity" && animation.effect.getTiming().duration === 180)');
  await waitFor('!document.querySelector(".pet-task-panel")');
  let smallListsOpenDirectly = true;
  for (const count of [1, 2, 3]) {
    ipcMain.emit("jugglework:pet:publish", { sender: main.webContents }, { ...restingState, tasks: restingState.tasks.slice(0, count) });
    await waitFor(`document.querySelector(".pet-badge")?.textContent === "${count}"`);
    await evaluate('document.querySelectorAll(".pet-tools button")[2].click()');
    await waitFor(`document.querySelectorAll(".pet-card").length === ${count} && document.querySelector(".pet-task-panel")?.dataset.folded === "false"`);
    smallListsOpenDirectly &&= await evaluate('!document.querySelector(".pet-stack-layer") && Boolean(document.querySelector(".pet-close"))');
    if (count !== 3) {
      await evaluate('document.querySelectorAll(".pet-tools button")[2].click()');
      await waitFor('!document.querySelector(".pet-task-panel")');
    }
  }
  report.assertions.oneToThreeBellOpensFullList = smallListsOpenDirectly;
  await waitFor('document.querySelector(".pet-cards").getBoundingClientRect().height > 30');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = pet.getBounds();
  const expanded = await evaluate('(()=>{const r=document.querySelector(".pet-character").getBoundingClientRect();return {x:r.x,y:r.y,bodyHeight:document.querySelector(".pet-root").getBoundingClientRect().height,bell:document.querySelectorAll(".pet-tools button")[2].getAttribute("aria-expanded")}})()');
  report.assertions.anchorStable = Math.abs(before.x + char.x - after.x - expanded.x) <= 1 && Math.abs(before.y + char.y - after.y - expanded.y) <= 1;
  report.assertions.expanded = expanded.bell === "true";
  report.assertions.expandedArrowHasNoBadge = await evaluate('!document.querySelector(".pet-badge")');
  report.assertions.fitsWindow = expanded.bodyHeight <= after.height + 1;
  report.assertions.cardsUseSharedProgress = await evaluate('document.querySelector(".pet-title span").textContent === "已运行命令"');
  report.assertions.cardsHaveShadowGutters = await evaluate('(()=>{const r=document.querySelector(".pet-card").getBoundingClientRect();return r.left>=24 && innerWidth-r.right>=24})()');
  report.assertions.stoppedShowsOrangeDotOnly = await evaluate('Boolean(document.querySelectorAll(".pet-card")[1].querySelector(".pet-stopped")) && getComputedStyle(document.querySelector(".pet-stopped")).backgroundColor === "rgb(245, 158, 11)" && !document.querySelector(".pet-card textarea") && ![...document.querySelectorAll(".pet-card button")].some(button => button.textContent === "继续任务")');
  writeFileSync(join(output, "tasks.png"), (await pet.webContents.capturePage()).toPNG());
  await captureReference("tasks");
  await evaluate('document.querySelectorAll(".pet-tools button")[2].click()');
  await waitFor('!document.querySelector(".pet-task-panel")');
  report.assertions.arrowHidesEntireList = await evaluate('document.querySelectorAll(".pet-tools button")[2].getAttribute("aria-expanded") === "false" && document.querySelectorAll(".pet-card").length === 0');
  await evaluate('window.__samplingBell = false');
  const bellFrames = await evaluate('window.__bellFrames');
  report.assertions.bellKeepsPetStableBetweenFrames = bellFrames.every((frame) => Math.abs(frame.gap - bellFrames[0].gap) <= 1);
  report.assertions.bellNeverClipsOrRecreatesPet = bellFrames.every((frame) => !frame.clipped && frame.same);
  report.assertions.bellDoesNotTriggerHoverAnimation = bellFrames.every((frame) => !frame.image.includes("celebrate.png"));
  writeFileSync(join(output, "bell-frames.json"), JSON.stringify(bellFrames, null, 2));
  report.assertions.badgeReturnsOnlyWithBell = await evaluate('Boolean(document.querySelector(".lucide-bell")) && document.querySelector(".pet-badge").textContent === "3"');
  ipcMain.emit("jugglework:pet:publish", { sender: main.webContents }, { ...restingState, tasks: [...restingState.tasks, fourthTask] });
  await waitFor('document.querySelector(".pet-badge")?.textContent === "4"');
  await evaluate('document.querySelectorAll(".pet-tools button")[2].click()');
  await waitFor('document.querySelector(".pet-task-panel").dataset.folded === "true"');
  report.assertions.bellReopensNotificationStack = await evaluate('document.querySelectorAll(".pet-card").length === 1 && !document.querySelector(".pet-stack-count")');
  await captureReference("stack");
  await evaluate('document.querySelector(".pet-title").click()');
  await waitFor('document.querySelectorAll(".pet-card").length === 4');
  ipcMain.emit("jugglework:pet:publish", { sender: main.webContents }, restingState);
  await waitFor('document.querySelectorAll(".pet-card").length === 3');
  report.assertions.stackOpensFullList = true;
  // TIPS: 模拟展开点击留下的标题焦点，防止首项因 focus-within 自动露出操作按钮。
  await evaluate('document.querySelector(".pet-title").focus()');
  report.assertions.expandingStackKeepsFirstActionsHidden = await evaluate('getComputedStyle(document.querySelector(".pet-card-actions")).opacity === "0" && getComputedStyle(document.querySelector(".pet-close")).opacity === "0" && getComputedStyle(document.querySelector(".pet-close")).pointerEvents === "none"');
  const cardPoint = await evaluate('(()=>{const rect=document.querySelector(".pet-card").getBoundingClientRect();return {x:Math.round(rect.x+120),y:Math.round(rect.y+25)}})()');
  pet.webContents.sendInputEvent({ type: "mouseMove", ...cardPoint });
  await waitFor('getComputedStyle(document.querySelector(".pet-card-actions")).opacity === "1"');
  report.assertions.hoverOnlyRevealsCurrentCardActions = await evaluate('getComputedStyle(document.querySelector(".pet-close")).opacity === "1" && getComputedStyle(document.querySelectorAll(".pet-card-actions")[1]).opacity === "0"');
  report.assertions.followUpMatchesStopStyle = await evaluate('(()=>{const buttons=[...document.querySelectorAll(".pet-card-actions button")].slice(0,2).map(node=>getComputedStyle(node));return buttons.every(style=>style.color === "rgb(153, 153, 153)" && style.backgroundColor === buttons[0].backgroundColor && style.borderRadius === buttons[0].borderRadius)})()');
  pet.webContents.sendInputEvent({ type: "mouseMove", x: 5, y: 5 });
  await waitFor('getComputedStyle(document.querySelector(".pet-card-actions")).opacity === "0"');
  report.assertions.leavingCardHidesActionsDespiteTitleFocus = await evaluate('getComputedStyle(document.querySelector(".pet-close")).opacity === "0"');
  await evaluate('document.querySelector(".pet-title").click()');
  await waitFor('Boolean(window.__JUGGLEWORK_PET__)');
  report.assertions.openRunningTaskKeepsRow = await evaluate('document.querySelectorAll(".pet-card").length === 3');
  report.assertions.taskNavigationRaisesMain = main.isVisible();
  report.assertions.passive = !pet.isFocusable();
  report.backgroundColor = pet.getBackgroundColor();
  main.hide(); report.assertions.independentOfMainHide = pet.isVisible();
  controller.focus();
  await waitFor('document.activeElement === document.querySelector(".pet-tools button")');
  await evaluate('document.querySelector(".pet-title").focus()');
  pet.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  pet.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  await waitFor('document.activeElement === document.querySelectorAll(".pet-card-head button")[1]');
  report.assertions.keyboardRevealsCardActions = await evaluate('getComputedStyle(document.querySelector(".pet-card-actions")).opacity === "1" && document.querySelector(".pet-card-actions").getBoundingClientRect().width > 32');
  await evaluate('document.querySelectorAll(".pet-card-head button")[1].click()');
  await waitFor('Boolean(document.querySelector(".pet-card textarea"))');
  report.assertions.emptyFollowUpShowsDisabledSend = await evaluate('(()=>{const button=document.querySelector(".pet-follow .pet-send");return button.disabled && getComputedStyle(button).display === "grid" && button.getBoundingClientRect().width === 28 && getComputedStyle(button).backgroundColor === "rgb(177, 204, 251)"})()');
  report.assertions.editingDoesNotPinCardActions = await evaluate('getComputedStyle(document.querySelector(".pet-card-actions")).opacity === "0" && getComputedStyle(document.querySelector(".pet-close")).opacity === "0"');
  await new Promise((resolve) => setTimeout(resolve, 100));
  report.assertions.explicitInputFocusable = pet.isFocusable();
  const capture = await pet.webContents.capturePage();
  report.assertions.transparent = capture.toBitmap()[3] === 0;
  writeFileSync(join(output, "expanded.png"), capture.toPNG());
  await captureReference("follow-up");
  const state = await evaluate('window.__JUGGLEWORK_PET__.getState()');
  ipcMain.emit("jugglework:pet:publish", { sender: main.webContents }, { ...state, theme: "dark" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  writeFileSync(join(output, "dark.png"), (await pet.webContents.capturePage()).toPNG());
  // 原生主窗口导航可能延后发出blur；录入前显式重新取得测试窗口焦点。
  pet.focus(); pet.webContents.focus();
  await evaluate('if (!document.querySelector(".pet-card textarea")) document.querySelectorAll(".pet-card-head button")[1].click()');
  await waitFor('Boolean(document.querySelector(".pet-card textarea"))');
  await evaluate(`(() => {
    const field = document.querySelector('.pet-card textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, '隔离测试跟进');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor('document.querySelector(".pet-card .pet-send")?.disabled === false');
  report.assertions.followUpEnabledSendMatchesComposer = await evaluate('(()=>{const button=document.querySelector(".pet-follow .pet-send"),style=getComputedStyle(button);return style.backgroundColor === "rgb(61, 130, 246)" && style.color === "rgb(255, 255, 255)" && button.querySelector("svg").getAttribute("stroke-width") === "1.6"})()');
  await evaluate('document.querySelector(".pet-card textarea").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }))');
  report.assertions.compositionEnterDoesNotSend = !report.actions.some((action) => action.type === "send");
  await evaluate('document.querySelector(".pet-card textarea").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))');
  await waitFor('!document.querySelector(".pet-card textarea")');
  report.assertions.followUpPinnedToOriginal = report.actions.some((action) => action.type === "send" && action.target.key === "fixture:root" && action.text === "隔离测试跟进");
  report.assertions.followUpDoesNotRaiseMain = !main.isVisible();
  report.assertions.enterKeepsRowAndList = await evaluate('document.querySelectorAll(".pet-card").length === 3 && document.querySelector(".pet-task-panel").dataset.folded === "false"');
  ipcMain.emit("jugglework:pet:publish", { sender: main.webContents }, { ...state, theme: "light" });
  await waitFor('document.documentElement.dataset.theme === "light"');
  await evaluate('document.querySelectorAll(".pet-card")[1].querySelector(".pet-card-actions button").click()');
  await waitFor('Boolean(document.querySelectorAll(".pet-card")[1].querySelector("textarea"))');
  report.assertions.stoppedEditorRequiresReplyClick = await evaluate('document.querySelector(".pet-card textarea").value === "" && document.querySelectorAll(".pet-card textarea").length === 1');
  await captureReference("stopped-follow-up");
  await evaluate(`(() => {
    const field = document.querySelector('.pet-card textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, '继续停止的任务');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor('document.querySelector(".pet-card .pet-send")?.disabled === false');
  await evaluate('document.querySelector(".pet-card textarea").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))');
  await waitFor('!document.querySelector(".pet-card textarea")');
  report.assertions.stoppedFollowUpRetainsOriginalTask = report.actions.some((action) => action.type === "send" && action.target.key === "fixture:logo" && action.text === "继续停止的任务") && await evaluate('document.querySelectorAll(".pet-card").length === 3');
  await captureReference("stopped");
  const finished = { ...state, theme: "light", tasks: state.tasks.map((task) => task.key === "fixture:root" ? { ...task, state: "completed", statusText: "已完成", progressText: "Hi，我在。要继续处理 PR 吗？", canStop: false } : task) };
  ipcMain.emit("jugglework:pet:publish", { sender: main.webContents }, finished);
  await waitFor('document.querySelector(".pet-card").dataset.state === "completed"');
  report.assertions.completionKeepsRowAndReply = await evaluate('Boolean(document.querySelector(".pet-card .pet-completed")) && document.querySelector(".pet-title span").textContent === "Hi，我在。要继续处理 PR 吗？"');
  await captureReference("completed");
  failNextOpen = true;
  await evaluate('document.querySelector(".pet-title").click()');
  await waitFor('document.querySelector(".pet-message")?.textContent.includes("打开失败")');
  report.assertions.openFailureDoesNotRead = await evaluate('document.querySelectorAll(".pet-card").length === 3');
  report.assertions.openFailureDoesNotRaiseMain = !main.isVisible();
  await evaluate('document.querySelector(".pet-title").click()');
  await waitFor('document.querySelectorAll(".pet-card").length === 2');
  report.assertions.completedOpenMarksRead = await evaluate('(async()=>{const s=await window.__JUGGLEWORK_PET__.getState();return s.interaction.read["fixture:root"] === "turn-1" && !document.querySelector(".pet-restore")})()');
  report.assertions.completedOpenRaisesMainAndTargetsSession = main.isVisible() && report.actions.some((action) => action.type === "open" && action.key === "fixture:root");
  main.hide();
  ipcMain.emit("jugglework:pet:publish", { sender: main.webContents }, { ...state, theme: "light", tasks: state.tasks.map((task) => task.key === "fixture:root" ? { ...task, turnKey: "turn-3" } : task) });
  await waitFor('document.querySelectorAll(".pet-card").length === 3');
  report.assertions.newTurnReappearsAfterRead = true;
  await evaluate('document.querySelector(".pet-close").click()');
  await waitFor('![...document.querySelectorAll(".pet-title strong")].some((node) => node.textContent === "ios-review")');
  report.assertions.dismissKeepsArrowUnbadged = await evaluate('document.querySelectorAll(".pet-card").length === 2 && !document.querySelector(".pet-badge")');
  await evaluate('document.querySelectorAll(".pet-tools button")[2].click()');
  report.assertions.dismissUpdatesReminderCount = await evaluate('document.querySelector(".pet-badge")?.textContent === "2"');
  await evaluate('document.querySelectorAll(".pet-tools button")[2].click()');
  await waitFor('document.querySelector(".pet-task-panel")?.dataset.folded === "false" && document.querySelectorAll(".pet-card").length === 2');
  report.assertions.dismissSurvivesReopen = await evaluate('![...document.querySelectorAll(".pet-title strong")].some((node) => node.textContent === "ios-review")');
  const beforeEmpty = await evaluate('window.__JUGGLEWORK_PET__.getState()');
  ipcMain.emit("jugglework:pet:publish", { sender: main.webContents }, { ...beforeEmpty, tasks: [] });
  await waitFor('document.querySelectorAll(".pet-card").length === 0');
  report.assertions.emptyTaskListHasNoHint = await evaluate('!document.querySelector(".pet-task-panel .pet-note")');
  report.assertions.emptyOpenListRetainsCloseArrow = await evaluate('document.querySelectorAll(".pet-tools button").length === 3 && document.querySelectorAll(".pet-tools button")[2].getAttribute("aria-expanded") === "true" && !document.querySelector(".pet-badge") && !document.querySelector(".lucide-bell")');
  await evaluate('document.querySelectorAll(".pet-tools button")[2].click()');
  await waitFor('document.querySelectorAll(".pet-tools button").length === 2 && !document.querySelector(".pet-task-panel")');
  await waitFor('getComputedStyle(document.querySelector(".pet-control-surface")).width === "80px"');
  report.assertions.noTasksHidesBellAndExtraDivider = await evaluate('!document.querySelector(".lucide-bell") && !document.querySelector(".pet-badge") && document.querySelectorAll(".pet-tools i").length === 1');
  const emptyToolbar = await evaluate('(()=>{const r=document.querySelector(".pet-tools").getBoundingClientRect(), slot=document.querySelector(".pet-controls").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,centered:r.x+r.width/2 === slot.x+slot.width/2}})()');
  report.assertions.noTasksUsesCenteredTwoButtonBubble = emptyToolbar.width === 80 && emptyToolbar.height === 40 && emptyToolbar.centered;
  report.assertions.noTaskToolbarOuterSidesPassThrough = !hits(emptyToolbar.x-4, emptyToolbar.y+38) && !hits(emptyToolbar.x+emptyToolbar.width+4, emptyToolbar.y+38) && hits(emptyToolbar.x+10, emptyToolbar.y+38);
  await captureReference("toolbar-no-tasks");
  ipcMain.emit("jugglework:pet:publish", { sender: main.webContents }, beforeEmpty);
  await waitFor('document.querySelectorAll(".pet-tools button").length === 3');
  report.assertions.newReminderRestoresBell = await evaluate('document.querySelector(".pet-badge").textContent === "2"');
  await evaluate('document.querySelectorAll(".pet-tools button")[2].click()');
  await waitFor('document.querySelector(".pet-task-panel")?.dataset.folded === "false" && document.querySelectorAll(".pet-card").length === 2');
  await evaluate('document.querySelector(".pet-close").click()');
  await waitFor('document.querySelectorAll(".pet-card").length === 1');
  report.assertions.dismissOneKeepsReminderList = await evaluate('document.querySelector(".pet-task-panel")?.dataset.visible === "true" && document.querySelectorAll(".pet-tools button").length === 3');
  report.assertions.dismissDoesNotShowFooterHint = await evaluate('!document.querySelector(".pet-restore") && !document.querySelector(".pet-task-panel").textContent.includes("已关闭")');
  await evaluate('document.querySelector(".pet-close").click()');
  await waitFor('document.querySelectorAll(".pet-tools button").length === 2 && document.querySelector(".pet-task-panel")?.dataset.visible !== "true"');
  report.assertions.dismissLastClosesListAndArrow = await evaluate('!document.querySelector(".lucide-bell") && !document.querySelector(".lucide-chevron-up") && !document.querySelector(".pet-badge") && document.querySelectorAll(".pet-tools i").length === 1');
  await evaluate('document.querySelectorAll(".pet-tools button")[0].click()');
  await waitFor('Boolean(document.querySelector(".pet-quick textarea"))');
  report.assertions.quickInputHasNoDismissedCardsHint = await evaluate('!document.querySelector(".pet-restore") && !document.querySelector(".pet-quick").textContent.includes("已关闭") && !document.querySelector(".pet-quick").textContent.includes("重新显示")');
  await evaluate('document.querySelector(".pet-quick textarea").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  await waitFor('document.querySelector(".pet-tools") !== null');
  await evaluate(`window.__JUGGLEWORK_PET__.remember({...${JSON.stringify(beforeEmpty.interaction)}, dismissed: ${JSON.stringify(beforeEmpty.interaction.dismissed)}}, ${JSON.stringify(beforeEmpty.contextKey)})`);
  await waitFor('document.querySelector(".pet-badge")?.textContent === "2"');
  latestRequests = 0;
  await evaluate('document.querySelectorAll(".pet-tools button")[0].click()');
  await waitFor('document.querySelector(".pet-target")?.textContent.includes("ios-review")');
  report.assertions.inputReplacesToolbar = await evaluate('!document.querySelector(".pet-tools") && Boolean(document.querySelector(".pet-composer .pet-input-plus"))');
  report.assertions.quickInputDoesNotRaiseMain = !main.isVisible();
  // 屏幕边缘与气泡对齐时允许收窄，发送按钮和两侧阴影仍须完整留在透明画布内。
  report.assertions.inputIsCompactPill = await evaluate('(()=>{const r=document.querySelector(".pet-composer").getBoundingClientRect();return r.height>=39 && r.height<=42 && r.width>=280 && r.left>=24 && r.right<=innerWidth-24})()');
  ipcMain.emit("jugglework:pet:publish", { sender: main.webContents }, { ...state, theme: "light" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  writeFileSync(join(output, "input.png"), (await pet.webContents.capturePage()).toPNG());
  await captureReference("input");
  const inputAnchor = await evaluate('(()=>{const r=document.querySelector(".pet-character").getBoundingClientRect();return {x:r.x,y:r.y}})()');
  const inputBounds = pet.getBounds();
  await evaluate(String.raw`(() => {
    const field = document.querySelector('.pet-composer textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, '原目标草稿\n第二行');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor('document.querySelector(".pet-composer textarea").getBoundingClientRect().height > 24');
  await evaluate('document.querySelector(".pet-input-plus").click()');
  await waitFor('document.querySelectorAll(".pet-capability-option").length === 2 && document.querySelector(".pet-input-options")?.textContent.includes("正在加载能力")');
  report.assertions.localCapabilitiesAppearBeforeConnections = await evaluate('!document.querySelector(".pet-input-options")?.textContent.includes("正在加载会话") && document.querySelector(".pet-capability-option")?.textContent.includes("Vision")');
  releaseConnections();
  await waitFor('document.querySelectorAll(".pet-capability-option").length === 3');
  report.assertions.plusShowsPluginMcpSkills = await evaluate('(()=>{const headings=[...document.querySelectorAll(".pet-capability-heading")].map(e=>e.textContent);return headings.join(",") === "插件,MCP,技能" && !document.querySelector(".pet-workspace-toggle")})()');
  report.assertions.plusUsesCapabilityLoadingLabelAndNoIcons = await evaluate('!document.querySelector(".pet-capability-heading svg") && !document.querySelector(".pet-input-options")?.textContent.includes("正在加载会话")');
  report.assertions.capabilityRowsHaveIconsAndDescription = await evaluate('[...document.querySelectorAll(".pet-capability-option")].every(row => row.querySelector(".pet-capability-icon svg, .pet-capability-icon img") && row.querySelector(".pet-capability-name") && row.querySelector("small"))');
  await evaluate('document.querySelector(".pet-capability-option").click()');
  await waitFor('!document.querySelector(".pet-input-options") && document.querySelector(".pet-selected-capabilities")?.textContent.includes("Vision")');
  report.assertions.capabilityKeepsDraft = await evaluate('document.querySelector(".pet-composer textarea").value === "原目标草稿\\n第二行"');
  report.assertions.capabilityIsInsideComposer = await evaluate('Boolean(document.querySelector(".pet-composer .pet-selected-capability"))');
  report.assertions.capabilityUsesFileFallbackWithoutRemoveIcon = await evaluate('Boolean(document.querySelector(".pet-selected-capability .lucide-file-text")) && !document.querySelector(".pet-selected-capability .lucide-x")');
  report.assertions.enabledSendIsBlue = await evaluate('!document.querySelector(".pet-send").disabled && getComputedStyle(document.querySelector(".pet-send")).backgroundColor === "rgb(52, 127, 245)"');
  await evaluate('(()=>{const field=document.querySelector(".pet-composer textarea");field.focus();field.setSelectionRange(2,2);field.dispatchEvent(new KeyboardEvent("keydown",{key:"Backspace",bubbles:true}))})()');
  report.assertions.backspaceInTextKeepsCapability = await evaluate('Boolean(document.querySelector(".pet-selected-capability"))');
  await evaluate('(()=>{const field=document.querySelector(".pet-composer textarea");field.setSelectionRange(0,0);field.dispatchEvent(new KeyboardEvent("keydown",{key:"Backspace",isComposing:true,bubbles:true}))})()');
  report.assertions.compositionBackspaceKeepsCapability = await evaluate('Boolean(document.querySelector(".pet-selected-capability"))');
  await evaluate('(()=>{const field=document.querySelector(".pet-composer textarea");field.setSelectionRange(0,0);field.dispatchEvent(new KeyboardEvent("keydown",{key:"Backspace",bubbles:true}))})()');
  await waitFor('!document.querySelector(".pet-selected-capabilities")');
  report.assertions.backspaceAtTextStartDeletesCapabilityOnly = await evaluate('document.querySelector(".pet-composer textarea").value === "原目标草稿\\n第二行"');
  await evaluate('document.querySelector(".pet-input-plus").click()');
  await waitFor('document.querySelectorAll(".pet-capability-option").length === 3');
  const listIcon = await evaluate('document.querySelector(".pet-capability-option .pet-capability-icon").innerHTML');
  releaseConnections();
  await evaluate('document.querySelector(".pet-capability-option").click()');
  report.assertions.selectedIconMatchesListIcon = await evaluate(`document.querySelector(".pet-selected-capability").firstElementChild.outerHTML === ${JSON.stringify(listIcon)}`);
  await evaluate('document.querySelector(".pet-selected-capability").click()');
  report.assertions.clickSelectsRatherThanDeletesCapability = await evaluate('document.activeElement === document.querySelector(".pet-selected-capability")');
  await evaluate('document.querySelector(".pet-selected-capability").dispatchEvent(new KeyboardEvent("keydown",{key:"Delete",bubbles:true}))');
  await waitFor('!document.querySelector(".pet-selected-capability")');
  report.assertions.deleteRemovesFocusedCapability = await evaluate('document.activeElement === document.querySelector(".pet-composer textarea")');
  await evaluate('document.querySelector(".pet-target").click()');
  await waitFor('document.querySelectorAll(".pet-workspace-toggle").length === 2');
  report.assertions.plusGroupsByRecentWorkspace = await evaluate('(()=>{const groups=[...document.querySelectorAll(".pet-workspace-toggle")];return groups[0].textContent === "隔离展示测试" && groups[0].querySelector(".lucide-folder-open") && groups[0].getAttribute("aria-expanded") === "true" && groups[1].textContent === "另一个项目" && groups[1].querySelector(".lucide-folder") && groups[1].getAttribute("aria-expanded") === "false" && document.querySelectorAll(".pet-session-option").length === 1})()');
  report.assertions.plusSessionsAreTextOnly = await evaluate('(()=>{const row=document.querySelector(".pet-session-option");return row.textContent === "ios-review" && !row.querySelector("svg, small") && row.getAttribute("aria-pressed") === "true"})()');
  await evaluate('document.querySelectorAll(".pet-workspace-toggle")[1].click()');
  await waitFor('document.querySelectorAll(".pet-session-option").length === 14');
  report.assertions.plusWorkspacesExpandIndependently = await evaluate('document.querySelectorAll(".pet-workspace-toggle[aria-expanded=true]").length === 2 && document.querySelectorAll(".pet-session-option").length === 14 && document.querySelectorAll(".pet-workspace-toggle")[1].getAttribute("aria-expanded") === "true"');
  await evaluate('document.querySelectorAll(".pet-workspace-toggle")[1].click()');
  await waitFor('document.querySelectorAll(".pet-session-option").length === 1');
  await evaluate('document.querySelectorAll(".pet-workspace-toggle")[0].click()');
  await waitFor('document.querySelectorAll(".pet-session-option").length === 0');
  report.assertions.plusAllowsAllWorkspacesCollapsed = await evaluate('document.querySelectorAll(".pet-workspace-toggle[aria-expanded=true]").length === 0');
  await evaluate('document.querySelectorAll(".pet-workspace-toggle")[1].click()');
  await waitFor('document.querySelectorAll(".pet-session-option").length === 13');
  report.assertions.plusSessionSpacing = await evaluate('(()=>{const rows=[...document.querySelectorAll(".pet-session-option")];const first=rows[0].getBoundingClientRect(),second=rows[1].getBoundingClientRect();return second.top-first.bottom >= 2 && first.height >= 32})()');
  report.assertions.conversationListScrolls = await evaluate('(()=>{const list=document.querySelector(".pet-session-list");return list.scrollHeight > list.clientHeight && getComputedStyle(list).overflowY === "auto"})()');
  await captureReference("conversation-list");
  report.assertions.optionsKeepTargetAndDraft = await evaluate('(async()=>{const s=await window.__JUGGLEWORK_PET__.getState();return s.interaction.target.sessionId === "root" && document.querySelector(".pet-composer textarea").value === "原目标草稿\\n第二行"})()');
  const options = await evaluate('(()=>{const r=document.querySelector(".pet-character").getBoundingClientRect(), menu=document.querySelector(".pet-input-options").getBoundingClientRect();return {x:r.x,y:r.y,menuFits:menu.top>=0 && menu.left>=0 && menu.right<=innerWidth && menu.bottom<=innerHeight}})()');
  const optionsBounds = pet.getBounds();
  report.assertions.inputOptionsKeepAnchor = Math.abs(inputBounds.x + inputAnchor.x - optionsBounds.x - options.x) <= 1 && Math.abs(inputBounds.y + inputAnchor.y - optionsBounds.y - options.y) <= 1;
  report.assertions.inputOptionsFitWindow = options.menuFits;
  // TIPS: 使用原生窗口失焦验证输入区和大气泡同时收起，重新打开仍可编辑原目标草稿。
  pet.focus(); pet.webContents.focus();
  await waitFor('document.hasFocus()');
  pet.blur();
  await waitFor('!document.querySelector(".pet-composer") && document.querySelector(".pet-controls")?.dataset.expanded === "false"');
  await waitFor('getComputedStyle(document.querySelector(".pet-control-surface")).width === "24px" && getComputedStyle(document.querySelector(".pet-control-surface")).height === "6px"');
  report.assertions.inputBlurCollapsesToSmallBubble = await evaluate('document.querySelector(".pet-tools").inert && !document.querySelector(".pet-tools").hasAttribute("data-pet-hit") && document.querySelector(".pet-bubble").dataset.visible === "true" && !document.querySelector(".pet-input-options")');
  report.assertions.inputBlurRestoresPassiveWindow = !pet.isFocusable();
  await captureReference("input-blurred");
  controller.focus();
  await waitFor('document.querySelector(".pet-tools")?.dataset.visible === "true"');
  await evaluate('document.querySelectorAll(".pet-tools button")[0].click()');
  await waitFor('Boolean(document.querySelector(".pet-composer textarea"))');
  report.assertions.inputBlurPreservesDraftAndTarget = await evaluate('(async()=>{const s=await window.__JUGGLEWORK_PET__.getState();return s.interaction.target.sessionId === "root" && document.querySelector(".pet-composer textarea").value === "原目标草稿\\n第二行"})()');
  await evaluate('document.querySelector(".pet-target").click()');
  await waitFor('document.querySelectorAll(".pet-workspace-toggle").length === 2 && document.querySelectorAll(".pet-session-option").length === 1');
  await evaluate('document.querySelectorAll(".pet-workspace-toggle")[1].click()');
  await waitFor('document.querySelectorAll(".pet-session-option").length === 14');
  await evaluate('document.querySelectorAll(".pet-workspace-sessions")[1].querySelector(".pet-session-option").click()');
  await waitFor('!document.querySelector(".pet-input-options") && document.querySelector(".pet-composer textarea").placeholder === "开始聊天"');
  report.assertions.selectConversationPreservesDraftAndFocus = await evaluate('(async()=>{const s=await window.__JUGGLEWORK_PET__.getState(), field=document.querySelector(".pet-composer textarea");return s.interaction.target.key === "other:history" && field.value === "原目标草稿\\n第二行" && document.activeElement === field})()');
  report.assertions.selectConversationDoesNotRaiseMain = !main.isVisible();
  await evaluate(`(() => {
    const field = document.querySelector('.pet-composer textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, '');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await captureReference("selected-conversation");
  report.assertions.selectedConversationPlaceholder = await evaluate('document.querySelector(".pet-composer textarea").placeholder === "开始聊天" && document.querySelector(".pet-send").disabled');
  await evaluate(`(() => {
    const field = document.querySelector('.pet-composer textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, '发送到选择的历史会话');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await evaluate('document.querySelector(".pet-composer textarea").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))');
  await waitFor('Boolean(document.querySelector(".pet-tools"))');
  report.assertions.sendUsesSelectedConversation = report.actions.some((action) => action.type === "send" && action.target.key === "other:history" && action.text === "发送到选择的历史会话");
  await evaluate('document.querySelectorAll(".pet-tools button")[0].click()');
  await waitFor('[...document.querySelectorAll(".pet-retarget")].some((button) => button.textContent === "打开 JuggleWork 创建任务")');
  report.assertions.noTargetOffersCreateEntry = true;
  sessionTargets = [];
  await evaluate('document.querySelector(".pet-target").click()');
  await waitFor('document.querySelector(".pet-input-options")?.textContent.includes("暂无可发送的会话")');
  report.assertions.emptyConversationListOffersCreateEntry = await evaluate('Boolean(document.querySelector(".pet-input-options .pet-retarget"))');
  await evaluate('document.querySelector(".pet-target").click()');
  await evaluate('[...document.querySelectorAll(".pet-retarget")].find((button) => button.textContent === "打开 JuggleWork 创建任务").click()');
  await new Promise((resolve) => setTimeout(resolve, 100));
  report.assertions.createEntryRaisesMain = main.isVisible() && report.actions.some((action) => action.type === "open-app");
  main.hide();
  const dragPoint = await evaluate('(()=>{const r=document.querySelector(".pet-character").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height*.45)}})()');
  await evaluate('window.__petDragEvents = []; ["pointerdown","pointermove","pointerup","click"].forEach(type => document.querySelector(".pet-character").addEventListener(type,event=>window.__petDragEvents.push({type:event.type,x:event.screenX,y:event.screenY,detail:event.detail,buttons:event.buttons})))');
  pet.webContents.sendInputEvent({ type: "mouseMove", ...dragPoint });
  pet.webContents.sendInputEvent({ type: "mouseDown", ...dragPoint, button: "left", clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  pet.webContents.sendInputEvent({ type: "mouseMove", x: dragPoint.x + 12, y: dragPoint.y + 4, modifiers: ["leftButtonDown"] });
  await new Promise((resolve) => setTimeout(resolve, 50));
  // TIPS: Electron注入鼠标不填写screenX/Y；保持真实按键/捕获流程，补齐这次位移以验证屏幕拖动阈值。
  await evaluate('document.querySelector(".pet-character").dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, buttons: 1, screenX: 12, screenY: 4 }))');
  pet.webContents.sendInputEvent({ type: "mouseUp", x: dragPoint.x + 12, y: dragPoint.y + 4, button: "left", clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  report.assertions.characterDragDoesNotRaiseMain = !main.isVisible();
  if (main.isVisible()) report.dragEvents = await evaluate('window.__petDragEvents');
  await evaluate('document.querySelector(".pet-character").click()');
  const showUntil = Date.now() + 5000;
  while (!main.isVisible() && Date.now() < showUntil) await new Promise((resolve) => setTimeout(resolve, 50));
  report.assertions.characterClickRaisesMain = main.isVisible();
  // TIPS: 真正聚焦一个带编辑器标记的DOM输入区，验证主窗口焦点来源和宠物动画消费各自独立。
  await evaluate('document.querySelector(".pet-composer textarea")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  const animationState = { ...state, tasks: [], syncing: false, partial: false, mainComposerEditing: false, voicePhase: "idle" };
  const publishAnimation = (updates) => ipcMain.emit("jugglework:pet:publish", { sender: main.webContents }, { ...animationState, ...updates });
  publishAnimation({});
  await waitFor('document.querySelector(".pet-sprite").style.backgroundImage.includes("/typing.png")');
  main.focus(); main.webContents.focus();
  const mainFocusUntil = Date.now() + 5000;
  while (!await main.webContents.executeJavaScript('document.hasFocus()') && Date.now() < mainFocusUntil) await new Promise((resolve) => setTimeout(resolve, 50));
  await main.webContents.executeJavaScript(`(async () => {
    const { subscribeComposerEditing } = await import('/src/react-app/domains/session/surface/composer/editing.ts');
    window.__releaseComposerEditing = subscribeComposerEditing(value => { window.__mainComposerEditing = value; });
    const field = document.createElement('div'); field.contentEditable = 'true'; field.dataset.sessionComposerInput = ''; field.textContent = '未发送草稿';
    document.body.append(field); field.focus();
  })()`);
  report.assertions.mainComposerFocusReported = await main.webContents.executeJavaScript('window.__mainComposerEditing === true');
  if (!report.assertions.mainComposerFocusReported) report.mainComposerFocus = await main.webContents.executeJavaScript('({ focused: document.hasFocus(), visibility: document.visibilityState, active: document.activeElement?.outerHTML })');
  publishAnimation({ mainComposerEditing: await main.webContents.executeJavaScript('window.__mainComposerEditing') });
  await waitFor('document.querySelector(".pet-sprite").style.backgroundImage.includes("/seated-working.png")');
  report.assertions.mainComposerFocusShowsWorking = true;
  await main.webContents.executeJavaScript('document.querySelector("[data-session-composer-input]").blur()');
  report.assertions.mainComposerBlurReported = await main.webContents.executeJavaScript('window.__mainComposerEditing === false');
  publishAnimation({ mainComposerEditing: await main.webContents.executeJavaScript('window.__mainComposerEditing'), partial: true });
  await waitFor('document.querySelector(".pet-sprite").style.backgroundImage.includes("/typing.png")');
  report.assertions.savedDraftAndUnrelatedPartialSyncKeepIdle = true;
  await main.webContents.executeJavaScript('window.__releaseComposerEditing(); document.querySelector("[data-session-composer-input]").remove()');
  publishAnimation({});
  controller.focus();
  await waitFor('Boolean(document.querySelector(".pet-tools"))');
  await evaluate('document.querySelector(".pet-tools button").click()');
  await waitFor('Boolean(document.querySelector(".pet-composer textarea")) && document.querySelector(".pet-sprite").style.backgroundImage.includes("/seated-working.png")');
  report.assertions.openingEmptyPetEditorImmediatelyWorks = true;
  const waitingTask = { ...fixtureTarget, turnKey: "waiting-turn", state: "waiting", statusText: "等待回答", canStop: false };
  publishAnimation({ tasks: [waitingTask], mainComposerEditing: true });
  await waitFor('document.querySelector(".pet-sprite").style.backgroundImage.includes("/waiting.png")');
  report.assertions.waitingTakesPriorityOverBothEditors = true;
  await evaluate('document.querySelector(".pet-composer textarea").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  publishAnimation({ tasks: [{ ...waitingTask, state: "reconciling", statusText: "连接中断，正在确认任务状态" }] });
  await waitFor('document.querySelector(".pet-sprite").style.backgroundImage.includes("/seated-working.png")');
  report.assertions.disconnectedTaskKeepsWorking = true;
  publishAnimation({ tasks: [{ ...waitingTask, state: "completed", statusText: "已完成" }], partial: true });
  await waitFor('document.querySelector(".pet-sprite").style.backgroundImage.includes("/typing.png")');
  report.assertions.confirmedCompletionReturnsToTyping = true;
  await controller.setVisible(false); report.assertions.hiddenDestroyed = pet.isDestroyed();
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.exitCode = errors.length || Object.values(report.assertions).some((passed) => !passed) ? 1 : 0;
} catch (error) { console.error(error); console.error(JSON.stringify(report)); process.exitCode = 1; }
finally { controller.dispose(); main.destroy(); app.exit(process.exitCode || 0); }
});
