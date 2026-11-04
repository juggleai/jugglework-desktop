# 系统文件打开入口

## Why

本机 Office 文件需要从系统“打开方式”直接进入已有独立编辑窗口，独立窗口激活时 macOS 菜单栏应显示“JuggleWork 文件浏览器”。

## What Changes

- 安装包声明 DOCX、XLSX、CSV、PPTX 的候选打开应用，不替用户修改默认应用。
- macOS open-file、Windows 启动参数及第二实例统一进入现有文件窗口，重复打开复用模型与标签。
- 所选外部文件使用独立、仅限明确文件的本机上下文，原路径保存，不创建聊天或注册父目录工作区。
- macOS 菜单栏随独立窗口和主窗口切换名称，保留应用稳定标识、品牌配置及数据目录。

## Capabilities

### New Capabilities
- `system-office-file-opening`: 系统关联、启动请求、外部文件上下文及活动窗口名称。

### Modified Capabilities
无。

## Impact

Electron 启动与菜单、安装包关联、文件窗口、Server Office 文件解析。仍使用随安装包分发的本地 SDK；Windows 和 macOS Intel 的原生编辑及签名安装验收沿用现有限制。
