# macOS 窗口共享标注实施计划

> 本文保留历史方案。边框拦截已不再是产品要求；macOS 与 Windows 的统一规则见 `openspec/changes/add-meeting-window-annotation/design.md` 第 5 节。实现时移除现有边框窗，保留画布层级、遮挡和同源尺寸退出。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主讲人在被共享的真实 macOS 窗口上画；标注期间不能用鼠标拉伸边框，窗口实际宽高改变时自动退出标注，但继续共享同一个窗口。

**Architecture:** 主进程保存选择器确认的窗口身份，由只读原生助手跟踪窗口。Electron 将画布与边框拦截窗口排在共享窗口正上方；持有 `MeetingMedia` 的应用渲染进程消费标注数据，在同一 `_screen` 上输出合成画面。首次接入先在显式开发开关下验证始终合成路径，避免退出标注依赖一次未经真实会议验证的 ZEGO 换轨。

**Tech Stack:** Electron 44、Swift / AppKit / CoreGraphics / Accessibility、React / Konva、Canvas 2D / `captureStream`、ZEGO WebRTC 3.12.0、Node test、Bun test。

## 全局约束

- 已批准的需求以 `openspec/changes/add-meeting-window-annotation/specs/meeting-window-annotation/spec.md` 为准。首批只做 macOS；Windows 单独验收，Linux、参会人标注不在范围内。整屏标注、白板、浏览器共享和关闭开关后的普通窗口共享原样保留。
- 不全局截获鼠标，也不向目标应用发送事件或强制恢复尺寸。窗口关闭才停止共享；尺寸变化退出不会调用 `stopShare()`、`getDisplayMedia()` 或终止原始采集。
- `bounds` 用系统窗口的桌面逻辑坐标；视频尺寸用像素。不能用视频尺寸变化单独判断窗口改尺寸，也不能把原型的 18 pt 宽度当成所有应用的缩放热区。
- 未获得真实会议、代表性窗口、打包授权及性能证据前，不默认开启；开关关闭、窗口不受支持、跟踪无法建立时普通共享照常。未被明确要求时不提交、不推送，不改已安装版本或仓库外文档。
- 按 `using-git-worktrees` 选隔离目录。若工作树从分支 HEAD 创建，使用已批准的四份未跟踪 OpenSpec 及本计划作为输入，显式带入隔离树；不要 stash、覆盖或复制当前树的其他修改。

```sh
T="$HOME/.jugglework-source-dev/tools"
export PATH="$T/bunbin:$T/bin:$T/node-v24.22.3-darwin-arm64/bin:$PATH"
export COREPACK_HOME="$T/corepack" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 OPENSPEC_TELEMETRY=0
```

## 先做通路验证，不先做 UI

### 任务 1：记录所选窗口及其系统身份

**文件：** `apps/desktop/electron/meeting-screen-picker.mjs`、`meeting-screen-picker.test.mjs`、`main.mjs`、`packages/types/src/desktop-ipc.ts`、`apps/app/src/app/lib/desktop.ts`。

**接口：** `sharedTarget(): SharedTarget | null`；`SharedTarget = { kind: "screen"; displayId: number } | { kind: "window"; captureId: string; sourceId: string; windowId: number; pid: number }`。新增 `meetingWindowShareTarget` 只向已验证的会议应用主 frame 返回窗口目标或 `null`；应用只读，不允许传回任意 `windowId`/`pid` 让主进程监控。注入 `resolveWindowIdentity(windowId): Promise<{pid:number}|null>`，macOS 非零整数 `window:<id>:<index>` 且 PID 定位成功才保存。

- [ ] **写红测。** 在选择器 fixture 确认 `window:73:0`，注入 resolver 返回 `{pid:812}`，断言下列对象字段；再覆盖 resolver 返回 `null`、用户取消、来源失效、跨 frame 读取被拒绝。所有不能标注的来源仍按原有方式调用采集 callback。

  ```js
  assert.deepEqual(picker.sharedTarget(), {
    kind: "window", captureId: requestId, sourceId: "window:73:0", windowId: 73, pid: 812,
  });
  assert.equal(picker.sharedDisplayId(), null);
  ```

