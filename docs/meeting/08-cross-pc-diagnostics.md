# 双 PC 音频与信令诊断（2026-11-10）

## 当前结论

两端更新后仍断音；Windows 开摄像头有卡住现象。目前没有取得该 Windows PC 的现场日志，也没有重现该机器的驱动/设备环境，不能宣称已修复这两个问题。Mac 原有 `/tmp/meeting-polish-electron.log` 未包含 ZEGO 推拉流质量和设备错误事件，不能凭它判断音频在哪个环节中断。

已经用可控并发测试确认并修复一个独立的退出竞态：结束请求等待期间，周期续期替换了 `lease` 对象，旧版 `current !== lease` 判断导致成功结束后跳过本机清理。改为判断会议会话 generation，续期不会被误认为换会；若期间确实换会，旧请求仍不能清理新会话。测试先得到 `joined != idle` 失败，修复后通过。该结论不能解释或代替双端断音根因。

## 独立 PC 如何采集

1. 两端更新到包含 `meeting-trace-20261110-1` 的版本，完全退出并重新启动 Electron（原生进程诊断需要重启）。按原本出问题的操作进入同一场会议，双方交替讲话；先测试关麦入会再开麦，再测试开关摄像头。
2. 出现单通/双端无声时，记下哪端听不到哪端、当地时间、当时操作；立即分别点击会中右上角「导出诊断」，或工作台「会议」页顶部「导出会议诊断」，保存 JSON。不要先重启或重新入会覆盖现场。
3. Windows 若整个界面无响应，先等待约 10 秒（便于记录无响应/待完成操作），然后必要时重启，在会议首页直接导出，无需重新入会。将两端 JSON 和简短的现象说明一并提供。

不需要远程控制或手工打开开发者工具。导出由系统保存对话框选择位置。原生日志附在 JSON 的 `native` 字段；原生落盘文件为 Electron `userData/meeting-native-diagnostics.json`。渲染器诊断保存在同一应用源的 localStorage（键 `jugglework.meeting.diagnostics.v1`），完整退出后继续保留，开发模式端口/源和数据目录需保持一致。

保留最近 1200 条渲染器事件、最近 200 条原生事件，故障后应立即导出。日志含会议/用户/会话/流标识，用于双端关联；不包含令牌、密钥、聊天正文、设备标签、音视频内容。质量对象只保留数值和布尔指标。导出有 `storageAvailable` 标记；磁盘/配额失败时只保证内存记录，不能保证重启恢复。

## 记录内容与分析顺序

| 环节 | 事件 | 判读方式 |
| --- | --- | --- |
| 设备授权/采集 | `device.permission`、`device.create`、`device.getUserMedia` 的 start/done/failed/pending | 8 秒 pending 表示 Promise 尚未完成，不等价于整个进程冻结；没有擅自超时取消 SDK 操作 |
| 切换轨道 | `device.addTrack`、`device.replaceTrack`、`device.enableVideoCaptureDevice` | 对齐开视频操作，检查卡在哪个调用、音轨是否随之结束 |
| 采集轨道 | `rtc.sample` | 每 5 秒记录 enabled/muted/readyState、音频处理设置及视频尺寸；时间间隔扩大可能是主线程阻塞或睡眠，不能仅凭间隔判定原因 |
| 推流 | `rtc.publish.start`、`rtc.publisherStateUpdate`、`rtc.publishQualityUpdate` | 区分采集、发布失败、码率/音量/丢包异常 |
| 拉流 | `rtc.streams`、`rtc.play`、`rtc.playerStateUpdate`、`rtc.playQualityUpdate` | 按同一流 ID 对齐 A 的发送与 B 的接收，及反方向 |
| 播放 | `audio.bind/playing/blocked/sink/unbind` | 确认 audio 元素 paused/muted/volume/currentTime 和音轨状态，按 streamId 与 `rtc.sample` 关联 |
| 业务状态 | `http.*`、`api.*`、`meeting.snapshot/cleanup/leave.result` | HTTP 状态、耗时、服务端 Date（如可读）、会议 version/status/session，对齐轮询/续期/结束 |
| IM 信令 | `signal.send/sent/failed/receive`、`chat.joined/failed` | 对照 seq/session 与 accepted，不把本端发送成功当成对端收到 |
| 原生进程 | `window.unresponsive/responsive`、`renderer.gone`、`child.gone` | 判断渲染器与 GPU 等进程是否崩溃/退出；记录原因和退出码，不包含窗口内容 |

使用 UTC `at` 对齐两端，再用每端 `endpoint`、单调 `clock` 和操作编号排顺序。两台电脑时钟可能不一致，不能仅按同一秒判断丢失信令。查不到事件也不能直接等同于发送失败（可能环形缓冲已淘汰或存储失败）。

