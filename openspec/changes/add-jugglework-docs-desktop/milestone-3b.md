# M3-B：固定多段落与基础字符样式实验

源码和真实双客户端往返验证完成，固定多段、标题／单级列表、加粗和斜体已接入正式受限桥。该支持集合不等于完整 Word 双向，不替代 W-01～W-16。

## 源码与依赖

| 模块 | 文件与职责 |
| --- | --- |
| Desk Office 适配 | `apps/desktop/electron/office-word-blocks-adapter.mjs`：实时读取 SDK 段落 ID、当前位置、种类及有效字体值，捕获人工／AI 命令，向当前模型定点回写 |
| AFFiNE 适配 | Docs `packages/frontend/core/src/utils/jugglework-word-blocks-probe.ts`：绑定现有 block，调用 Store.transact、Text.insert/delete/format，观察原生 Y.Text |
| 真实验收 | `scripts/verify-word-affine-blocks.mjs`：临时 Word、可丢弃组织、两个真实源用户及原生客户端 |

正文继续使用 AFFiNE 的 nbstore／Socket.IO 和持久化。Go 只承担已有 launch、源身份、组织及成员授权；没有新增正文服务、数据库、同步协议、检查点或离线队列。

## 已实现范围

- 固定的 1～128 个段落，每段最多 4096 UTF-16；每次最多 256 个文本操作。按 SDK 活跃对象的 `getParaId()` 关联原生 block ID，前段插删后重新读取当前位置，不沿用历史绝对偏移。
- 普通文本、h1～h6、单级有序／无序列表的既有种类保持；真实样例覆盖 text、h1、h2、numbered、bulleted 五种，并逐种修改文本。h3～h6 尚无真实样例验收。
- 人工／AI 文本插删、加粗／斜体设置和清除，通过原生 Text.format 和 SDK 范围 Font API 双向适配。样式以 `isBold()/isItalic()` 有效布尔值为准，`run.i={}` 不能当作开启斜体。
- 标题人工输入、AI 列表输入可附带默认字号／颜色／字体命令；只在紧随同范围插入的附属命令中识别这些字段。字体、字号、颜色不作为本实验的云端 marks，不承诺版式保真；独立修改这些格式仍暂停。
- cloud 来源只抑制本次回写的回送，后续人工输入继续发送。批内所有对象和范围先校验；冲突在写入前拒绝。IME 组合态／原生未提交时返回 busy；写后未确认返回 unknown，暂停且不重放。

段落 ID、数量、种类或模型改变，不支持格式、只读、原文分叉均停止适配。拆分／合并、新增／删除段落、标题级别切换、列表种类／层级改变、链接、表格和图片不在本实验支持集合内。初始样例为受控内容；该读取器不是任意 Word 文件的格式兼容性检测器。

## 真实验收结果

固定 SDK 为 editor_sdk `0.0.0.499`、wrapper `0.2.196-office.1`、macOS ARM64；摘要及结果见 [evidence/m3b.json](evidence/m3b.json)。接口为固定版本私有页面接口，不能因同名方法存在便支持新版本。

5 段样例通过：标题人工中文／emoji 插入与删除；AI 分别修改正文、标题和两种列表；两位源成员在同一 AFFiNE 文档看到修改；另一成员在同一原生事务修改标题与正文并设置／清除 marks，批量回写当前 Word；随后人工输入继续传播且不回环。Word 保存关闭重开、两个云页面重载后，文本、类型、marks 和对象 ID 均一致。

8 项新回归保护多段位置移动、有效样式值、批内冲突零写入、surrogate 边界、结构失效、busy、插入附属默认格式和 unknown 不重放；M3-A 的 8 项回归保持通过。Docs 新模块沿用 tsconfig.web 做独立类型检查。合成 composition 仅验证保护分支，不代表真实 IME 验收。

## 复测及剩余门槛

回归：`node --test apps/desktop/electron/office-word-blocks-adapter.test.mjs apps/desktop/electron/office-word-paragraph-adapter.test.mjs`。

真实验收使用 [M3-A 复测](milestone-3a.md#复测)相同环境变量与独占浏览器约束，运行 `node scripts/verify-word-affine-blocks.mjs`。Word 必须为系统临时目录内已打开、含上述五种段落的可丢弃 DOCX。脚本创建自己的云测试页并修改／保存该临时文件；不连接用户正在编辑的窗口。

普通无格式段落拆并、正式宿主绑定、DOCX 原件 page 接入、共同检查点和基础文本重开恢复源码已实现。相对位置完整矩阵、结构并发、完整对象集合、真实 IME／AI admission 和完整离线／崩溃恢复仍未完成；分叉时暂停，不新增合并算法。
