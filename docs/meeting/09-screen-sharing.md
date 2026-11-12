# 屏幕共享权限修复与验证

日期：2026-11-11。环境：开发版 Electron 44.0.0，macOS 26.2。

## 根因及修复

在实际会议同结构的 `about:blank` 子窗口调用 `getDisplayMedia({video:true,audio:false})`，修复前立即返回 `NotAllowedError: Permission denied`。主进程记录到的请求为：

```json
{"permission":"media","details":{"isMainFrame":true,"mediaTypes":[],"requestingUrl":"about:blank","securityOrigin":"http://localhost:5173/"},"allowed":false}
```

现有规则只允许子窗口的 `display-capture`，错误拒绝了当前运行版本使用的兼容请求形态。新增对明确空 `mediaTypes`、顶层受信窗口的请求处理；远端来源、其他窗口、子框架及带 audio/video 的摄像头麦克风请求仍拒绝。权限检查阶段不放开通用 media。现代 `display-capture` 路径继续支持。

保留系统选屏与授权机制，不根据 macOS screen 状态预先阻止系统选屏器。采集增加 `rtc.share.capture` 诊断；区分取消、未授权、窗口未激活、系统无法启动采集。发布失败（返回 false 或抛出异常）也停止采集轨道，避免后台残留共享。

实际授权后继续发现 ZEGO 发布错误 `1103044: stream is not from zego`：原实现直接把浏览器采集流交给 `startPublishingStream`。修复为在主渲染器创建仅含采集视频轨道的 `MediaStream`，再调用 `createStream({custom:{source,videoOptimizationMode:"detail"}})` 注册 SDK 预览流，最后发布。跨窗口重建容器是为了满足 SDK 的 MediaStream 类型判断，不重新采集摄像头、麦克风或屏幕。SDK 可能为视频源附加静音音轨，不能把它当作用户麦克风。

原始屏幕流与 SDK 流分别持有；停止、系统结束共享、发布失败及离会都释放两者。共享请求带独立代次，阻止重复选择器、停止后迟到的采集或注册结果重新开始推流。新增 `rtc.share.register`、`rtc.share.published` 与发布失败诊断，SDK 错误不再误报成系统权限失败。

