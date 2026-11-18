## ADDED Requirements

### Requirement: 会议白板窗口

Desktop SHALL 在会议进行中从会议工具栏提供「白板」入口，打开一个独立的白板窗口，窗口内为 Excalidraw 画布，界面语言为简体中文，主题跟随应用。同一时间 SHALL 只有一个白板窗口；再次点击 SHALL 聚焦已有窗口。白板窗口 SHALL 由独立页面入口加载，SHALL NOT 加载 IM 连接、会议媒体或主应用运行时。

#### Scenario: 打开白板
- **WHEN** 已入会的用户点击「白板」
- **THEN** Desktop 打开白板窗口并显示可绘制的画布
- **AND** 画布在白板窗口内响应拖拽绘制、快捷键和粘贴

#### Scenario: 会议结束或离会
- **WHEN** 用户离开会议、会议结束、会议窗口关闭或主窗口重新加载
- **THEN** Desktop 关闭白板窗口，并在关闭前保存一次场景

### Requirement: 白板共享

Desktop SHALL 把白板窗口作为一路共享视频推给参会人，复用屏幕共享的推流链路与 `_screen` 流 ID。白板共享 SHALL 只能由会议窗口中带用户手势、且由会议窗口登记过白板共享意图的采集请求触发，SHALL NOT 弹出屏幕选择器，SHALL NOT 需要系统屏幕录制权限。白板与屏幕共享 SHALL 互斥。

#### Scenario: 打开白板并共享
- **WHEN** 用户点击「白板」且当前没有共享
- **THEN** Desktop 打开白板窗口并开始共享白板，不显示选择器
- **AND** 参会人看到白板画面，标签为「白板共享」

#### Scenario: 从屏幕共享切换到白板
- **WHEN** 用户正在共享屏幕时点击「白板」
- **THEN** Desktop 提示「将停止当前屏幕共享并改为共享白板」
- **AND** 用户确认后停止屏幕共享、开始白板共享，不残留采集轨道；取消则保持屏幕共享

#### Scenario: 关闭白板窗口
- **WHEN** 白板共享期间用户关闭白板窗口
- **THEN** Desktop 停止共享，参会人画面消失

#### Scenario: 普通屏幕共享不受影响
- **WHEN** 用户点击「共享屏幕」且没有待处理的白板共享意图
- **THEN** Desktop 照常显示屏幕和窗口选择器

### Requirement: 白板本地保存与导出

Desktop SHALL 以 Excalidraw 原生 JSON 在场景变化后 500ms 防抖自动保存到应用数据目录 `whiteboards/<meetingId>/<whiteboardId>.excalidraw`，同一会议再次打开白板 SHALL 沿用同一 `whiteboardId` 并恢复内容。Desktop SHALL 支持导出 PNG 与 `.excalidraw` 源文件到用户选择的位置。

#### Scenario: 误关后重新打开
- **WHEN** 用户在同一会议中关闭白板后再次打开
- **THEN** 白板显示关闭前的内容

#### Scenario: 非法标识
- **WHEN** 存储请求中的 `meetingId` 或 `whiteboardId` 含路径分隔符、`..` 或超长
- **THEN** 主进程拒绝该请求，不读写文件

### Requirement: 白板离线资源与外部入口

白板 SHALL 从随应用打包的本地目录加载字体，运行时 SHALL NOT 访问 CDN。白板 SHALL 关闭嵌入网页、外部素材库浏览、AI 功能和外部链接打开；白板窗口 SHALL 拒绝新窗口、页面跳转和权限请求。

#### Scenario: 断网使用
- **WHEN** 设备无网络时打开白板并输入中文
- **THEN** 中文手写字体正常显示

#### Scenario: 尝试嵌入网页
- **WHEN** 用户在白板中粘贴网页链接
- **THEN** 白板不创建嵌入网页元素
