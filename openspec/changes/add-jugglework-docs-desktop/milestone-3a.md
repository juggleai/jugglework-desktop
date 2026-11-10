# M3-A：单普通段落实验适配

状态：源码组件和真实往返验证已完成，**未开放产品入口，不代表完整 Word 双向交付**。范围为一个从 DOC 坐标 0 开始、最多 4096 UTF-16 的普通纯文本段落；只验证顺序插入／删除。完整 [Word 适配矩阵](word-adapter.md)及 W-01～W-16 要求保留。

## 源码模块

| 位置 | 当前能力 |
| --- | --- |
| `apps/desktop/electron/office-word-paragraph-adapter.mjs` | 固定 SDK 的人工／AI 增量捕获，word／ai／cloud 来源区分，独立范围定点回写；模型、原文、未提交输入、范围或格式不匹配时停止 |
| Docs `packages/frontend/core/src/utils/jugglework-word-paragraph-probe.ts` | 真实 Store.transact、Text.insert/delete，监听原生 Y.Text；保留原生 nbstore、Socket.IO、历史及持久化 |
| `scripts/verify-word-affine-paragraph.mjs` | 独占测试浏览器、临时 Word 文件、两个真实源用户的往返及保存重开验证 |

组件不新增正文数据库、离线日志或同步传输。正式 IPC、持久绑定和 editor.attach／apply 基础消息已由正式组合桥实现；共同检查点仍未实现。单段实验函数不作为独立产品入口。

## 固定 SDK 接口事实

资源为 editor_sdk `0.0.0.499`、wrapper `0.2.196-office.1`，macOS ARM64 原生 SHA-256 `4108b17c870cc3d5b6aa6b42f7030c3a59be992d52b4fa4c7e1eb5d55a836201`。

| 接口 | 已确认边界 |
| --- | --- |
| `App.changesetManager.addCommand` | 人工命令需经原生 toJSON 转为 mutation wrapper；structuredClone 丢失该转换 |
| `applyChunkToBase` | AI 回传以 `deltaOpt.undoOption.fromLocalAiEdit` 区分；初始载入／重同步不视为新增正文 |
| `doc_resolve_document_structure` 的 paragraph_id | 本次样例保存、关闭、重开后相同；拆分、合并和复杂文档的稳定性未验证 |
| `getDocument().getRange(begin,end,{updateSelection:false}).setText` | 独立范围进入同一活跃模型，不改真实选区，不替换磁盘内容 |

以上为固定版本的私有页面接口，不是供应商公开稳定的 onChange 契约。正式接入仍需资源版本／摘要、页面代次及宿主权限约束，不能只因同名方法存在便支持新 SDK。手工输入原生 compose 窗口为 500ms，观察器不修改该机制；尚未进行端到端延迟验收。

## 已验证与限制

真实 SDK、当前 AFFiNE 源码服务、两个不同源用户的原生客户端已通过：中文／emoji 人工插入和 AI MCP 插入到达两端；另一成员原生编辑定点回到同一 Word 模型；cloud 来源不回送；Word 原路径保存重开、段落 ID 及原生 block ID 保持，云页面刷新仍有内容。

AI 部分只证明现有 AI 底层 MCP 工具路径，尚未证明完整聊天 admission、选区证明和交付生命周期。验证器直接运行源码函数驱动独占浏览器，不表示正式 Desk IPC 已完成。

8 项回归保护来源恢复及释放、SDK toJSON、AI／载入区分、未提交输入 busy、批内无效范围零写入、UTF-16 surrogate 边界、格式／模型分叉暂停、写后缺确认 unknown 禁止重放。合成 composition 事件只验证状态保护，不能代替真实 IME 验收。

结果见 [evidence/m3a.json](evidence/m3a.json)。本阶段以当前原文核验及段内位置验证顺序操作；**并发稳定相对位置映射尚未通过**。分叉时保留双方并暂停，不新增冲突合并算法。

真实补测中，回写后的后续人工输入命令可携带 `run.i={}` 等格式字段，当前适配按不支持格式暂停；不能静默忽略该字段，亦不表示已证明开启斜体。该字段语义与完整样式映射尚未验收，不能将单次往返结果扩展为任意连续输入可持续同步。

M3-A 单段组件保持上述严格边界。[M3-B](milestone-3b.md) 的独立多段组件已改用实时 Font 有效值，并验证基础 marks 回写后的后续人工输入；这不扩大本单段组件或完整格式支持范围。

## 复测

回归：`node --test apps/desktop/electron/office-word-paragraph-adapter.test.mjs`。

真实往返要求独占 Word／Docs CDP 浏览器、已打开的临时单段纯文本 DOCX，以及可丢弃组织中的 Owner 和另一成员。脚本会创建有明确测试标题的云文档、修改并保存临时 Word。设置以下变量后运行 `node scripts/verify-word-affine-paragraph.mjs`：

- `JW_TEST_PLAYWRIGHT_MODULE`：已安装 Playwright 模块路径，不自动下载依赖。
- `JW_TEST_DOCS_REPO`：AFFiNE 源码目录，含构建工具和本轮原生适配模块。
- `JW_TEST_SOURCE_URL`：本机 Go `/jwork` 根地址。
- `JW_TEST_WORD_CDP`、`JW_TEST_DOCS_CDP`：独占本机测试端点，不能使用用户正在编辑的窗口。
- `JW_TEST_WORD_PATH`：系统临时目录内已打开的 DOCX 绝对路径。
- `JW_TEST_TENANT_ID`、`JW_TEST_PEER_ACCOUNT`、`JW_TEST_PEER_PASSWORD`：可丢弃组织及另一成员。
- `JW_TEST_MUTATION_CONFIRM=disposable-word-and-docs`；可选 `JW_TEST_REPORT_PATH` 保存不含登录令牌的结果。

Docs 模块沿用 tsconfig.web、仅载入新文件做类型检查通过。本轮没有重新打包生产编辑器入口。

## 剩余门槛

正式宿主桥已支持固定多段、标题／单级列表、加粗／斜体及普通段落拆并；共同检查点和基础文本重开恢复源码已完成。表格、图片、链接、评论锚点、完整并发矩阵、完整 Yjs 相对位置、真实 IME、AI admission 和完整离线／崩溃恢复仍未完成，不能宣称无损完整 Word 双向。
