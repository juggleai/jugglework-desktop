## Why

用户需要从 Desktop 内进入自己的个人文档或当前组织云文档，并通过已有 Word／AI 工作流与同事协作。应承载 AFFiNE 原生页面和同步，而不替换现有本地 Office 引擎或引入第二套协作协议。

## What Changes

- 首版接入云文档 IM 自定义消息、气泡、会话预览和跨组织／评论定位，原生站内通知同时保留。
- 增加 Word 共同检查点、首次关联及重开握手，原生批发送与输入延迟验收；交接时明确实例和产品／后台编辑展示模式。

- More 增加云文档，使用现有账号和明确 Personal／团队租户免重复登录。
- 增加 Electron 页面容器、受限编辑桥与账号／租户生命周期处理。
- 文件操作增加上传到云文档，区分原始附件、首次转换和真正双向编辑。
- 增加本地文件关联及 Word SDK → AFFiNE 原生操作适配 PoC，保持原有人工／AI 共享模型和保存流程。
- 固定产品交互、原生会话保活、错误恢复、平台验收和跨项目依赖。

## Capabilities

### New Capabilities

- `desktop-cloud-docs`: More、免登录、租户导航、产品交互与文件接入。
- `cloud-docs-host-bridge`: Electron 容器、受限消息、原生会话存活和身份隔离。
- `word-affine-adapter`: 本地文件关联、双向操作映射、AI 及原生保存联动。

### Modified Capabilities

- `local-office-editing`: 云文档回写必须服从原有活跃模型、选区证明和保存边界。

## Impact

- React：`shell`、`domains/cloud`、新增 `domains/cloud-docs`、文件与产物操作。
- Electron：新增云文档宿主与受限桥，复用原有 WebContentsView 布局和覆盖层模式。
- 本地 Server：文件关联与 Office 内容操作适配；不把云端 Docs 后端装入每台 Desktop。
- 依赖 [Server 身份契约](../../../../jugglework-server/openspec/changes/add-jugglework-docs-integration/api-contract.md)和 [Docs 编辑桥契约](../../../../jugglework-docs/openspec/changes/add-jugglework-docs-adaptation/editor-bridge.md)。

## Delivery boundary

云文档宿主、通知卡片、DOCX 原件 page 接入、受支持 Word 基础对象桥、共同检查点和基础文本重开恢复已落源码。完整对象集合、通用附件模式、真实多人／重开联合验收、平台及安装包验收仍未完成；文件导入或导出通过不能计为完整双向同步通过。
