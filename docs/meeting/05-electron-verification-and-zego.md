# Electron 实测与 ZEGO 配置

日期：2026-11-06。macOS / Electron 44 开发版。

## 本次验证边界

启动了仓库真实的 `apps/desktop/electron/main.mjs` 和 preload，使用实际 MeetingRoomHost、Zustand 会话、媒体适配器、独立 BrowserWindow 及 IPC。采用独立测试目录、Electron 合成麦克风／摄像头，会议 API、ZEGO SDK 服务响应、IM 聊天室适配器由测试夹具替代；不连接真实会议服务、不采集实际摄像头。

通过主进程 `BrowserWindow.close()` 触发原生关闭事件，未用页面按钮代替原生关窗。退出检查包含本地所有 MediaStreamTrack 的 readyState、聊天室退出适配器调用数、会话状态和原生子窗口消失。

## 结果

| 场景 | 结果 |
| --- | --- |
| 普通成员原生关窗 | 出现退会确认；没有主持人「全员结束」选项 |
| 取消确认／继续会议 | 窗口保留，会话继续 |
| 普通成员确认退会 | 音频、视频轨道全部 ended；退出适配器调用 1 次；窗口关闭 |
| 退会请求失败 | 确认框和窗口保留，显示可重试错误 |
| 返回工作台 | 主窗口获得原生焦点，显示画面和设备控制小浮窗；静音控制生效 |
| 从小浮窗返回会议 | 会议 BrowserWindow 可见并获得原生焦点 |
| 主持人仅自己离开 | 发出 leave；本地轨道全部停止，关闭窗口（服务端自动转交另有 Go 行为测试） |
| 主持人全员结束 | 发出 end；本地轨道全部停止，关闭窗口（远端供应商断流不在本夹具验收范围） |

结构化结果：[results.json](verification/results.json)。截图：[普通成员确认](verification/member-close.png)、[主持人确认](verification/host-close.png)、[主窗口浮窗](verification/main-float.png)。浮窗截图中的服务错误是验证重试行为时主动注入的测试错误。

实测发现原来的 `window.focus()` 无法可靠聚焦原生 Electron 子窗口，已修复为类型化 `meetingWindowFocus` IPC。该接口仅接受主窗口主 frame 调用、仅允许 main / meeting 两个目标。返回主窗口会隐藏会议窗口；返回会议会 show / restore / focus，保留原会话。

应用 TypeScript 检查与 Electron IPC 类型检查均通过。Windows、打包版本、真实 ZEGO／JuggleIM 房间及网络恢复仍需单独验收。

## 重跑方法

测试夹具不进入生产入口。先启动测试 Vite：

```sh
pnpm --dir apps/app exec vite --config tests/fixtures/meeting-electron/vite.config.ts
```

另一个终端启动真实 Electron：

```sh
JUGGLEWORK_ELECTRON_START_URL=http://127.0.0.1:5187/tests/fixtures/meeting-electron/index.html \
JUGGLEWORK_ELECTRON_USERDATA=/tmp/jugglework-meeting-qa \
JUGGLEWORK_DATA_DIR=/tmp/jugglework-meeting-qa-data \
JUGGLEWORK_ELECTRON_REMOTE_DEBUG_PORT=9837 \
JUGGLEWORK_ELECTRON_FAKE_MEDIA=1 \
JUGGLEWORK_DEV_MODE=1 \
pnpm --dir apps/desktop exec electron --inspect=9237 ./electron/main.mjs
```

主窗口打开后执行：

```sh
node apps/desktop/scripts/verify-meeting-window.mjs
```

报告默认保存至 `/tmp/jugglework-meeting-qa-evidence`，可用 `MEETING_QA_OUTPUT_DIR` 覆盖。此脚本只适用于上述测试夹具，不对用户真实会议执行结束操作。

## ZEGO 文件配置（当前实现）

正式配置文件：`/Applications/work/jugglework-server/conf/config.yml`，模板为同目录 `config.example.yml`。本地配置文件已创建且被 Git 忽略。使用已有 Server YAML 加载流程，在启动时读取，修改后重启 Server；不热加载，不从数据库或 Desktop 写入覆盖。

```yaml
meeting:
  enabled: false
  capacity: 25
  admissionConfigured: false
  zego:
    appId: 0
    serverSecret: ""
```