参考：[Electron session 权限与选屏 API](https://www.electronjs.org/docs/latest/api/session)。兼容分支以本机真实权限回调为依据，不能仅依照文档中的权限类型假设运行时行为。

ZEGO 自定义源参数：[ZegoCustom / createStream](https://doc-zh.zego.im/live-streaming-web/client-sdk/api-reference/interface#zegocustom)。

## 验证及边界

- 会议运行时、诊断、浮窗与权限 30 项回归通过，覆盖兼容请求、远端/其他窗口/子框架拒绝、取消、采集失败、发布失败、系统停止共享及离会后迟到采集。
- 重启开发 Electron 后执行 `node apps/desktop/scripts/verify-meeting-screen-share.mjs`，使用独立 session 和真实 Chromium，采集指定测试页自身。两轮均得到 live 视频轨道和实际解码画面（本机 2560×1792），停止后轨道 ended；第三轮取消选屏正确拒绝，会议子窗口请求摄像头仍被拒绝。
- 此脚本需要前端开发服务及 Electron `--inspect=9237`，可用 `MEETING_QA_NATIVE_PORT`、`MEETING_QA_APP_URL` 覆盖；仅捕获测试页，不读取桌面内容、不连接 ZEGO 云端、不更改应用默认 session 的选屏处理器。
- 用户开启授权后，直接从开发命令启动仍返回 `denied`、无法枚举共享源；改用 macOS LaunchServices 打开同一个 Electron.app 后返回 `granted`，真实系统窗口采集成功。没有修改系统权限数据库或重新签名应用。
- 真实系统窗口 → ZEGO 发布 → 云端回拉 → 单独显示窗口验证通过，目视确认色块和动态时钟。接收视频 2360×1646，连续两次采样解码帧数 71 → 137，约 19–20fps；停止后重新共享也正常，第二轮采样已解码 97 帧，约 28fps。
- 离会时原始采集 video 轨道及 SDK audio/video 轨道均为 ended，会议状态 idle。临时会议与接收窗口已清理；再次启动 Electron 恢复原有系统选屏处理器。
- 本机云端测试使用应用已授权会议连接回拉自身共享流，没有生成第二账号凭据；系统采集选择的是专用色块测试窗口。另一台 PC 的接收结果由用户现场确认：「另一台已经收到屏幕共享流了，验证通过」。这项双端结论来自用户确认，不是本机模拟第二台 PC。
- 前端与 Electron 类型检查通过；30 项回归含 SDK 自定义源注册、注册期间停止、重复请求及迟到流清理。

## 系统授权后复测

1. 在系统设置的「隐私与安全性 → 屏幕与系统音频录制」中允许实际运行的应用；开发版为仓库 `node_modules/.pnpm/electron@44.0.0/node_modules/electron/dist/Electron.app`。
2. 完全退出并重新启动 Electron，在会议窗口选择共享桌面或指定应用窗口，确认本机及远端均显示画面。
3. 停止共享后再次开启；取消选择不留下采集轨道；离会后系统录制指示应消失。

本机开发命令启动若仍显示未授权，可先退出开发 Electron，再通过 macOS 应用启动机制运行同一应用包（需先启动前端服务）：

```sh
open -n -a /Applications/work/jugglework-desktop/node_modules/.pnpm/electron@44.0.0/node_modules/electron/dist/Electron.app \
  --env JUGGLEWORK_DEV_MODE=1 \
  --env JUGGLEWORK_ELECTRON_START_URL=http://localhost:5173 \
  --args /Applications/work/jugglework-desktop/apps/desktop/electron/main.mjs
```

该方式沿用用户已给 Electron.app 的授权；不需要给其他应用增加屏幕访问权限。

## 自定义共享选择弹窗（2026-11-11）

共享按钮现在在独立会议窗口内打开「桌面与窗口」Modal。展示两列真实缩略图、桌面/窗口分类、应用图标筛选、选中边框及固定底部的取消/开始共享。只有明确选中并确认才开始采集；关闭按钮、Escape、离会及超时均取消请求。没有默认自动共享第一个桌面的行为。截图中的白板不属于本次范围，不展示无功能入口。

Electron 使用 `desktopCapturer.getSources` 枚举桌面与应用窗口，通过应用图标分组（SDK 不提供独立应用名称，提示使用真实窗口标题）。预览不可用时显示占位，窗口关闭后确认会提示刷新重选；筛选变化清除旧选择，刷新保留仍有效的选择。权限失败保留系统设置入口。列表滚动、底部按钮固定，支持小尺寸窗口与现有主题。

`meeting-screen-picker.mjs` 持有当前 `getDisplayMedia` 请求及一次性 requestId，`useSystemPicker:false` 启用应用内选择界面，系统录屏授权仍必须满足。主进程仅接收可信主窗口顶层 IPC，并验证请求来源、用户手势、请求 ID、已枚举的源 ID 与源的当前可用性。确认时将选定源交还同一个 Chromium 回调；取消时返回 null。原有会议窗口用户手势、ZEGO 自定义源注册和停止/离会清理流程不变。

请求最多等待两分钟；会议窗口或主窗口销毁、渲染进程退出、主窗口导航时释放。前端通过主渲染器接收 IPC，React Portal 将弹窗显示在会议窗口，不创建第二个 SDK 实例，也不重载会议。

验证：

- 新增原生选择器回归，覆盖确认、取消、伪造请求、并发选择、窗口消失、取消后迟到结果、窗口/渲染器退出及超时。
- `node apps/desktop/scripts/verify-meeting-screen-picker.mjs` 在真实 Chromium 中验证 1000×820、720×540 两种窗口，覆盖选中但未确认不共享、筛选清空选择、过期源报错后重试、Escape、空列表以及弹窗尺寸稳定。
- 重启实际 Electron，临时会议枚举 23 个真实共享源；未选择时禁止开始共享，关闭弹窗后无发布流，随后可重新打开。
- 选择专用测试窗口后成功采集/发布 1640×1080；停止后再次选择共享成功。ZEGO 云端回拉连续采样解码帧数 51 → 154，约 29–30fps。这里只验证本机云端回拉，并非第二台 PC 的新测试。
- 测试结束时会议 idle，两个发布流全部轨道 ended，测试窗口与接收窗口已关闭。

本节取代前文的系统选屏器入口描述；前文权限及媒体链路修复仍有效。

### 独立窗口样式与应用图标清晰度

实际会议窗口曾继续使用创建时克隆的旧 CSS：虽然 React 更新了左右箭头，三个操作按钮仍比应用图标中心低 11.5px。新增 `syncMeetingWindowStyles`，在不重载会议页面的情况下同步主窗口样式的新增、更新和移除。实际会议弹窗复测中心偏差为 0，临时 CSS 属性的新增/更新/删除同步通过。

其他应用的图标必须从 Electron NativeImage 的最高可用 scaleFactor 导出；本机返回 32px 的 1× 和 64px 的 2× 表示，界面保持 32 CSS px 显示。原生进程的代码不会被 Vite 热更新，因此此前启动的 Electron 仍返回旧 32px 图标，需要完整重启后加载高清导出。活动会议期间不强制重启。

### 预览与导航细节

- 快照保持原比例居中，圆角直接裁切实际图片边缘，消除系统窗口快照四角的黑色像素；真实横向、纵向测试窗口已验证。
- 顶部应用/桌面图标及底板缩小至原来的 2/3（常规底板 54 → 36px，应用图标 32 → 约 21.33 CSS px）；左右箭头与刷新保持同一中心线，两种 Electron 窗口尺寸测量偏差均为 0。
- 会议主页头部空白区设置为原生拖动区，三个视图标签和按钮明确设为 no-drag；实际页面验证首页、日历、历史均可点击切换。隐藏头部配置按钮，未就绪提示中的配置指引仍保留。

### 安装包的首次授权与重启

在会议首页可以分别点击「授权麦克风」「授权摄像头」「授权屏幕录制」，提前完成设置。打开首页只查询授权状态。也可以在入会预览或会中首次使用设备时，根据系统提示授权。Windows 的麦克风和摄像头受桌面应用隐私开关控制。

在 macOS 系统弹窗中允许 JuggleWork 后，点击「重启 JuggleWork」。如果之前点过拒绝，可用「打开系统设置」进入对应权限页，打开 JuggleWork 的开关后返回重启。会中按钮为「离开会议并重启 JuggleWork」，按普通离会流程释放本人的会话和媒体，再由 Electron 主进程清理运行时并重新启动。稍后重启也可以继续留在会议中。

macOS 打包校验会检查三项用途说明，并从主应用签名中读取摄像头和音频输入授权。安装新版后应从安装目录启动 JuggleWork 复测；开发环境中对应的应用名为 Electron。
