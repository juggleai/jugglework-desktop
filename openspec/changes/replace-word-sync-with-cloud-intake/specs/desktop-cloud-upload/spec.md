## ADDED Requirements

### Requirement: Upload uses the saved file
上传 SHALL 先完成现有 Office 保存，再读取已保存文件。保存失败、AI 运行中或选区待确认时 MUST NOT 上传。

#### Scenario: Word has unsaved edits
- **WHEN** 用户在有未保存修改的 Word 中点击上传云文档
- **THEN** 先保存，上传内容包含这些修改

### Requirement: Upload result stays on the current page
上传成功 SHALL 显示带“查看云文档”的提示，MUST NOT 自动跳转或改变当前 Office 页面。上传后 SHALL NOT 显示任何同步状态。

#### Scenario: Upload completes
- **WHEN** Docs commit 成功
- **THEN** 当前 Office 页面保持不变，提示中可打开新云文档

### Requirement: Duplicate upload asks the user
上传文件前 SHALL 调用 lookup；返回已有页面时 SHALL 提供“打开已有云文档”与“另存为新云文档”，选择打开已有时 MUST NOT 上传文件。

#### Scenario: User uploads the same file twice
- **WHEN** 文件摘要与已完成上传相同
- **THEN** 弹窗让用户选择，选择另存为时创建新页面

### Requirement: Unknown result is verified
响应未知 SHALL 显示“上传结果待确认”，并以同一 requestId 查询结果，MUST NOT 创建第二个页面。

#### Scenario: Network drops during commit
- **WHEN** commit 请求无响应
- **THEN** 查询 status，已完成则显示成功，否则以同一 requestId 继续

### Requirement: Uploaded files expose a copy-link action
已上传文件 SHALL 在上传图标右侧显示分享图标，工作区右侧面板与独立文件窗口 SHALL 使用相同顺序与悬浮提示。点击 SHALL 将最近一次上传结果链接复制到系统剪贴板。记录 SHALL 按来源、账号、组织和本地文件隔离，MUST NOT 建立双向同步或扩大云文档权限。

#### Scenario: User shares from a detached window
- **WHEN** 文件已上传，用户在独立文件窗口点击分享图标
- **THEN** 系统剪贴板包含对应云文档页面链接，不包含交接凭据

#### Scenario: User switches organization
- **WHEN** 用户从组织 A 切换到 B
- **THEN** 主窗口与独立窗口均不展示或复制 A 的上传结果

#### Scenario: Existing upload has no local result record
- **WHEN** 已上传文件缺少本地结果记录
- **THEN** 以当前文件摘要查询已有上传，只有完全匹配时才恢复分享入口，不按文件名推断