填写同一 ZEGO 项目的数字 AppID、32 字节 ServerSecret（不是 AppSign，也不是临时 Token）。参数齐备后设置 `enabled: true`；实际确认聊天室白名单与 ZEGO 房间准入／结束权限后设置 `admissionConfigured: true`。默认禁用允许先启动 Server 和预约，缺少必填项却启用时会在启动校验中报错，不回显密钥。

配置是 Server 级别，同一 Server 下组织共享此 ZEGO 项目；会议鉴权及 JuggleIM 仍按组织隔离。Desktop「会议 → 设置」只展示状态，不显示或修改 Secret。旧 `organization_meeting_settings` 表不再作为运行时配置源。`PUT /meetings/settings` 拒绝写入并提示文件管理。

Server 仍需完成会议数据库迁移、既有密钥加密配置和组织 JuggleIM 配置。ZEGO Secret 现在直接保存在服务端 YAML，不再加密存入数据库；客户端只获得短期 Token，Secret 不通过读取 API 返回。

AppID 和 ServerSecret 从 [ZEGO 项目控制台](https://console.zegocloud.com/) 获取，参考 [官方 Token 配置说明](https://www.zegocloud.com/docs/live-streaming/token)。当前 vendored ZEGO Web SDK 3.12.0 使用 SDK 内置接入地址，Meeting 只传 AppID 初始化，不再配置或下发 serverUrl。参考 [官方 SDK 调试与配置说明](https://www.zegocloud.com/docs/real-time-video-web/best-practice/debug-and-config)。

房间结束依赖 [SetForbidUserRule](https://www.zegocloud.com/docs/live-streaming-server/api-reference/room/forbid-user-rule/set-forbid-user-rule) 和 [CloseRoom](https://www.zegocloud.com/docs/live-streaming-server/api-reference/room/close)，需项目具备对应权限。`admissionConfigured` 是人工确认，不是自动检测。

验证：配置包、services、apis 完整测试通过；新增用例覆盖实际 YAML 文件加载、启用时完整性校验、数据库不覆盖配置、禁止 API 写入和 Secret 不回传。Desktop 类型检查通过。

## Desktop 本地文件配置

开发环境文件：`/Applications/work/jugglework-desktop/apps/desktop/config/meeting.json`（已创建、Git 忽略）。提交的空模板是相邻的 `meeting.example.json`。

```json
{
  "enabled": true,
  "appId": 0
}
```

填写 ZEGO 项目的 appId，不需要接入地址。Desktop 的 AppID 必须与 Server 相同；不一致会阻止入会，不能拿 A 项目的 Token 登录 B 项目。ServerSecret / AppSign 不允许写入 Desktop 文件，Token 仍由 Server 签发。

Desktop 每次入会前读取文件，改动在下次入会生效，现有会议不热切换配置。首次升级代码需重启 Electron。`enabled: false` 会本地禁用会议，不能用 Desktop 的启用设置绕过服务端禁用。文件缺失或 appId 为 0 时使用 Server 下发的 AppID；填写后与服务端做一致性校验。旧文件中的 serverUrl 字段会被忽略。

打包版本默认读取 Electron userData 目录的 `meeting.json`。可通过环境变量 `JUGGLEWORK_MEETING_CONFIG` 指定任意明确路径；这也是部署统一配置路径的方式。示例：

```sh
JUGGLEWORK_MEETING_CONFIG=/absolute/path/meeting.json pnpm dev
```

Desktop「会议 → 设置」当前展示服务端状态，本地文件在入会前读取并校验；遇到文件格式错误或 AppID 不匹配会直接提示，不会悄悄忽略配置。

## 本地 Desktop 调试的 CORS

会议 REST 地址使用 API 根路径下的 `/v1/meetings`，例如
`https://t-work.jugglework.cn/jwork/api/v1/meetings/settings`。

Server `conf/config.yml` 的 `trustedOrigins` 已设为 `["*"]`。如部署设置了
`JWORK_TRUSTED_ORIGINS`，它会覆盖 YAML，也需设为 `*` 后重启服务。
允许任意来源时，中间件回显实际 Origin（而非在凭证请求中发送字面量 `*`），
包含 `Vary: Origin`、凭证标志和会议所需 Authorization、组织头及 Idempotency-Key。
OPTIONS 在鉴权前返回 204。

2026-11-06 本地 CORS 预检与 URL 回归测试通过；线上测试地址当时仍返回
403，说明线上放行尚未生效。本地配置修改不等于已经部署线上。