- [ ] **跑红测。** `node --test apps/desktop/electron/meeting-screen-picker.test.mjs`，新用例应先因尚未提供窗口目标而失败。
- [ ] **接入。** 保留 `sharedDisplayId()` 给一期。窗口确认后异步核验身份，在 resolver 返回后再次检查 `pending === current`、owner 和 frame 仍有效；解析失败不能让已确认来源丢失。继续用当前请求 ID 作 `captureId`。真正共享结束才清掉目标。
- [ ] **跑绿测。** 同上；再覆盖二次选择时旧异步返回不能覆盖新目标。新目标查询给后续媒体和标注会话共享同一个 `captureId`。

### 任务 2：只读 macOS 窗口跟踪与退出判定

**文件：** 新建 `apps/desktop/native/MeetingWindowTracker.swift`、`apps/desktop/electron/meeting-window-tracker.mjs`、`meeting-window-tracker.test.mjs`、`apps/desktop/scripts/prepare-meeting-window-tracker.mjs`；改 `electron-build.mjs`、`electron-dev.mjs`、`electron-builder.yml`、`scripts/verify-packaged-macos.mjs`、`package.json` 中的桌面测试列表。

**接口：** 助手支持 `inspect <windowId>` 和 `watch <windowId> <pid>`。stdout 每行一个 JSON：`{status:"visible",pid,bounds:{x,y,width,height}} | {status:"hidden" | "closed" | "needs-accessibility" | "unavailable"}`。`watchWindow(target, onSample): () => void` 返回停止函数；`classifyWindowSample(initialBounds, sample)` 返回 `follow | hide | resize | close | unavailable`，可独立测试。

- [ ] **写红测。** 用同一初始 `{x:20,y:-80,width:640,height:400}` 验证只改位置为 `follow`，宽加 1 或高加 1 为 `resize`，`hidden` 为 `hide`、`closed` 为 `close`，无效可见样本为 `unavailable`；另测分块 JSON、子进程异常、取消后的迟到消息。

  ```js
  const initial = { x: 20, y: -80, width: 640, height: 400 };
  const sample = (bounds) => ({ status: "visible", pid: 812, bounds });
  assert.equal(classifyWindowSample(initial, sample({ ...initial, x: 91 })), "follow");
  assert.equal(classifyWindowSample(initial, sample({ ...initial, height: 401 })), "resize");
  assert.equal(classifyWindowSample(initial, { status: "hidden" }), "hide");
  ```

- [ ] **跑红测。** `node --test apps/desktop/electron/meeting-window-tracker.test.mjs`，新模块缺失时应失败。
- [ ] **实现采样。** `inspect` 仅按 CGWindowID 读取 PID。`watch` 在 watch 进程内通过 `AXIsProcessTrusted()` 检查实际权限，不假定与 Electron 主进程相同；使用 AX 观察已可靠对应的窗口及最小化状态，按窗口 ID + PID 读 CG bounds。AX 到 CG 的匹配必须唯一且经实测，不凭标题猜测、不用私有 AX API。移动期间用持续采样补足通知间隔，关闭由确认的窗口销毁或应用退出判定；临时读不到窗口不能当作关闭或改尺寸。无法建立跟踪返回 `unavailable`；退出时停止监听和子进程。原生助手没有任何 `AXSet*`/`setFrame` 写操作。
- [ ] **接构建并跑绿测。** 沿用 File Window Helper 的 `xcrun swiftc`、目标架构和资源目录构建方式；资源加入 macOS 打包与验包清单，其他平台不编译。用开发包及打包版分别确认权限提示指向实际需要授权的应用或助手；没有权限时只关闭标注入口的开启操作，不动共享。运行上述 Node 测试及 `pnpm --filter @jugglework/desktop typecheck:electron`。

### 任务 3：验证并接入不中断的同轨合成

**文件：** 新建 `apps/app/src/react-app/domains/meeting/window-share-compositor.ts`、`apps/app/tests/window-share-compositor.test.ts`；修改 `apps/app/src/react-app/domains/meeting/zego-adapter.ts` 和 `apps/app/tests/meeting-runtime.test.mjs`。

