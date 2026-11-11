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
