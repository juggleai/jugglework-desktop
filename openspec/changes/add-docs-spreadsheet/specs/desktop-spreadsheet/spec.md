## ADDED Requirements

### Requirement: Open cloud spreadsheets in existing surfaces
Desktop SHALL 使用当前 Docs origin，在全页云文档、统一文件 tab 和独立 File Browser 打开类型化云表格，不新增原生引擎、独立地址或第二条云文档 tab 栏。

#### Scenario: Switch back to an open spreadsheet tab
- **WHEN** 用户在本地文件和已就绪云表格间切换
- **THEN** 复用该表格实例及编辑状态，不重新交接/重载

### Requirement: Upload an independent saved file
上传 SHALL 先完成本地 Office 保存，通过现有 intake 创建独立云端表格；成功 MUST NOT 强制跳转或建立双向同步。分享 SHALL 复制当前身份范围的已完成结果链接。

#### Scenario: Upload from a detached file window
- **WHEN** 未保存 XLSX 在独立窗口点击上传
- **THEN** 先保存再上传，完成保留当前文件，分享图标复制云表格链接；之后本地/云端编辑互不覆盖

### Requirement: Confirm the current spreadsheet before leaving
Desktop SHALL 在关闭/退出/切租户/回收前完成当前单元格/IME提交并等待该实例最后 opId 的数据库确认；失败 SHALL 保留视图和草稿，不以其他实例/本地保存或原生文档确认放行。

#### Scenario: Spreadsheet save times out
- **WHEN** 当前表格最后修改30秒内未确认
- **THEN** 取消自动离开并提供重试，不能静默销毁；其他协作者继续编辑不影响自己的确认边界

### Requirement: Use typed exports and capabilities
导出 SHALL 按服务端能力提供 XLSX/CSV/PDF，使用既有下载流程。未支持的表格 AI SHALL 拒绝，不能改同名本地文件或空锚点。

#### Scenario: Export PDF
- **WHEN** 用户在三个点导出菜单选择 PDF
- **THEN** 保存屏障后下载 Docs 基于已确认版本生成的 PDF。用户可选择当前工作表或整个工作簿

### Requirement: Isolate identity and preserve product settings
视图/草稿/上传结果 SHALL 按 source/account/tenant/file 隔离，表格 SHALL 遵循 Desk 的语言/主题和既有布局/浮层行为。原生文档、IM、本地 Office MUST NOT 依赖表格可用性。

#### Scenario: Change to a personal account
- **WHEN** 组织表格已完成保存且用户切到 Personal
- **THEN** 旧连接退出，个人页面不显示或复用旧组织正文、草稿、分享结果或可写上下文