**接口：** `createWindowShareCompositor(capture: MediaStream): Promise<WindowShareCompositor>`；`WindowShareCompositor = { stream: MediaStream; setOverlay(draw: ((ctx: CanvasRenderingContext2D, width: number, height: number) => void)|null): void; setPaused(paused: boolean): void; invalidate(): void; dispose(): void }`。新增 `meetingWindowShareReady({captureId, ready})`，由媒体持有者的受信主 frame 在发布合成轨成功后上报 `true`，停止共享或降级到原轨时上报 `false`；验证 ID 匹配当前目标。始终合成只是窗口标注支持来源的初始开发路径，不改普通来源。

- [ ] **写红测。** fake video、canvas、track 记录每帧操作，对同一 compositor 做 `原画 → 加叠加 → 清叠加`；断言 `stream.getVideoTracks()[0]` 不变、退出标注不停止原轨、无输入新帧时更新画布能出帧、暂停保留上一帧、重复 dispose 只结束合成端一次。运行 `pnpm --dir apps/app exec bun --conditions=development test --isolate tests/window-share-compositor.test.ts`，新模块缺失时应失败。

  ```ts
  const track = compositor.stream.getVideoTracks()[0];
  compositor.setOverlay((ctx) => ctx.fillRect(1, 1, 4, 4));
  compositor.invalidate();
  compositor.setOverlay(null);
  expect(compositor.stream.getVideoTracks()[0]).toBe(track);
  expect(rawTrack.readyState).toBe("live");
  ```

- [ ] **实现。** 用同渲染进程的无声 video 等第一个有效帧，Canvas 2D 绘制原始画面，使用 `captureStream(0)` 加 `requestFrame()`，在视频帧和标注更新时调度输出，合并同一轮更新。合成尺寸持续取实际视频大小；读不到新帧/最小化时保留最后一帧。初始化超时或合成不支持时，在发布前清理合成资源、直接普通共享并禁止该次窗口标注。开发开关默认关闭，由主进程决定并通过窗口目标查询同步，`getDisplayMedia()` 仍在用户手势时立即调用；捕获成功后才查询已确认目标，并额外检查 `displaySurface === "window"`。
- [ ] **防止尺寸事件迟到时绘制旧笔迹。** 合成器遇到不同像素尺寸的首帧时先输出原画，直到当前会话的跟踪样本确认该帧几何仍对应未变的逻辑宽高，才恢复叠加。不要按宽高比相同恢复；实际宽高有变即使比例相同也退出。为这段保护写先到帧、先到尺寸事件和跨屏 DPI 变化三个顺序测试。如果平台产生无法对应的帧，保留原画，以任务 6 实机结果决定能否启用该来源。
- [ ] **接媒体生命周期。** `MeetingMedia` 将原始采集流和合成流分开保存，以同一个 `createStream` / `startPublishingStream(..._screen)` 发布合成流；原轨结束或目标确认关闭进入原有停止路径。把标注开启/关闭实现为对已发布 compositor 的 overlay 切换，不调用 ZEGO `replaceTrack` 或 `stopPublishingStream`。真正停分享时同时清理两类流。异步初始化或发布处继续使用 `shareGeneration`，旧请求只释放自己创建的资源。保持一期及白板原路。
- [ ] **跑绿测并记录通路证据。** 运行本任务 Bun 测试、`tests/meeting-runtime.test.mjs` 和 app typecheck。随后在开发版真实测试会议用两端验证窗口发布、清叠加后继续出帧以及实际宽高变化；如果尚无远端或发布证据，不默认启用，也不要把本地对照勾成 P0-5。若始终合成性能不达标，另立任务验证 ZEGO 双向换轨及回切失败保底；本计划不实现两套发布路径。

## 再接入真实窗口交互

### 任务 4：边框层与窗口标注会话

**文件：** 新建 `apps/desktop/electron/meeting-window-annotation-layers.mjs` 及对应 `.test.mjs`；修改 `meeting-annotation.mjs`、`meeting-annotation.test.mjs`、`main.mjs` 和 `apps/desktop/package.json`。

**接口：** `edgeBounds(bounds, {inside, outside}): Rectangle[]`；`createWindowAnnotationLayers({ sourceId, BrowserWindow, ... }): { follow(bounds):void; hide():void; show():void; dispose():void }`。每次窗口标注有 `captureId` + 新 `annotationId`。主进程只在媒体端确认此 `captureId` 有合成输出且跟踪可用后打开；`closeAnnotation(reason)` 的 `reason` 为 `manual | resized | target-closed | tracking-lost`。

