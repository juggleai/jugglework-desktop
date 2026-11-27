import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebContentsView, session, shell } from "electron";
import { createCloudDocsExports } from "./cloud-docs-export.mjs";
import { cloudDocsContentTarget, createCloudDocsStartup } from "./cloud-docs-startup.mjs";
import { canResumeCloudDocs, cloudDocsResumeTarget, requestCloudDocsResume } from "./cloud-docs-resume.mjs";
import { createCloudDocsRecent, createCloudDocsWarmup } from "./cloud-docs-warmup.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));

/** 校验仅用于 Docs 的启动目标，HTTP 仅允许明确的本机开发域。 */
export function validateCloudDocsLaunch(input) {
  if (
    !input ||
    typeof input.tenantId !== "string" ||
    !input.tenantId ||
    typeof input.sourceUserId !== "string" ||
    !input.sourceUserId ||
    typeof input.sourceServerOrigin !== "string"
  )
    throw new Error("Invalid Docs context");
  const url = new URL(input.bootstrapUrl);
  const expected = new URL(input.docsOrigin);
  if (
    url.origin !== expected.origin || expected.href !== `${expected.origin}/` ||
    url.pathname !== "/api/jw/session/bootstrap" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("Invalid Docs destination");
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || ["127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Docs requires HTTPS");
  if (
    !/^[a-f0-9-]{36}$/i.test(input.instanceId) ||
    typeof input.launchGrant !== "string" ||
    !input.launchGrant ||
    input.launchGrant.length > 512
  )
    throw new Error("Invalid Docs launch");
  const partitionKey = createHash("sha256")
    .update(`${input.sourceServerOrigin}\0${input.sourceUserId}\0${input.tenantId}`)
    .digest("hex");
  return {
    origin: url.origin,
    partition: `persist:jugglework-docs-affine-${partitionKey}`,
  };
}

/**
 * 独立受限原生视图承载云文档，来源／账号隔离，不复用通用浏览器会话。
 * 刷新恢复和启动预热默认启用，各自环境变量设为 0 后在下次进程启动时关闭。
 * @param {{getWindow:()=>any,getWindows?:()=>any[],onDocumentChanged?:(window:any,instanceId:string,document:{tenantId:string,workspaceId:string,docId:string,title:string})=>void,onOpenInNewTab?:(request:{sourceInstanceId:string,sourceServerOrigin:string,sourceUserId:string,document:{tenantId:string,workspaceId:string,docId:string,title:string}})=>void,attachments?:{open:(input:any)=>Promise<any>,clearScope:(scope:any)=>Promise<void>,clearContext?:(scope:any,contextId:string)=>Promise<void>},recentPath?:string,liveResume?:boolean,startupWarmup?:boolean}} options 宿主窗口、受限附件访问与独立标签入口
 */
export function createCloudDocsPanel({ getWindow, getWindows = () => [getWindow()], getMeetingWindow = () => null, onDocumentChanged, onOpenInNewTab, attachments, recentPath, liveResume = process.env.JUGGLEWORK_DOCS_LIVE_RESUME !== "0", startupWarmup = process.env.JUGGLEWORK_DOCS_STARTUP_WARMUP !== "0" }) {
  const currents = new Map();
  const backgrounds = new Map();
  const retained = new Map();
  const intakes = new Map();
  const revocations = new Map();
  const hostLifetimes = new WeakMap();
  const exports = createCloudDocsExports();
  const startupSamples = [];
  const recent = recentPath ? createCloudDocsRecent(recentPath) : null;
  const warmup = createCloudDocsWarmup({
    discard(instanceId) {
      const owner = getWindow();
      if (owner && !owner.isDestroyed()) owner.webContents.send("jugglework:docs:warmup-cancelled", instanceId);
      return discardWarmup(instanceId);
    },
    ready: warmupReady,
  });
  const recordStartup = (sample) => {
    if (startupSamples.length === 128) startupSamples.shift();
    startupSamples.push(sample);
    if (process.env.JUGGLEWORK_DOCS_STARTUP_DIAGNOSTICS === "1")
      console.info("[cloud-docs-startup]", JSON.stringify(sample));
  };
  const items = () => [...new Set([...currents.values(), ...retained.values(), ...backgrounds.values()])];
  const active = (item) => !!item && (currents.get(item.ownerWindow.id) === item || retained.get(item.input.instanceId) === item || backgrounds.get(item.input.instanceId) === item);
  const find = (input) => input?.instanceId
    ? items().find((item) => item.input.instanceId === input.instanceId)
    : currents.get(getWindow()?.id);
  const send = (value) => {
    const item = find(value);
    if (item && value.status) item.lastStatus = value.status;
    if (item?.warmup && (value.status === "unauthorized" || value.status === "error")) warmup.settled(value.instanceId, false);
    if (item?.detached || item?.warmup) return;
    const win = item?.input.meeting === true ? getWindow() : item?.ownerWindow ?? getWindow();
    if (win && !win.isDestroyed())
      win.webContents.send("jugglework:docs:state", value);
  };
  const ownerFor = event => getWindows().find(win => win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame);
  /** 会议窗口没有自己的渲染器：控制方只能是主窗口顶层 frame，所属窗口固定为当前会议窗口。 */
  const meetingControl = event => {
    const main = getWindow(), meeting = getMeetingWindow();
    return !!main && !main.isDestroyed() && !!meeting && !meeting.isDestroyed() &&
      event.sender === main.webContents && event.senderFrame === main.webContents.mainFrame ? meeting : null;
  };
  const meetingItem = () => items().find(item => item.input.meeting === true && item.ownerWindow === getMeetingWindow());
  const trusted = (event, input) => {
    const item = input?.instanceId ? find(input) : null;
    if (item?.input.meeting === true) return !!meetingControl(event) && item.ownerWindow === getMeetingWindow() && !item.detached && !item.warmup;
    const owner = ownerFor(event);
    const binding = owner && hostLifetimes.get(owner);
    if (binding && input?.hostBinding &&
      (input.hostBinding === binding.retired || (binding.attached && input.hostBinding !== binding.attached))) return false;
    return !!owner && (input?.instanceId || owner === getWindow()) && (!item || (
      item.ownerWindow === owner && !item.detached && !item.warmup && (!item.hostBinding || item.hostBinding === input.hostBinding)
    ));
  };

  function hostLifetime(window) {
    let binding = hostLifetimes.get(window);
    if (!binding) {
      binding = { epoch: 0 };
      hostLifetimes.set(window, binding);
    }
    return binding;
  }

  /** 宿主主框架重载时先撤销旧绑定，原生草稿和回执继续交由原实例处理。 */
  function detachWindow(window) {
    if (window && startupWarmup) warmup.cancel();
    if (!window || (!liveResume && !startupWarmup)) return;
    const binding = hostLifetime(window);
    binding.epoch++;
    if (binding.attached) binding.retired = binding.attached;
    binding.attached = undefined;
    for (const item of items()) {
      // TIPS: 未认领预热走自己的取消与保存流程，不能作为刷新时的旧前台实例接管。
      if (item.ownerWindow !== window || !item.hostBinding || item.detached || item.warmup) continue;
      item.detached = true;
      item.view.setVisible(false);
      item.startup?.cancel();
      item.detachTimer = setTimeout(async () => {
        if (item.detached && active(item) && await prepareClose(item.input.instanceId) && item.detached && active(item))
          close(item.input.instanceId);
      }, 120_000);
      item.detachTimer.unref?.();
    }
  }

  function warmupReady(instanceId, scope) {
    const item = find({ instanceId });
    if (!item?.warmup || item.denied || item.view.webContents.isDestroyed() || item.origin !== scope.docsOrigin) return false;
    // TIPS: 点击可接管仍在加载的同目标实例；setBounds 继续在 ready 前隐藏正文，不再等完后回退重建。
    if (!item.ready) return !item.hasBeenReady;
    const actual = contentTarget(item);
    return actual?.workspaceId === scope.workspaceId && actual?.docId === scope.docId &&
      actual.workspaceId === item.readyWorkspaceId;
  }

  function discardWarmup(instanceId) {
    const item = find({ instanceId });
    if (!item?.warmup) return Promise.resolve(true);
    // TIPS: 等待期和显式打开可能同时清理同一隐藏页，复用原生保存确认。
    item.warmupCleanup ??= prepareClose(instanceId).then(saved => {
      if (saved && active(item) && item.warmup) close(instanceId);
      return saved;
    }).catch(() => false).finally(() => { item.warmupCleanup = undefined; });
    return item.warmupCleanup;
  }

  function detachedPage(owner) {
    return items().find(item => item.ownerWindow === owner && item.hostBinding && item.detached);
  }

  function resumeCandidate(owner, input) {
    const item = detachedPage(owner);
    if (!input || !liveResume || !item?.ready || !item.resumeSupported || item.denied ||
      input.sourceServerOrigin !== item.input.sourceServerOrigin ||
      input.sourceUserId !== item.input.sourceUserId || input.tenantId !== item.input.tenantId) return null;
    const actual = contentTarget(item);
    if (actual?.workspaceId !== item.readyWorkspaceId || !canResumeCloudDocs(actual, input.target)) return null;
    return { instanceId: item.input.instanceId, docsOrigin: item.origin, target: cloudDocsResumeTarget(actual) };
  }

  /** 从受限原生页的实际路由取得当前文档，并按需要核对宿主及来源账号。 */
  function documentFor(instanceId, ownerWindow, scope) {
    const item = find({ instanceId });
    if (!item?.ready || item.denied || item.detached || item.warmup || (ownerWindow && item.ownerWindow !== ownerWindow)) return null;
    if (scope && (scope.sourceServerOrigin !== item.input.sourceServerOrigin ||
      scope.sourceUserId !== item.input.sourceUserId)) return null;
    try {
      const url = new URL(item.view.webContents.getURL());
      const path = /^\/workspace\/([\w-]+)\/([\w-]+)\/?$/.exec(url.pathname);
      if (url.origin !== item.origin || !path || ['all','trash','settings','collection','tag','journal','journals','favorites','recent'].includes(path[2])) return null;
      return { tenantId: item.input.tenantId, workspaceId: path[1], docId: path[2], title: String(item.view.webContents.getTitle?.() || '').slice(0, 200) };
    } catch { return null; }
  }

  function contentTarget(item) {
    return cloudDocsContentTarget(item.view.webContents.getURL(), item.origin);
  }

  function rememberPresented(item) {
    if (!recent || !item.input.fullPage || item.input.background || item.warmup ||
      item.ownerWindow !== getWindow() || !item.view.getVisible() || !item.ready || item.denied) return;
    const actual = contentTarget(item);
    const shown = item.presented;
    // TIPS: 左侧入口固定打开主页；只记录已授权主页，避免预热上次文档后又因目标不匹配重建。
    if (!actual || actual.docId !== null || actual.workspaceId !== shown?.workspaceId || actual.docId !== shown?.docId ||
      shown.contextId !== item.contextId) return;
    recent.write({ ...item.input, ...actual, docsOrigin: item.origin });
  }

  function observeContent(item) {
    if (item.detached) return;
    const current = contentTarget(item);
    item.startup?.ready(item.contextId, current?.workspaceId === item.readyWorkspaceId ? current : null, item.contentStateSupported);
  }

  /** 原生页内部导航也更新宿主定位，避免 AI 继续把初始标签当成当前文档。 */
  function publishDocument(item) {
    if (!active(item) || !item.ready || item.denied) return;
    const document = documentFor(item.input.instanceId);
    if (document) onDocumentChanged?.(item.ownerWindow, item.input.instanceId, document);
    send({ instanceId: item.input.instanceId, status: 'ready', workspaceId: document?.workspaceId, docId: document?.docId ?? null, title: document?.title });
  }

  /** 释放指定实例；不带实例时清理全部前后台页面及其未完成请求。 */
  function close(instanceId) {
    if (!instanceId) {
      for (const item of items()) close(item.input.instanceId);
      return;
    }
    const old = find({ instanceId });
    if (!old) return;
    old.startup?.cancel();
    clearTimeout(old.detachTimer);
    if (currents.get(old.ownerWindow.id) === old) currents.delete(old.ownerWindow.id);
    backgrounds.delete(instanceId);
    retained.delete(instanceId);
    for (const [id, task] of intakes) {
      if (task.item !== old) continue;
      clearTimeout(task.timer);
      task.reject(new Error("docs_view_closed"));
      intakes.delete(id);
    }
    const win = old.ownerWindow;
    if (!old.input.background && win && !win.isDestroyed()) win.contentView.removeChildView(old.view);
    if (!old.view.webContents.isDestroyed()) old.view.webContents.close();
  }

  /** 等待文档或表格各自的持久化确认，超时保留原视图。 */
  function prepareClose(instanceId) {
    const item = find({ instanceId });
    if (!item || !item.hasBeenReady || item.view.webContents.isDestroyed()) return Promise.resolve(true);
    const requestId = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { intakes.delete(requestId); resolve(false); }, 30_000);
      intakes.set(requestId, { item, timer, resolve: result => resolve(result?.persisted === true), reject: () => resolve(false) });
      item.view.webContents.send('jugglework:docs:prepare-close', { instanceId, requestId });
    });
  }

  /** 退出或更新前统一等待原生本地保存，任一页面未确认就取消退出。 */
  async function prepareQuit(ownerWindow) {
    const targets = items().filter(item => !ownerWindow || item.ownerWindow === ownerWindow);
    return (await Promise.all(targets.map(item => item.warmupCleanup ?? prepareClose(item.input.instanceId)))).every(Boolean);
  }

  /** 主窗口销毁只释放自己的视图，独立 File Browser 仍保持打开。 */
  function closeWindow(ownerWindow) {
    if (ownerWindow === getWindow()) warmup.cancel(false);
    for (const item of items()) if (item.ownerWindow === ownerWindow) close(item.input.instanceId);
  }

  /** 关闭与明确来源账号和组织匹配的可见产品页，不影响同账号其他组织。 */
  async function closeScope(scope) {
    for (const item of items()) {
      if (item.input.sourceServerOrigin === scope?.sourceServerOrigin &&
        item.input.sourceUserId === scope?.sourceUserId && item.input.tenantId === scope?.tenantId)
        { item.view.setVisible(false); if (await prepareClose(item.input.instanceId)) close(item.input.instanceId); }
    }
  }

  /** 失权仅隐藏相同绑定，原生本地落盘确认后再释放，不清任何共享 Cookie 或数据库。 */
  function revoke(item) {
    const key = `${item.target.partition}\0${item.contextId || item.input.instanceId}`;
    if (revocations.has(key)) return revocations.get(key);
    const targets = items().filter(target => target === item || (item.contextId && target.contextId === item.contextId && target.target.partition === item.target.partition));
    for (const target of targets) { target.startup?.cancel("error"); target.denied = true; target.ready = false; target.view.setVisible(false); }
    const task = (async () => {
      if (item.contextId) await attachments?.clearContext?.({ sourceServerOrigin: item.input.sourceServerOrigin, sourceUserId: item.input.sourceUserId, tenantId: item.input.tenantId }, item.contextId);
      for (const target of targets) if (await prepareClose(target.input.instanceId)) close(target.input.instanceId);
    })().finally(() => revocations.delete(key));
    revocations.set(key, task);
    return task;
  }

  function bounds(input) {
    const item = find(input);
    if (!item || item.input.background) return;
    const win = item.ownerWindow;
    const current = currents.get(win.id);
    if (!win || win.isDestroyed()) return;
    const zoom = win.webContents.getZoomFactor();
    const rect = win.getContentBounds();
    const x = Math.max(0, Math.round(Number(input.x) * zoom));
    const y = Math.max(0, Math.round(Number(input.y) * zoom));
    const width = Math.max(
      0,
      Math.min(rect.width - x, Math.round(Number(input.width) * zoom)),
    );
    const height = Math.max(
      0,
      Math.min(rect.height - y, Math.round(Number(input.height) * zoom)),
    );
    if (![x, y, width, height].every(Number.isFinite)) return;
    // TIPS: React 隐藏页面会测得零尺寸；只隐藏原生视图，避免触发 AFFiNE 的窄屏自动收起。
    if (width === 0 || height === 0) {
      if (item.view.getVisible()) item.view.setVisible(false);
      return;
    }
    const previous = item.lastBounds;
    if (!previous || previous.x !== x || previous.y !== y || previous.width !== width || previous.height !== height) {
      item.view.setBounds({ x, y, width, height });
      item.lastBounds = { x, y, width, height };
    }
    // TIPS: WebContentsView 独立于 DOM 裁切；与宿主共享圆角，并按窗口缩放换算。
    const borderRadius = Number(input.borderRadius ?? 0);
    const radius = Number.isFinite(borderRadius)
      ? Math.max(0, Math.min(Math.round(borderRadius * zoom), Math.floor(Math.min(width, height) / 2)))
      : 0;
    if (item.lastBorderRadius !== radius) {
      item.view.setBorderRadius(radius);
      item.lastBorderRadius = radius;
    }
    const visible = input.visible === true && item.ready && !item.denied && width > 0 && height > 0;
    if (visible && current !== item) {
      if (current) {
        if (current.view.getVisible()) current.view.setVisible(false);
        if (!current.input.retain) {
          retained.set(current.input.instanceId, current);
          void prepareClose(current.input.instanceId).then(saved => { if (saved && currents.get(win.id) !== current) close(current.input.instanceId); });
        }
      }
      currents.set(win.id, item);
    }
    const wasVisible = item.view.getVisible();
    if (wasVisible !== visible) item.view.setVisible(visible);
    if (visible && !wasVisible) {
      item.startup?.visible();
      rememberPresented(item);
    }
    // TIPS: 隐藏授权或宿主菜单结束后恢复原生页面焦点，触发原生引擎的恢复并接收编辑输入。
    if (visible && !wasVisible) item.view.webContents.focus();
  }

  /** 用表单 POST 短时凭据打开目标原生页面；长期源令牌不会进入此模块。 */
  async function open(input, ownerWindow = getWindow()) {
    const startedAt = performance.now();
    const win = ownerWindow;
    // 会议视图不参与预热、刷新接管和启动记录，同一会议窗口只保留一个。
    if (input.meeting === true) {
      if (input.warmup || input.fullPage || input.background || input.retain || input.presentation?.mode !== "product" || win !== getMeetingWindow())
        throw new Error("Forbidden");
      const existing = meetingItem();
      if (existing) {
        existing.view.setVisible(false);
        if (!await prepareClose(existing.input.instanceId)) throw new Error("docs_local_save_pending");
        close(existing.input.instanceId);
      }
    }
    const current = currents.get(win?.id);
    const target = validateCloudDocsLaunch(input);
    const prewarming = input.warmup === true;
    if (prewarming && (!startupWarmup || win !== getWindow() || !input.fullPage || input.background ||
      input.presentation?.mode !== "product" || items().length || !warmup.start(input, target.origin)))
      throw new Error("docs_warmup_cancelled");
    const mainHost = !!win && win === getWindow() && /^[a-f0-9-]{36}$/i.test(input.hostBinding ?? "");
    const fullPage = liveResume && mainHost && input.fullPage === true && !input.background && input.presentation?.mode === "product";
    const binding = fullPage || (startupWarmup && mainHost) ? hostLifetime(win) : null;
    const epoch = binding?.epoch;
    if (!prewarming && startupWarmup) {
      const explicitMainPage = input.fullPage === true && win === getWindow();
      // TIPS: 同分区、同来源的后台交接也可能换发 Cookie，先让未认领预热完成保存清理。
      const unused = items().find(item => item.warmup && (explicitMainPage ||
        (item.target.partition === target.partition && item.origin === target.origin)));
      if (explicitMainPage || unused) warmup.exclude();
      if (unused && !await discardWarmup(unused.input.instanceId)) throw new Error("docs_local_save_pending");
      if (binding && binding.epoch !== epoch) throw new Error("docs_host_changed");
    }
    const orphan = fullPage ? detachedPage(win) : null;
    if (orphan) {
      // TIPS: 新交接可能更新同源 Cookie，保存屏障覆盖共用该绑定的所有窗口和后台页。
      const affected = items().filter(item => item === orphan ||
        (item.target.partition === target.partition && item.origin === target.origin));
      if (!(await Promise.all(affected.map(item => prepareClose(item.input.instanceId)))).every(Boolean))
        throw new Error("docs_local_save_pending");
      if (binding.epoch !== epoch || !orphan.detached || !active(orphan)) throw new Error("docs_host_changed");
      close(orphan.input.instanceId);
    }
    // TIPS: 上传和 AI 的后台产品页不替换可见页面，结束时也只释放自己的实例。
    const previous = find({ instanceId: input.instanceId });
    if (previous) {
      previous.view.setVisible(false);
      if (!await prepareClose(input.instanceId)) throw new Error('docs_local_save_pending');
      close(input.instanceId);
    }
    if (input.background === true) { /* 后台页不改变当前可见实例。 */ }
    else if (!input.retain && current?.input.retain) { current.view.setVisible(false); currents.delete(win.id); }
    else if (!input.retain && current && current !== previous) {
      current.view.setVisible(false);
      if (await prepareClose(current.input.instanceId)) close(current.input.instanceId);
      else { retained.set(current.input.instanceId, current); currents.delete(win.id); }
    }
    if (!win || win.isDestroyed())
      throw new Error("Desktop window unavailable");
    if (binding && binding.epoch !== epoch) throw new Error("docs_host_changed");
    const nativeSession = session.fromPartition(target.partition);
    nativeSession.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false),
    );
    const view = new WebContentsView({
      webPreferences: {
        session: nativeSession,
        preload: path.join(directory, "cloud-docs-preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // TIPS: 授权期间视图暂时隐藏，初始化与弹层动画仍需运行，避免首屏等待或弹层不绘制。
        backgroundThrottling: false,
      },
    });
    /** @type {{ownerWindow:typeof win,view:typeof view,input:typeof input,target:typeof target,nativeSession:typeof nativeSession,origin:string,ready:boolean,denied:boolean,routeEpoch:number,warmup:boolean,hostBinding?:string,startup?:ReturnType<typeof createCloudDocsStartup>,hasBeenReady?:boolean}} */
    const item = {
      ownerWindow: win,
      view,
      input,
      target,
      nativeSession,
      origin: target.origin,
      ready: false,
      denied: false,
      routeEpoch: 0,
      warmup: prewarming,
      ...(fullPage ? { hostBinding: input.hostBinding } : {}),
    };
    if (fullPage) binding.attached = input.hostBinding;
    if (!input.background && win === getWindow() && input.presentation?.mode === "product" && Number.isFinite(input.startupLaunchMs)) {
      item.startup = createCloudDocsStartup({
        instanceId: input.instanceId,
        launchMs: input.startupLaunchMs,
        path: prewarming ? "warmup" : "bootstrap",
        workTiming: input.startupWorkTiming,
        startedAt,
        record: recordStartup,
        send: request => view.webContents.send("jugglework:docs:request-content-state", request),
      });
    }
    if (input.background === true) backgrounds.set(input.instanceId, item);
    else {
      // TIPS: 保留型标签可能在后台完成首次加载；只有可见范围请求才激活，不能抢走用户后来选中的页面。
      if (input.retain === true) retained.set(input.instanceId, item);
      else currents.set(win.id, item);
      win.contentView.addChildView(view);
    }
    // 后台页面仍需有正常视口，供原生导入器和 Workspace 布局完成初始化。
    view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
    view.setVisible(false);
    if (prewarming) warmup.opened(input.instanceId);
    view.webContents.setWindowOpenHandler(({ url }) => {
      try {
        if (new URL(url).protocol === "https:") void shell.openExternal(url);
      } catch {
        /* 非 URL 不执行。 */
      }
      return { action: "deny" };
    });
    view.webContents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame === false) return;
      item.routeEpoch++;
      publishDocument(item);
      if (active(item) && item.ready && !item.denied) observeContent(item);
    });
    view.webContents.on("page-title-updated", () => publishDocument(item));
    view.webContents.on("will-navigate", (event, url) => {
      try {
        if (new URL(url).origin === target.origin) return;
      } catch {
        /* 拒绝非预期协议。 */
      }
      event.preventDefault();
    });
    // TIPS: 跨原生 Workspace 整页导航时，等待本次授权就绪，不能显示上一页的缓存。
    view.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (!active(item) || !isMainFrame || isInPlace) return;
      item.routeEpoch++;
      // TIPS: 当前实例一旦失权，只能由宿主重新创建；迟到导航不能把拒绝态降级成 loading。
      if (item.denied) { view.setVisible(false); return; }
      // TIPS: bootstrap 的 303 跳转属于同次启动；已就绪页再次整页导航才撤销当前观测。
      if (item.hasBeenReady) item.startup?.cancel();
      item.ready = false;
      view.setVisible(false);
      send({ instanceId: input.instanceId, status: "loading" });
    });
    view.webContents.on(
      "did-fail-load",
      (_event, code, _description, _url, isMainFrame) => {
        if (active(item) && isMainFrame && code !== -3) {
          item.startup?.cancel("error");
          send({
            instanceId: input.instanceId,
            status: "error",
            message: "云文档暂时无法连接",
          });
        }
      },
    );
    view.webContents.on("did-navigate", (_event, _url, responseCode) => {
      if (active(item) && [401, 403, 404].includes(responseCode)) {
        item.startup?.cancel("error");
        item.ready = false;
        item.denied = true;
        view.setVisible(false);
        send({ instanceId: input.instanceId, status: "unauthorized" });
      }
    });
    view.webContents.on("render-process-gone", () => {
      if (!active(item)) return;
      item.startup?.cancel("error");
      // TIPS: 崩溃后的 WebContents 不会再发 ready；立即恢复宿主错误页，允许用户显式重建视图。
      item.ready = false;
      item.denied = true;
      view.setVisible(false);
      send({
        instanceId: input.instanceId,
        status: "error",
        message: "云文档暂时无法连接",
      });
    });
    try {
      await view.webContents.loadURL(input.bootstrapUrl, {
        postData: [
          {
            type: "rawData",
            bytes: Buffer.from(
              new URLSearchParams({ grant: input.launchGrant }).toString(),
            ),
          },
        ],
        extraHeaders: "Content-Type: application/x-www-form-urlencoded\r\n",
      });
    } catch {
      if (active(item)) {
        item.startup?.cancel("error");
        if (item.warmup) warmup.settled(input.instanceId, false);
        close(input.instanceId);
        throw new Error("云文档暂时无法连接");
      }
    }
    return { instanceId: input.instanceId };
  }

  /** 注册主宿主操作和远程页面的最小只读状态消息。 */
  function registerIpc(ipcMain) {
    ipcMain.handle("jugglework:docs:warmup-reserve", (event, input) => {
      if (!startupWarmup || !input || ownerFor(event) !== getWindow() || !trusted(event, input) || items().length) return null;
      return warmup.reserve(input, recent?.read(input));
    });
    ipcMain.handle("jugglework:docs:warmup-claim", async (event, input) => {
      const owner = ownerFor(event);
      const valid = () => owner && owner === getWindow() && trusted(event, input);
      if (!startupWarmup || !input || !valid()) return null;
      const instanceId = await warmup.claim(input, valid);
      if (!instanceId) return null;
      const item = find({ instanceId });
      if (!item?.warmup || item.denied || !valid()) {
        void discardWarmup(instanceId);
        return null;
      }
      item.warmup = false;
      publishDocument(item);
      return instanceId;
    });
    ipcMain.handle("jugglework:docs:warmup-cancel", (event, input) => {
      if (input?.instanceId && ownerFor(event) === getWindow() && trusted(event, { hostBinding: input.hostBinding }))
        warmup.cancelBinding(input.hostBinding, input.instanceId);
      return null;
    });
    ipcMain.handle("jugglework:docs:resume-candidate", (event, input) => {
      const owner = ownerFor(event);
      return owner && owner === getWindow() && trusted(event, input) ? resumeCandidate(owner, input) : null;
    });
    ipcMain.handle("jugglework:docs:resume", async (event, input) => {
      const owner = ownerFor(event);
      const binding = owner === getWindow() && owner ? hostLifetime(owner) : null;
      if (!input || !liveResume || !binding || !trusted(event, { hostBinding: input.hostBinding }) ||
        !/^[a-f0-9-]{36}$/i.test(input.hostBinding ?? "")) return "retry";
      const candidate = resumeCandidate(owner, input);
      const item = candidate && detachedPage(owner);
      if (!item || candidate.instanceId !== input.instanceId || !item.contextId ||
        validateCloudDocsLaunch(input).origin !== item.origin) return "fallback";
      const current = contentTarget(item);
      const epoch = binding.epoch;
      const nativeContext = item.contextId;
      const routeEpoch = item.routeEpoch;
      const startup = createCloudDocsStartup({
        path: "resume",
        launchMs: input.startupLaunchMs,
        workTiming: input.startupWorkTiming,
        instanceId: candidate.instanceId,
        record: recordStartup,
        send: request => item.view.webContents.send("jugglework:docs:request-content-state", request),
      });
      const outcome = await requestCloudDocsResume(item.nativeSession, item.origin, {
        launchGrant: input.launchGrant,
        instanceId: candidate.instanceId,
        expectedContextId: nativeContext,
        target: { ...candidate.target, workspaceId: current.workspaceId },
      });
      if (binding.epoch !== epoch || !active(item) || !item.detached || !item.ready ||
        item.denied || item.contextId !== nativeContext || item.routeEpoch !== routeEpoch ||
        !trusted(event, { hostBinding: input.hostBinding })) {
        startup.cancel();
        return "retry";
      }
      if (outcome === "denied") {
        startup.cancel("denied");
        void revoke(item);
        return "denied";
      }
      if (outcome !== "resumed") {
        startup.cancel(outcome);
        return outcome;
      }
      clearTimeout(item.detachTimer);
      binding.attached = input.hostBinding;
      item.hostBinding = input.hostBinding;
      item.detached = false;
      item.startup = startup;
      publishDocument(item);
      observeContent(item);
      return "resumed";
    });
    const exportView = (event) => {
      const item = items().find(value => value.view.webContents === event.sender);
      if (!item || event.senderFrame !== item.view.webContents.mainFrame ||
        item.ownerWindow.isDestroyed() || item.input.background || !item.view.getVisible() ||
        item.input.presentation?.mode !== "product" || !documentFor(item.input.instanceId, item.ownerWindow)) return null;
      return item;
    };
    ipcMain.handle("jugglework:docs:save-export", (event, input) => {
      const item = exportView(event);
      if (!item) throw new Error("Forbidden");
      return exports.save(item, input, () => exportView(event) === item);
    });
    ipcMain.handle("jugglework:docs:reveal-export", (event, revealId) => {
      const item = exportView(event);
      if (!item) throw new Error("Forbidden");
      return exports.reveal(item, revealId, () => exportView(event) === item);
    });
    // TIPS: 菜单激活来自当前可见产品页。菜单关闭后将原生焦点还给画布，再交付标准编辑事件。
    ipcMain.handle("jugglework:docs:clipboard-command", (event, action) => {
      const item = exportView(event);
      if (!item || currents.get(item.ownerWindow.id) !== item ||
        !["copy", "cut", "paste"].includes(action)) throw new Error("Forbidden");
      if (new URL(event.senderFrame.url).origin !== item.origin)
        throw new Error("Forbidden");
      event.sender.focus();
      event.sender[action]();
    });
    ipcMain.on("jugglework:docs:layout-command", (event, input) => {
      const current = find(input);
      if (!trusted(event, input) || !current?.ready || current.denied ||
        current.input.presentation?.mode !== "product" ||
        input?.instanceId !== current.input.instanceId ||
        !["toggle-left", "toggle-right", "search", "request-state"].includes(input.action)) return;
      // TIPS: 保留页的 ready／resize 回调不能抢走前台输入；明确的展示操作只交给当前且实际可见的实例。
      if (input.action !== "request-state" &&
        (currents.get(current.ownerWindow.id) !== current || !current.view.getVisible())) return;
      // TIPS: 顶部按钮位于宿主中；先恢复编辑器焦点，再执行原生展示操作。
      if (input.action !== "request-state") current.view.webContents.focus();
      current.view.webContents.send("jugglework:docs:layout-command", {
        instanceId: input.instanceId, action: input.action,
      });
    });
    ipcMain.on("jugglework:docs:rail-hint", (event, input) => {
      const item = find(input);
      if (!trusted(event, input) || !item?.ready || item.denied ||
        item.input.presentation?.mode !== "product" ||
        input?.instanceId !== item.input.instanceId ||
        item.view.webContents.isDestroyed()) return;
      const hint = input.hint;
      if (hint === null) {
        item.view.webContents.send("jugglework:docs:rail-hint", null);
        return;
      }
      if (currents.get(item.ownerWindow.id) !== item || !item.view.getVisible() ||
        typeof hint?.label !== "string" || !hint.label || hint.label.length > 200 ||
        !Number.isFinite(hint.centerY) || typeof hint.dark !== "boolean") return;
      const scale = item.ownerWindow.webContents.getZoomFactor() / item.view.webContents.getZoomFactor();
      item.view.webContents.send("jugglework:docs:rail-hint", {
        label: hint.label,
        centerY: hint.centerY * scale,
        dark: hint.dark,
      });
    });
    ipcMain.on("jugglework:docs:appearance", (event, input) => {
      const current = find(input);
      if (
        !trusted(event, input) ||
        !current ||
        !current.ready ||
        input?.instanceId !== current.input.instanceId
      )
        return;
      const appearance = input.appearance;
      if (
        !appearance ||
        !["light", "dark"].includes(appearance.theme) ||
        typeof appearance.locale !== "string" ||
        appearance.locale.length > 20 ||
        typeof appearance.fontFamily !== "string" ||
        appearance.fontFamily.length > 300
      )
        return;
      const colors = {};
      for (const key of [
        "background",
        "foreground",
        "sidebar",
        "border",
        "muted",
        "accent",
        "accentForeground",
      ]) {
        const value = appearance.colors?.[key];
        if (typeof value !== "string" || value.length > 150) return;
        colors[key] = value;
      }
      current.view.webContents.send("jugglework:docs:appearance", {
        instanceId: input.instanceId,
        appearance: {
          theme: appearance.theme,
          locale: appearance.locale,
          fontFamily: appearance.fontFamily,
          colors,
        },
      });
    });
    ipcMain.handle("jugglework:docs:open", (event, input) => {
      if (!trusted(event, input) || ownerFor(event) !== getWindow()) throw new Error("Forbidden");
      return open(input, ownerFor(event));
    });
    // 会议文档视图：所属窗口固定为会议窗口，只有主窗口顶层 frame 可以打开和控制。
    ipcMain.handle("jugglework:docs:meeting-open", (event, input) => {
      const owner = meetingControl(event);
      if (!owner || !input) throw new Error("Forbidden");
      return open({ ...input, meeting: true, retain: false, fullPage: false, background: false, warmup: false }, owner);
    });
    ipcMain.on("jugglework:docs:meeting-command", (event, input) => {
      const item = find(input);
      if (!item || item.input.meeting !== true || !trusted(event, input) || !item.ready || item.denied || !item.meetingViewport) return;
      const id = /^[A-Za-z0-9_-]{1,64}$/;
      let payload;
      if (input.action === "apply-viewport") {
        const v = input.payload?.viewport;
        if (!id.test(v?.workspaceId ?? "") || !id.test(v?.docId ?? "") || !["page", "edgeless"].includes(v?.mode)) return;
        payload = { follow: input.payload.follow === true, sharerName: typeof input.payload.sharerName === "string" ? input.payload.sharerName.slice(0, 20) : "", viewport: v };
      } else if (input.action === "open-page") {
        if (!id.test(input.payload?.docId ?? "")) return;
        payload = { docId: input.payload.docId };
      } else if (input.action === "zoom") {
        const factor = Number(input.payload?.factor);
        if (!Number.isFinite(factor)) return;
        payload = { factor: Math.min(3, Math.max(0.5, factor)) };
      } else return;
      item.view.webContents.send("jugglework:docs:meeting-command", { instanceId: item.input.instanceId, action: input.action, payload });
    });
    ipcMain.handle("jugglework:docs:status", (event, instanceId, hostBinding) => {
      if (!trusted(event, { instanceId, hostBinding })) throw new Error("Forbidden");
      const item = find({ instanceId }); return { ready: !!item?.ready && !item.denied, status: item?.lastStatus ?? (item ? "loading" : "error"), ...(documentFor(instanceId) ?? { docId: null }) };
    });
    ipcMain.handle("jugglework:docs:snapshot", async (event, instanceId, hostBinding) => {
      if (!trusted(event, { instanceId, hostBinding })) throw new Error("Forbidden");
      const item = find({ instanceId });
      if (!item?.ready || item.denied || item.input.background || item.view.webContents.isDestroyed()) return null;
      const image = await item.view.webContents.capturePage();
      return active(item) && trusted(event, { instanceId, hostBinding }) && !item.denied ? image.toDataURL() : null;
    });
    ipcMain.handle("jugglework:docs:close", async (event, instanceId, options, hostBinding) => {
      if (!trusted(event, { instanceId, hostBinding }) || (!instanceId && ownerFor(event) !== getWindow())) throw new Error("Forbidden");
      const owner = ownerFor(event);
      const binding = hostLifetimes.get(owner);
      // TIPS: 退出或切换身份时，使等待保存的旧交接失效，避免关闭列表采集后又建出旧页面。
      if (!instanceId && binding) binding.epoch++;
      const epoch = binding?.epoch;
      const stillBound = () => hostLifetimes.get(owner)?.epoch === epoch && trusted(event, { instanceId, hostBinding });
      // TIPS: 不带实例的整体关闭发生在切换账号、组织或退出登录时，附件缓存随当前范围清理。
      const scopes = !instanceId ? items().map((item) => item.input) : [];
      const targets = instanceId ? [find({ instanceId })].filter(Boolean) : items();
      const requireSaved = !instanceId && options?.requireSaved === true;
      if (!instanceId) {
        warmup.exclude(false);
        if (options?.forgetRecent === true) recent?.clear();
      }
      // TIPS: 主动切换组织要先统一确认，失败时保留当前组织及页面供用户重试。
      if (requireSaved && !(await prepareQuit())) return { closed: false };
      if (!stillBound()) return { closed: false };
      if (!instanceId) for (const item of targets) item.view.setVisible(false);
      let closed = true;
      for (const item of targets) {
        const saved = requireSaved || await (item.warmupCleanup ?? prepareClose(item.input.instanceId));
        if (!saved || !stillBound()) closed = false;
        else if (active(item)) close(item.input.instanceId);
      }
      if (stillBound()) for (const scope of scopes) await attachments?.clearScope(scope).catch(() => undefined);
      return { closed };
    });
    ipcMain.handle("jugglework:docs:file-intake", (event, input) => {
      if (!trusted(event, input)) throw new Error("Forbidden");
      const item = find(input);
      const upload = input?.action === "upload";
      if (
        !item?.ready || item.denied || item.detached ||
        item.input.presentation?.mode !== "product" ||
        (input?.instanceId
          ? input.instanceId !== item.input.instanceId
          : input?.tenantId !== item.input.tenantId) ||
        !["lookup", "upload", "commit", "cancel"].includes(input?.action) ||
        !/^[a-f0-9-]{36}$/i.test(input?.requestId ?? "") ||
        typeof input?.checksum !== "string" ||
        !/^[a-f0-9]{64}$/i.test(input.checksum) ||
        (input?.action === "commit" && !/^[a-f0-9]{64}$/i.test(input.warningAckDigest ?? "")) ||
        (upload &&
          (typeof input?.fileName !== "string" ||
            typeof input?.mimeType !== "string" ||
            !(input?.fileData instanceof ArrayBuffer || ArrayBuffer.isView(input?.fileData)) ||
            input.fileData.byteLength <= 0 ||
            input.fileData.byteLength > 50 * 1024 * 1024))
      )
        throw new Error("docs_product_view_unavailable");
      const requestId = input.requestId;
      if (intakes.has(requestId)) throw new Error("file_intake_in_progress");
      return new Promise((resolve, reject) => {
        // TIPS: preview、页面同步、commit 与 status 各有独立超时；宿主必须晚于完整状态机，不能先误报失败。
        const timer = setTimeout(() => {
          intakes.delete(requestId);
          reject(new Error("file_intake_timeout"));
        }, upload ? 300000 : 40000);
        timer.unref?.();
        intakes.set(requestId, { resolve, reject, timer, item });
        item.view.webContents.send("jugglework:docs:file-intake-command", {
          instanceId: item.input.instanceId,
          requestId,
          action: input.action,
          payload: {
            checksum: input.checksum,
            ...(upload
              ? { fileName: input.fileName, mimeType: input.mimeType, fileData: input.fileData }
              : {}),
            ...(input.action === "commit" ? { warningAckDigest: input.warningAckDigest } : {}),
          },
        });
      });
    });
    ipcMain.handle("jugglework:docs:api", (event, input) => {
      if (!trusted(event, input)) throw new Error("Forbidden");
      const item = find(input);
      if (
        !item?.ready ||
        item.denied || item.detached ||
        item.input.presentation?.mode !== "product" ||
        (input?.instanceId
          ? input.instanceId !== item.input.instanceId
          : input?.tenantId !== item.input.tenantId) ||
        !/^[a-f0-9-]{36}$/i.test(input?.requestId ?? "") ||
        !["search", "read", "edit", "create", "docs-recent", "docs-search"].includes(input?.op) ||
        typeof input?.params !== "object" ||
        input.params === null ||
        JSON.stringify(input.params).length > 300 * 1024
      )
        throw new Error("docs_product_view_unavailable");
      const requestId = input.requestId;
      if (intakes.has(requestId)) throw new Error("file_intake_in_progress");
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          intakes.delete(requestId);
          reject(new Error("docs_api_timeout"));
        }, 40000);
        timer.unref?.();
        intakes.set(requestId, { resolve, reject, timer, item });
        item.view.webContents.send("jugglework:docs:api-command", {
          instanceId: item.input.instanceId,
          requestId,
          api: { op: input.op, params: input.params },
        });
      });
    });
    ipcMain.on("jugglework:docs:highlight-blocks", (event, input) => {
      const item = find(input);
      if (
        !trusted(event, input) ||
        !item?.ready ||
        item.denied ||
        input?.instanceId !== item.input.instanceId ||
        typeof input?.docId !== "string" ||
        !Array.isArray(input?.blockIds) ||
        input.blockIds.length > 200 ||
        !input.blockIds.every((id) => typeof id === "string" && id.length <= 64)
      )
        return;
      item.view.webContents.send("jugglework:docs:highlight-blocks", {
        instanceId: item.input.instanceId,
        docId: input.docId,
        blockIds: input.blockIds,
      });
    });
    ipcMain.on("jugglework:docs:bounds", (event, input) => {
      if (trusted(event, input)) bounds(input);
    });
    ipcMain.on("jugglework:docs:message", (event, message) => {
      const item = find(message);
      if (
        !item ||
        event.sender !== item.view.webContents ||
        event.senderFrame !== item.view.webContents.mainFrame
      )
        return;
      if (
        message?.contractVersion !== 1 ||
        message.instanceId !== item.input.instanceId
      )
        return;
      if (new URL(item.view.webContents.getURL()).origin !== item.origin)
        return;
      if (message.type === "docs.layout") {
        const layout = message.layout;
        if (!item.ready || item.denied || item.detached || message.tenantId !== item.input.tenantId ||
          item.input.presentation?.mode !== "product" ||
          typeof layout?.leftOpen !== "boolean" || typeof layout?.rightOpen !== "boolean" ||
          !Number.isFinite(layout.leftWidth) || layout.leftWidth < 248 || layout.leftWidth > 480) return;
        const win = item.ownerWindow;
        if (win && !win.isDestroyed()) win.webContents.send("jugglework:docs:layout", {
          instanceId: item.input.instanceId,
          layout: {
            leftOpen: layout.leftOpen,
            rightOpen: layout.rightOpen,
            leftWidth: layout.leftWidth * item.view.webContents.getZoomFactor() / win.webContents.getZoomFactor(),
          },
        });
      } else if (message.type === "docs.viewport" || message.type === "docs.sharer-relation") {
        // 视口只在会议视图、页面声明能力后转发，且只交给主窗口里的会议状态。
        const main = getWindow();
        if (item.input.meeting !== true || !item.meetingViewport || !item.ready || item.denied || !message.meeting ||
          message.tenantId !== item.input.tenantId || !main || main.isDestroyed()) return;
        main.webContents.send("jugglework:docs:meeting-event", {
          instanceId: item.input.instanceId, type: message.type, meeting: message.meeting,
        });
      } else if (message.type === "docs.open-in-new-tab") {
        // TIPS: 菜单只能打开当前可见的真实路由，不能由文档提供其他目标或任意 URL。
        if (item.input.background || !item.view.getVisible() || item.input.presentation?.mode !== "product") return;
        const document = documentFor(item.input.instanceId, item.ownerWindow);
        if (!document || message.tenantId !== document.tenantId || message.docId !== document.docId) return;
        onOpenInNewTab?.({
          sourceInstanceId: item.input.instanceId,
          sourceServerOrigin: item.input.sourceServerOrigin,
          sourceUserId: item.input.sourceUserId,
          document,
        });
      } else if (
        message.type === "docs.open-attachment" ||
        message.type === "docs.ai-reference"
      ) {
        if (!item.ready || item.denied || item.detached || item.warmup || message.tenantId !== item.input.tenantId || item.input.presentation?.mode !== "product") return;
        if (message.type === "docs.open-attachment") {
          void attachments
            ?.open({
              scope: {
                sourceServerOrigin: item.input.sourceServerOrigin,
                sourceUserId: item.input.sourceUserId,
                tenantId: item.input.tenantId,
              },
              nativeSession: item.nativeSession,
              contextId: item.contextId,
              origin: item.origin,
              workspaceId: message.workspaceId,
              docId: message.docId,
              blobId: message.blobId,
              name: message.name,
            })
            .catch((error) => send({ instanceId: item.input.instanceId, status: "error", message: `附件打开失败：${error.message}` }));
        } else {
          const win = item.ownerWindow;
          if (win && !win.isDestroyed()) {
            // TIPS: 原生文档持有键盘焦点；先交还宿主，引用标签插入后输入框才能接收输入。
            win.webContents.focus();
            win.webContents.send("jugglework:docs:ai-reference", {
              instanceId: item.input.instanceId,
              tenantId: item.input.tenantId,
              workspaceId: message.workspaceId,
              docId: message.docId,
              title: String(message.title ?? "").slice(0, 200),
              action: message.action === "ask" ? "ask" : "add",
              blockIds: Array.isArray(message.blockIds) ? message.blockIds.filter((id) => typeof id === "string").slice(0, 200) : [],
            });
          }
        }
      } else if (message.type === "docs.ready") {
        if (
          message.tenantId !== item.input.tenantId ||
          typeof message.workspaceId !== "string" ||
          !message.workspaceId
        )
          return;
        // TIPS: 被拒绝的当前页面不能靠迟到的就绪消息重新显示，需重新进入并完成授权。
        if (item.denied) return;
        item.contextId = message.contextId;
        item.readyWorkspaceId = message.workspaceId;
        item.contentStateSupported = message.capabilities?.contentState === 1;
        item.resumeSupported = message.capabilities?.resume === 1;
        item.meetingViewport = message.capabilities?.meetingViewport === 1;
        item.ready = true;
        item.hasBeenReady = true;
        const document = documentFor(item.input.instanceId);
        if (document) onDocumentChanged?.(item.ownerWindow, item.input.instanceId, document);
        send({ instanceId: message.instanceId, status: "ready", workspaceId: message.workspaceId, docId: document?.docId ?? null, title: document?.title });
        if (item.warmup) warmup.settled(item.input.instanceId, true);
        observeContent(item);
      } else if (message.type === "docs.content-state") {
        if (!item.ready || item.denied || message.tenantId !== item.input.tenantId) return;
        const actual = contentTarget(item);
        if (item.startup?.receive(message, actual)) {
          item.presented = { ...actual, contextId: item.contextId };
          rememberPresented(item);
        }
      } else if (
        message.type === "docs.session-expired" ||
        message.type === "docs.error"
      ) {
        item.startup?.cancel("error");
        item.ready = false;
        if (message.type === "docs.session-expired") item.denied = true;
        item.view.setVisible(false);
        send({
          instanceId: message.instanceId,
          status:
            message.type === "docs.session-expired" ? "unauthorized" : "error",
          message: "云文档连接已失效，请重新打开",
        });
        if (message.type === "docs.session-expired") void revoke(item);
      }
    });
    ipcMain.on("jugglework:docs:file-intake", (event, message) => {
      const task = intakes.get(message?.requestId);
      if (
        !task ||
        !active(task.item) ||
        event.sender !== task.item.view.webContents ||
        event.senderFrame !== task.item.view.webContents.mainFrame ||
        message.instanceId !== task.item.input.instanceId
      )
        return;
      intakes.delete(message.requestId);
      clearTimeout(task.timer);
      if (message.ok === true && message.result)
        task.resolve(message.result);
      else
        task.reject(
          new Error(
            message.error || message.result?.message || "file_intake_failed",
          ),
        );
    });
  }
  return { registerIpc, open, close, closeWindow, closeScope, prepareClose, prepareQuit, documentFor, detachWindow,
    /** 查询当前进程已完成的匿名启动样本，用于本机性能验收。 */
    startupDiagnostics: () => startupSamples.map(sample => ({ ...sample })),
    hasViews: ownerWindow => items().some(item => !ownerWindow || item.ownerWindow === ownerWindow), hide: instanceId => find({ instanceId })?.view.setVisible(false) };
}
