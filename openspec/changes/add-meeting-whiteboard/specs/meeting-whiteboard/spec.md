## ADDED Requirements

### Requirement: 选择器中的白板入口

Desktop SHALL 在会议「共享屏幕」打开的「桌面与窗口」选择器中提供白板来源：筛选栏 SHALL 依次为「全部 / 桌面 / 白板 / 窗口」；「全部」中「会议白板」卡片 SHALL 排在桌面之后、窗口之前；选择「白板」筛选时 SHALL 只显示「会议白板」卡片。会议工具栏 SHALL NOT 提供单独的白板按钮。

#### Scenario: 选择白板并开始共享
- **WHEN** 已入会且没有进行中共享的用户点击「共享屏幕」，在选择器中选择「会议白板」并点击「开始共享」
- **THEN** 选择器关闭，不采集任何系统屏幕或窗口
- **AND** 白板在会议窗口中打开并开始共享

#### Scenario: 没有可共享的系统画面
- **WHEN** 选择器获取不到任何桌面或窗口
- **THEN** 列表仍显示「会议白板」卡片，用户可以选择它共享

### Requirement: 会议窗口内的白板共享

Desktop SHALL 把白板显示在会议窗口的共享区域，与屏幕共享画面占同一位置，SHALL NOT 为白板打开新的原生窗口。白板画布为 Excalidraw，界面语言为简体中文，主题跟随应用，并 SHALL 在会议窗口内响应拖拽绘制、快捷键、粘贴与中文输入。白板画面 SHALL 作为一路共享视频推给参会人，复用屏幕共享的发布链路与 `_screen` 流 ID，SHALL NOT 需要系统屏幕录制权限。

#### Scenario: 参会人看到白板
- **WHEN** 主讲人开始共享白板并在白板上绘制
- **THEN** 参会人看到白板画面，标签为「白板共享」

#### Scenario: 会议窗口不在前台
- **WHEN** 共享白板期间会议窗口被遮挡、失去焦点或收成会议小窗
- **THEN** 参会人看到的白板画面继续更新

### Requirement: 白板与屏幕共享互斥

白板共享与屏幕共享 SHALL 共用一路共享，同一时间只进行一种。共享进行中，「共享屏幕」按钮 SHALL 显示为「停止共享」；用户 SHALL 先停止当前共享，才能重新选择白板或其他画面。停止共享 SHALL 关闭白板并结束推流，SHALL NOT 残留采集轨道。

#### Scenario: 从屏幕共享改为白板
- **WHEN** 用户正在共享屏幕
- **THEN** 「共享屏幕」按钮显示为「停止共享」，点击后停止屏幕共享
- **AND** 用户再次点击「共享屏幕」后可以在选择器中选择白板

#### Scenario: 停止白板共享
- **WHEN** 白板共享期间用户点击「停止共享」
- **THEN** Desktop 停止推流并关闭白板，参会人画面消失

#### Scenario: 会议结束或离会
- **WHEN** 白板共享期间用户离开会议、会议结束或会议窗口关闭
- **THEN** Desktop 停止白板共享，并在关闭白板前保存一次场景

#### Scenario: 普通屏幕共享不受影响
- **WHEN** 用户在选择器中选择桌面或窗口并开始共享
- **THEN** Desktop 照常采集所选画面并共享

### Requirement: 白板本地保存与导出

Desktop SHALL 以 Excalidraw 原生 JSON 在场景变化后 500ms 防抖自动保存到应用数据目录 `whiteboards/<meetingId>/<whiteboardId>.excalidraw`，同一会议再次共享白板 SHALL 沿用同一 `whiteboardId` 并恢复内容。Desktop SHALL 支持导出 PNG 与 `.excalidraw` 源文件到用户选择的位置。白板存储与导出命令 SHALL 只接受主窗口主框架的调用。

#### Scenario: 停止后再次共享白板
- **WHEN** 用户在同一会议中停止白板共享后再次共享白板
- **THEN** 白板显示停止前的内容

#### Scenario: 非法标识
- **WHEN** 存储请求中的 `meetingId` 或 `whiteboardId` 含路径分隔符、`..` 或超长
- **THEN** 主进程拒绝该请求，不读写文件

### Requirement: 白板离线资源与外部入口

白板 SHALL 从随应用打包的本地目录加载字体，运行时 SHALL NOT 访问 CDN。白板 SHALL 关闭嵌入网页、外部素材库浏览、AI 功能和外部链接打开。

#### Scenario: 断网使用
- **WHEN** 设备无网络时共享白板并输入中文
- **THEN** 中文手写字体正常显示

#### Scenario: 尝试嵌入网页
- **WHEN** 用户在白板中粘贴网页链接
- **THEN** 白板不创建嵌入网页元素
