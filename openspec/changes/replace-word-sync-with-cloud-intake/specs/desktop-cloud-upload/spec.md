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
