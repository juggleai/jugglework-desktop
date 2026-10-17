# 设计

系统候选应用名为 JuggleWork。JuggleWork 文件浏览器就是现有 Office 独立窗口，与右侧共用编辑器、保存及退出检查，不另建编辑应用。

macOS 在 ready 前接收 open-file；Windows 从 argv 和 second-instance 提取受支持的文件路径。请求顺序排队，运行时准备后处理，单个失败不丢弃后续文件。外部打开不强制激活聊天窗口。

Server 保存进程内本机文件上下文。只有主进程持有的 host token 可以登记明确选择的绝对文件；客户端仅通过登记后的文件标识读取、编辑与保存。此上下文不进入工作区列表、聊天、Agent 工具发现或父目录文件操作。已有真实路径或硬链接对应的存活模型优先沿用；其他聊天不得再建立相同文件的写模型。

外部文件仍由 OfficeDocuments 管理，复用原路径保存、自动保存、崩溃恢复与退出检查。独立窗口使用多标签；最近文件持久化原路径，下次重新登记，不持久化令牌或运行期标识。

macOS 仅切换活动窗口的应用菜单显示名。文件浏览器关闭全部 tab 后的空白主页仍保留文件窗口归属与显示名。Desktop 聊天主窗口恢复既有品牌名，稳定 appId、userData 和品牌设置保持原有归属。Dock 轻量入口不注册文件关联。

macOS 通过 electron-builder fileAssociations 声明四种格式，使用 Alternate 候选级别。Windows 安装器仅注册 OpenWithProgids 与 JuggleWork 专属 ProgID，卸载前核对命令所属安装路径，不改写扩展名默认值或 UserChoice；避免使用会覆盖扩展名默认 ProgID 的通用关联宏。