- [ ] **写红测。** 对负坐标、四角连续性、热区外标题栏通畅写几何用例；用 fake `BrowserWindow` 验证两种工具模式拦截层都不透传，指针模式 canvas 透传；窗口移动只 `setBounds`；最小化时全部输入层隐藏；`resized` 只销毁本轮标注、不清共享目标；`target-closed` 才触发停止。启动过程中尺寸改变、快速重开和旧 watcher 迟到分别覆盖。

  ```js
  const ring = edgeBounds({ x: 100, y: -200, width: 640, height: 400 }, { inside: 9, outside: 9 });
  assert.equal(ring.length, 4);
  assert.ok(ring.some(({x,y,width,height}) => 102 >= x && 102 < x+width && -198 >= y && -198 < y+height));
  assert.ok(ring.every(({x,y,width,height}) => !(420 >= x && 420 < x+width && -180 >= y && -180 < y+height)));
  ```

- [ ] **跑红测。** `node --test apps/desktop/electron/meeting-window-annotation-layers.test.mjs apps/desktop/electron/meeting-annotation.test.mjs`。
- [ ] **实现。** 近透明、无边框、不可聚焦、不可缩放的窗口使用独立窄条，固定 `cursor: default`；不装 preload、不授予页面权限。画布贴合采集范围。将画布和窄条按相对顺序 `moveAbove(sourceId)`，让窄条在画布上且全部仍低于原有遮挡窗；画布因绘图聚焦后重新恢复相对层级。整屏保留原有 topmost 逻辑。用样例参数跑原型对照，再以代表性应用的直接拖拽结果校准适用范围。不能建立层级或无法跟踪时销毁试开窗口，不影响普通共享。
- [ ] **实现退出。** 捕获得到首个可靠窗口 bounds 时固定逻辑宽高；按任务 2 的状态分流。退出先使当前 `annotationId` 失效并发送退出事件，再处理销毁，避免关闭事件重入。最小化与恢复单独处理，恢复发现已经改变宽高，先关闭标注再恢复纯窗口视频。原生跟踪错误时关闭标注而不是停止共享。主进程监听器按每个会话解绑。
- [ ] **跑绿测。** 同 Node 命令；另外运行 `meeting-screen-picker.test.mjs` 和桌面 typecheck。

### 任务 5：笔迹同步与界面状态

**文件：** `apps/desktop/electron/annotation-preload.cjs`、`preload.mjs`、`meeting-annotation.mjs`；`packages/types/src/desktop-ipc.ts`、`apps/app/src/app/lib/desktop.ts`、`apps/app/src/annotation/main.tsx`、`apps/app/src/react-app/domains/annotation/annotation-canvas.tsx`；新增 `apps/app/src/react-app/domains/annotation/annotation-scene.ts` 与 `apps/app/tests/window-annotation-scene.test.ts`；修改会议 `use-meeting-annotation.ts`、`meeting-room.tsx`、`store.ts`、`zego-adapter.ts`。

**接口：** `WindowAnnotationEvent = {captureId:string; annotationId:string; seq:number; kind:"opened" | "scene" | "paused" | "resumed" | "closed"; scene?:AnnotationScene; reason?:"manual" | "resized" | "target-closed" | "tracking-lost"}`。`AnnotationScene = { elements: AnnotationElement[]; draft: AnnotationElement|null; lasers: { stroke: AnnotationStroke; opacity:number }[]; viewport: {width:number;height:number} }`。`reduceWindowAnnotation(current,event)` 按 capture、annotation ID 和序号接收、清理或拒绝事件；`drawAnnotationScene(ctx,scene,w,h):void` 为合成输出绘制，不接受输入。窗口尺寸与显示映射校验由主进程单独上报，不使用场景里的 `viewport` 作为窗口身份或系统尺寸证明。

