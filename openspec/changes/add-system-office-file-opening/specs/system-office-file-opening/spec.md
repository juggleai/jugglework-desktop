## ADDED Requirements

### Requirement: 系统 Office 候选应用
安装包 SHALL 将 JuggleWork 注册为 DOCX、XLSX、CSV、PPTX 的候选打开应用，且 SHALL NOT 主动修改用户默认应用。

#### Scenario: 从系统选择 JuggleWork
- **WHEN** 用户通过“打开方式”选择 JuggleWork 打开受支持文件
- **THEN** 文件在现有“JuggleWork 文件浏览器”独立 Office 窗口中打开

### Requirement: 本机文件上下文
系统入口 SHALL 只登记明确选择的文件，使用原路径编辑保存，且 SHALL NOT 自动创建聊天或将父目录加入工作区。

#### Scenario: 工作区外的文件
- **WHEN** 用户打开任意本机目录中的受支持文件
- **THEN** 文件可使用已有 Office 编辑器保存，父目录中的其他文件不因此获得访问入口

#### Scenario: 重复打开
- **WHEN** 同一文件通过原路径、符号链接或硬链接再次打开且已有存活模型
- **THEN** 系统复用已有模型及标签，禁止建立第二个写模型

### Requirement: 启动与文件窗口名称
系统 SHALL 在运行时就绪后按顺序处理冷启动及第二实例文件请求，单个失败 SHALL NOT 丢失后续请求。

#### Scenario: 多文件冷启动
- **WHEN** 应用尚未运行且收到多个文件打开请求
- **THEN** 就绪后在文件浏览器中打开相应标签，不强制激活聊天窗口

#### Scenario: macOS 活动独立窗口
- **WHEN** Office 独立窗口获得焦点
- **THEN** macOS 应用菜单显示“JuggleWork 文件浏览器”，切回 Desktop 聊天主窗口恢复主应用显示名

#### Scenario: 文件浏览器空白主页
- **WHEN** 独立窗口的全部文档 tab 已关闭，显示打开文件或新建 Word 文档的主页
- **THEN** 保留同一个文件浏览器窗口，窗口标题和 macOS 应用菜单仍显示“JuggleWork 文件浏览器”，再次打开文件复用该窗口