推拉流质量字段依据当前内置 ZEGO 3.12.0 事件及[官方质量监控文档](https://www.zegocloud.com/docs/real-time-voice-web/communication/monitor-stream-quality)。诊断只监听已有质量回调，不额外采集音频或接管 SDK 连接。

## 验证边界

本地自动化覆盖：退出与续期交错、日志保留与重启恢复、敏感字段过滤、存储失败不阻断业务、原生无响应/崩溃事件保留，以及既有媒体与会议信令测试。双真实 PC 的持续通话、Windows 摄像头驱动、双端终止同步，须拿到这次现场日志后定位并按同一路径复测。

本轮本机验证：18 项会议/诊断自动化测试通过，前端与 Electron 类型检查通过，IPC 桥接检查通过；实际启动 Electron，通过真实 IPC 导出到临时 JSON，确认同时包含渲染器事件与 `process.start` 原生事件，两个存储可用标记均为 true。该导出验证没有模拟 Windows 摄像头故障，也没有进行双 PC 通话验收。

## 16:20–16:22 本机现场与修复

已读取这次实际故障的持久化诊断，保存为本机临时证据 `/tmp/meeting-current-evidence.json`（不提交现场用户标识到仓库）。北京时间 16:21:13 点击开视频；授权约 19ms 完成，浏览器摄像头采集约 1501ms 完成；16:21:14 进入 `device.addTrack`，8 秒后仍 pending，直到 16:22:17 断开前都没有 done。期间视频已在传输、生命周期轮询继续，但应用的 `cameraEnabled` 一直为 false，说明是 SDK 操作 Promise 未完成，而非整个渲染进程冻结。

内置 ZEGO 3.12.0 的 `handleTrack(ADD)` 查询轨道所属 SDK preview，再用 `preview.videoInfo` 更新目标 preview。对于直接由 `navigator.getUserMedia` 创建的视频轨道，此处没有源 preview，随后 `updateVideoInfo(undefined)` 读取 width 等字段抛异常。异常发生在内部异步函数，外层 addTrack Promise 未获得 resolve/reject，导致设备状态与实际发送状态不一致，界面共用 busy 一直保持。

修复：首次追加摄像头通过 ZEGO `createStream({camera:{audio:false,video:true}})` 建立源 preview，再追加其视频轨道。源 preview 保留到离会统一销毁；原有麦克风与发布流不重建。设备 busy 与聊天/邀请/导出/离会操作分离。30 秒仍未完成的设备切换停止本机会话并提示重新加入，不让晚到的 SDK 操作恢复已退出的会话。

本机实际验证：音频入会后开启视频约 839ms；连续四次开关摄像头均完成，麦克风轨道保持同一个对象；真实会议窗口模拟 8 秒设备响应慢时仅设备按钮等待，聊天、邀请、导出、离会保持可用。开麦入会与关麦入会后开麦两条路径均测得原始麦克风及 ZEGO 云端返回的非零音频能量，测试结束后轨道为 ended。测试中单机云端返回仅用于定位本机链路，不能作为 Windows 双机验收。

故障现场中，来自对端的 audioBitrate 约 43–50kbps，音频帧和播放时间持续前进，audioLevel 与累计 totalAudioEnergy（SDK 字段 audioSendLevel）始终为零；该现象在本机点击开视频之前已存在。对端 IM 报告 mic=true，RTC 麦克风状态 OPEN，所以不能将 UI 亮麦或有码率等同于有声音。仍需发送端同场日志或实际采集/编码能量验证；本轮不宣称已解决该独立双端无声问题。

## Windows 与 Mac 同场对照后的根因修正

收到 Windows 导出后，已对齐北京时间 16:53 的同场记录：两端均关麦入会后开麦，采集轨道 live/enabled，双向码率约 48kbps、帧率约 50fps、播放器 paused=false/muted=false，但接收能量为零。

**修正此前推断：接收统计的能量会受播放路径音量影响，不能单凭 energy=0 判定发送端输出了静音。** 在当前 ZEGO + Electron 跨窗口链路上，对同一独立接收流执行固定测试音对照：主窗口 audio 播放时接收 level≈0.015；将含音轨的同一 MediaStream 绑定给会议子窗口的 muted video 后，level=0；子窗口 video 改为不含音轨的流，level 恢复≈0.015。音频码率在这期间始终存在。这与产品的主窗口 audio + 子窗口全量 stream 静音 video 结构一致；纯音频会议也会创建该 Video 组件，所以同样受影响。

修复约束：Video 的 srcObject 必须是仅包含视频轨道的独立 MediaStream，不能靠 muted=true 隔离同一流中的音轨。音频只由主窗口独立 audio 组件播放。本地预览、远端视频、屏幕共享统一使用 `bindMeetingVideo`；动态增加/移除视频轨道时同步视图，不停止 SDK 原始轨道，切麦不重新绑定视频流。

验证分层：新增单元回归保证任何时刻视频视图的音轨数为 0、摄像头动态变化可同步、视图销毁不停止 RTC 轨道；`node apps/desktop/scripts/verify-meeting-audio-window.mjs` 运行无凭据的真实 Electron 双窗口 WebRTC 测试，验证视图契约和视频增删期间的声音能量。该离线夹具不包含 ZEGO，旧版绑定在该夹具中未必触发静音，不能把它当作完整根因复现；根因对照使用了真实 ZEGO 云端、独立接收身份和产品窗口。

全新会话复测：独立接收身份使用真实 ZEGO 云端，接收流交给实际 `MeetingRoomHost` 组件（主窗口 audio、会议子窗口 video）。8 次连续采样 level≈0.02011，累计能量由 0.00161 增至 0.01416；期间两次开摄像头、一次关摄像头，视频轨道数在 0/1 切换，视频元素音轨数始终为 0，测试音轨始终 live，audio 保持正常播放。已结束测试会话、释放所有媒体。新导出的诊断标识为 `meeting-trace-20261110-2-video-only`，便于确认 Windows 是否加载了此次修复。两台真实 PC 的最终人工互听仍需更新后验收。

收尾回归：22 项会议/诊断测试、前端和 Electron 类型检查通过；独立 Electron 双窗口夹具中，创建子窗口、增加视频轨道、移除视频轨道后的音频 level 均保持 0.002014，视频元素音轨数为 0。