- [ ] **写红测。** 用下面序列验证关闭即时清空、同会话迟到帧不复活、新会话从空白开始；另验有效草稿、撤销、清除、橡皮和激光衰减会更新远端绘制数据，像素尺寸变化不误判为关闭。

  ```ts
  const event = {captureId:"share-a", annotationId:"annotation-1"};
  const opened = reduceWindowAnnotation(initial, {...event, seq:1, kind:"opened"});
  const closed = reduceWindowAnnotation(opened, {...event, seq:2, kind:"closed", reason:"resized"});
  expect(reduceWindowAnnotation(closed, {...event, seq:3, kind:"scene", scene})).toEqual(closed);
  ```

- [ ] **跑红测。** `pnpm --dir apps/app exec bun --conditions=development test --isolate tests/window-annotation-scene.test.ts tests/annotation-model.test.ts`。
- [ ] **实现模型与转发。** 本地画布继续是笔迹、草稿、激光和历史的唯一写入方；从同一可见场景给本地 Konva 与远端合成输出。共享坐标、线宽缩放、形状参数和激光透明度计算；用实际画布 viewport 计算远端样式。每刷新帧最多接受一份场景消息；校验发送者为当前画布主 frame、只允许有限数值/归一化坐标/允许的工具和样式，限制每条消息的点数与字节量。由主进程填会话 ID、序号，不信任消息中的身份。主进程只发给持有 `MeetingMedia` 的受信渲染进程；会议小窗继续复用既有界面状态，不持有第二套合成。
- [ ] **接生命周期。** `opened` 清场；`scene` 更新 overlay；`paused` 保留最后输出且暂停更新；`resumed` 恢复；`closed` 同步清掉 overlay 并更新按钮状态。`resized` 显示「窗口大小已改变，已退出标注，窗口共享仍在继续」，不更改共享按钮和来源；`target-closed` 才触发本次媒体的停止。绑定当前 `captureId`，旧事件不能作用于下一次共享。记录退出原因、采集帧尺寸和输出帧尺寸供远端对照，不记录画面内容。验证本地与远端颜色、线型和位置，特别是荧光笔与激光。
- [ ] **跑绿测。** 运行本任务 Bun 命令、`tests/meeting-runtime.test.mjs`、两套 typecheck；先在开发开关下联测，再做发布验收。

## 任务 6：发布验收（开发开关保持关闭，直到证据齐全）

- [ ] **回归与构建。** 运行 `pnpm --filter @jugglework/app typecheck`、`pnpm --filter @jugglework/desktop typecheck:electron`、`pnpm --filter @jugglework/desktop build:electron`；需打包验证时使用 `pnpm --filter @jugglework/desktop package:electron:dir` 并执行仓库 macOS 验包脚本。确认新的测试文件也进入桌面 `package.json` 的测试列表。运行 `npm exec --yes --package=@fission-ai/openspec@1.4.0 -- openspec validate add-meeting-window-annotation --strict --no-interactive`。
- [ ] **真实鼠标交互。** 在隔离开发版上分别选用 AppKit（如 TextEdit）、Chromium（如 Chrome）及实际演示应用。开关前后各测试四边四角、内外侧命中区、鼠标/绘图切换、标题栏移动、内容点击、滚动、前后遮挡窗口的点击和跨屏。退出后重测原有边缘操作。不同窗口样式未通过的保持不可用，不以事后退出代替真正拦住鼠标拖拽。
- [ ] **真实会议连续性。** 两设备，先记录普通共享同窗口的 1080p／近 4K 基线，再用开发开关做 `原画 → 标注 → 自动退出`。分别由应用主动改宽度、系统平铺或能改尺寸的标题栏操作触发；记录原窗口仍继续、发布 stream ID 未变、无新共享选择器及黑帧、没有把旧笔迹绘到新尺寸、重开为空白。特别测原尺寸与新尺寸同宽高比，以及采集帧变化先于 native 通知的时序；如果看见错位旧笔迹或停流，记录失败，保持开关关闭。验证最小化/恢复、窗口关闭、系统权限拒绝及快速停止再共享。稳定输出帧率要求不低于原共享基线 90%。
- [ ] **记录证据和上线判定。** 在 `openspec/changes/add-meeting-window-annotation/tasks.md` 只勾有实测证据的项目。只有真实会议性能和连续性通过，才将始终合成作为 macOS 路径写回 `design.md`，并标明真实换轨因未采用而不作为已通过；否则记明失败与待验证项。Windows、二期 B 和一期尚未验收事项保持独立。
