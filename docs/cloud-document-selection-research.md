# JuggleWork 云文档能力选型调研

按功能、协作及现有组织／IM 集成优先的选型，见 [对标飞书文档的项目适配评估](cloud-document-feishu-fit-evaluation.md)。本文保留免费商用与许可维度的分析。

资料核对日期：2026-11-03。项目基线：`dev`，`0597a5916`。范围：可自行开发、私有部署、接入 JuggleWork Desktop 的云文档；重点比较免费商用、开源许可、集成成本和现有 Office 复用。

默认以云端保存、分享及本地 Office 复用为第一阶段目标。是否必须完全免费、仅采用宽松许可、保持闭源、向外部客户提供服务，以及首版实时共编，均属于尚待确定的业务条件；以下分别给出对应选择。

## 结论

**以“复用现有 Office”为首要目标，建议首先建设轻量云文件服务，继续使用当前本地 Office 编辑器。** 新增云端文件目录、版本、上传下载、分享和桌面端打开回存，即可形成第一阶段能力；现有 Office 原生内核的商业分发授权仍需单独核实。这是基于当前代码的工程建议，并非已实现的功能。

**如果“云文档”还包含飞书／Notion 式网页文档和多人实时共编，建议作为第二种文档类型建设。** 面向可长期自主开发的商业产品，优先验证 `Tiptap 开源核心 + Yjs + Hocuspocus 开源服务`：这三个项目的相应开源核心为 MIT，但目录、权限、评论、历史和分享需要自行实现；付费扩展和托管产品不包含在该许可结论内。[29][30][31][32]

截图中的五款产品均有价值，但不能仅凭功能勾选就认定可免费完成 JuggleWork 集成。若进一步要求“整套纯宽松开源、团队长期免费、对外商业嵌入、Office 三件套编辑、低成本复用当前 AI 编辑”，本次没有找到能直接确认全部满足的产品；这组更严格条件用于比较，不作为已确认需求：

- **Docmost**：优先考虑为独立团队知识库；Bases、SSO、正式 API 和 MCP 等涉及付费功能。[1][2][3][4][5]
- **Outline**：适合内部知识库；BSL 明确限制对外提供 Document Service，不能直接作为面向客户的免费文档服务底座。[7]
- **AFFiNE**：适合文档与白板工作空间；有 MIT 文件、EE 范围以及 CE／客户端 MPL-2.0 例外。厂商另提供 OEM／嵌入商业授权路线，具体组件组合需分别判断。[9][10][11]
- **AppFlowy**：当前官方生产自托管服务采用商业许可，且现有条款不允许 custom client，和 JuggleWork 深度集成方向冲突最直接。[13][14]
- **La Suite Docs**：值得验证为协作文字文档应用，但主项目 MIT 不代表完整运行栈都是 MIT；当前 y/hub 与 BlockNote XL 依赖必须一起评估。[16][19][20][21]

若明确要求 **Word、Excel、PPT 在浏览器中实时共编**，应另外验证 ONLYOFFICE Docs 或 Collabora Online；文件上传回存以及块文档协作都不能替代这项能力。[22][28]

## 现有项目能够复用什么

以下为本地代码和设计文档中的已确认事实。

| 项目 | 当前事实 | 对云文档集成的含义 |
| --- | --- | --- |
| 引擎 | `office-docs-ai-engine 0.2.196-office.1` 包装层与 `editor_sdk 0.0.0.499` 原生内核 | 已有本地编辑能力；不能据此推定存在服务端实时协作能力 |
| 文件格式 | `docx`、`csv`、`xlsx`、`pptx` 走统一 Office 宿主 | 云端可以保留原文件，下载工作副本后复用原编辑路径 |
| 宿主 | Electron `WebContentsView` 承载原生编辑页，React 展示状态和操作 | 文件标签页、独立窗口和操作入口可复用；远程编辑页需要独立接入 |
| 生命周期 | 本地 Server 管理模型、保存、关闭、外部应用交接；已有自动保存与交付前保存 | 上传必须发生在实际保存成功后，沿用现有保存服务 |
| 身份 | `OfficeDocumentSession` 绑定工作区、相对路径、聊天和引擎文件 ID | 云端需要另建稳定文件 ID 与版本映射，不宜把远端 URL 塞进本地路径字段 |
| AI | 现有 Office MCP 和选区机制围绕当前 SDK 模型及坐标 | 可继续用于本地工作副本；换成第三方网页编辑器时需要重新适配 |
| 云入口 | 设计文档将云端分享、上传列为后续项；已有“分享暂未开放”文案 | 可以延续现有产物卡片和菜单，补上真实服务 |
| 许可证据 | wrapper 的 `package.json` 声明 MIT；资源说明仍列有 SDK 正式分发范围待验收 | 该 MIT 声明不足以证明原生内核可免费商业分发或改为云服务 |

代码依据：

- [Office 编辑设计](office-document-editing-design.md)
- [Office 资源说明](../apps/desktop/resources/office-engine/README.md)
- [引擎适配器](../apps/server/src/office/engine.ts)
- [保存与文档生命周期](../apps/server/src/office/documents.ts)
- [Office 会话类型](../packages/types/src/office.ts)
- [Electron 编辑宿主](../apps/desktop/electron/office-panel.mjs)
- [Office 包装层元数据](../apps/desktop/resources/office-engine/wrapper/package.json)

这些证据说明可复用本地编辑流程；没有证明当前 SDK 已具备跨用户、跨设备的实时 Office 共编协议。

## 区分三种目标能力

| 能力 | 内容的权威形态 | 用户体验 | 主要技术工作 |
| --- | --- | --- | --- |
| 云 Office 文件 | DOCX／XLSX／PPTX 等文件及其版本 | 云端列目录，桌面打开、编辑、保存回云端、分享 | 文件服务、工作副本映射、版本与分享 |
| 协作块文档／知识库 | 块结构、编辑器模型或协作状态 | 网页编辑、多人光标、页面层级、评论 | 编辑器、协作服务、目录、权限、搜索 |
| 实时协作 Office | 同一在线 Office 编辑会话与持久文件 | 多人同时编辑 Word／Excel／PPT | 专用在线 Office 服务及其保存协议 |

**导入 DOCX 后变成块文档，不等于无损编辑原始 Word；支持表格块／多维数据库，也不等于支持 Excel；支持演示模式，也不等于支持 PPTX 保真编辑。** 这是本报告的工程判断。实际保真程度必须由客户文件往返验收决定。

## 截图五款产品对比

表中“可商用”区分内部运行、修改分发和对外服务，不作无条件授权承诺。

| 产品 | 许可与免费边界 | 私有部署和接入 | 现有 Office 复用 | 建议 |
| --- | --- | --- | --- | --- |
| Docmost | 核心 AGPL-3.0；企业目录另行许可。Bases 属于商业功能；SSO、API、MCP 等也在付费范围 | 官方推荐 Docker，含 PostgreSQL、Redis；独立网页接入较直接，统一身份及 AI 集成要考虑付费边界 | 可做知识库与附件入口，不能直接复用现有 Office 实时模型 | 独立知识库候选；免费深度集成不优先 [1][2][3][4][5][6] |
| Outline | BSL-1.1，当前版本尚非开源许可；允许范围内的内部使用，对外 Document Service 受限 | 有 OIDC 配置文档；具体认证能力需按所选版本核实 | 知识页与 Office 文件之间需要独立桥接 | 内部知识库可考虑；对外文档产品排除免费底座方案 [7][8] |
| AFFiNE | 顶层划分 MIT 文件与 backend／部分 native 的单独许可；后者含 CE／客户端 MPL-2.0 例外。免费席位有边界，厂商提供 OEM Code License 路线 | 官方 Docker Compose；有 OIDC，自托管团队许可与离线许可需区分 | 文档、白板和数据库使用自身模型，与现有 Office 分离 | 重视白板时考虑；按具体组件及交付方式确认权利 [9][10][11][12] |
| AppFlowy | 开源客户端与旧云端代码不能代表当前生产服务；当前自托管 Free 为 1 用户席位与最多 3 页面访客编辑者 | 官方生产部署运行商业服务；许可按服务器且限制 custom client | 现有 Office MCP 不可直接接入其页面模型 | 不作为免费商用集成首选 [13][14][15] |
| La Suite Docs | 主项目 MIT；BlockNote 主体 MPL-2.0、XL 为 GPL-3.0；当前协作服务依赖 y/hub，AGPL／商业双许可 | Django／React 系，含协作及转换服务；有 OIDC resource server API；完整部署不是单编辑器组件 | 可导入导出文字文档，但不提供已证实的 Office 三格式原模型复用 | 五款中值得做协作文字文档 PoC；须接受／解决依赖许可边界 [16][17][18][19][20][21] |

### Docmost：知识库功能完整，但免费集成缺口明显

官方明确：Bases 需要有效的 Business 或 Enterprise 许可，不在免费开源版内。正式 REST API、SSO、MCP、DOCX／PDF 导入、页级细粒度权限等也在付费能力清单中。不能把前端自身能够调用的内部接口，等同于免费版对外提供的稳定集成 API。[2][4][5]

Business 标价为每席位每月 6 美元、按年计费、最低 10 席；这是自托管套餐标价，不代表允许将其重新包装销售为 JuggleWork 文档服务，后者需要明确授权范围。[3]

**判断：** 如果目标是尽快提供一个团队知识库入口，Docmost 值得试用；如果要求免费完成账号打通、Agent 读写和多维表格，需支付套餐费用或自行实现相应开源范围内的能力，集成成本会明显增加。

### Outline：关键问题是业务许可边界

当前 `LICENSE` 对 Document Service 的定义，涉及让员工与承包商之外的第三方创建并控制团队和文档的商业服务。它还明确说明 BSL 当前不是开源许可，每个版本有自己的转换日期。不能因为未来会转 Apache，就把当前版本按 Apache 使用。[7]

**判断：** 公司内部自建知识库可以继续评估；将 Outline 包装为 JuggleWork 面向客户的云文档能力，应先取得覆盖该业务的商业许可。即使只嵌入未修改的网页，也不能据此消除业务用途限制。

### AFFiNE：区分编辑器源码与完整云服务

仓库顶层许可对 backend 和部分 native 目录作了单独划分；服务端许可又明确 CE／客户端部分适用 MPL-2.0，其余相应内容适用 EE 条件；其他顶层允许范围为 MIT。必须逐组件识别。官方企业说明把 OEM、白标与嵌入列为 Code License 路线，这是厂商提供的商业授权路径，不能据此推导所有依照 MIT／MPL 使用的组件都必须购买该授权。[9][10][11]

官方目前说明自托管免费至每工作区 10 席；扩容涉及 Team 或 Installable License，后者用于无法连接在线许可服务的网络环境。免费运行标准镜像的范围，不等于免费修改及再分发整套后端。[11][12]

**判断：** 如果愿意采购，文档与白板结合具有吸引力；如果希望持续免费、自由二开并嵌入商业产品，完整 AFFiNE 服务不应作为默认选择。单独使用其许可允许的编辑器代码，需要自行补齐云端产品能力。

### AppFlowy：当前生产自托管与历史开源路线已分化

官方当前部署仓库说明，生产服务由商业 AppFlowy Cloud 代码库支持。自托管协议授予内部业务使用，限制修改、分发、转售，并明确不允许 custom client。旧 AppFlowy-Cloud 仓库仍能看到开源许可，但页面显示已归档。[13][14][15]

**判断：** 当前生产自托管并不等于可免费移植到 JuggleWork。改用旧开源栈意味着自己承担维护和客户端兼容成本；该路线的安全更新和升级可持续性本次未验证，不推荐仅为规避许可费而采用。

### La Suite Docs：接近协作文字文档需求，完整栈需要重新界定

主项目支持层级文档、共享和实时编辑；文字文档导入导出不构成 Excel 或 PPT 编辑能力证明。`PUBLISH_AS_MIT=true` 用于移除部分非 MIT 功能，但官方同时说明 BlockNote XL 的 GPL 边界；该构建开关不能据此被理解为自动更换所有第三方依赖的许可证。[16][21]

当前 `src/yhub-server/package.json` 引入 `@y/hub`。y/hub 官方仓库明确为 AGPL／商业双许可，所以即使主应用 MIT，协作后端也需要独立满足相应条件。[19][20]

官方安装文档区分前端、Django 后端、yhub 协作服务、转换服务；维护者实际生产使用 Kubernetes，Compose 提供部署入口但不是他们的生产运行方式。外部 API 文档也提示接口可能演进，且默认开放动作有限。[17][18]

**判断：** 如果接受维护一个独立协作应用，并能满足依赖许可，它是五款中值得验证的候选；如果硬性要求整套纯 MIT、少服务、可直接复用 Office AI，不能直接选定。替换协作后端可能可行，但协议、历史、离线同步与回滚等都需重新验证，不是改一个 URL。

## 其他方案

| 路线 | 许可与费用 | 优点 | 代价与适用条件 |
| --- | --- | --- | --- |
| 自建轻量云文件服务＋现有 Office | 自研服务可自主选择许可；对象存储、数据库及当前 SDK 各按实际许可 | 复用现有编辑、文件卡片、AI 和本地离线流程；范围可控 | 需要开发目录、版本、分享和回存；首版不提供实时共编；原生内核授权未确认 |
| Tiptap 核心＋Yjs＋Hocuspocus OSS | 相应核心 MIT；高级扩展、现成协作商业产品需另查 | 技术栈贴合现有 React／TypeScript；可做自己的块文档 | 评论、历史、分享、全文搜索、权限和管理仍需开发；不解决 Office 保真 [29][30][31][32] |
| ONLYOFFICE Docs | Community 为 AGPL 系；闭源产品集成按官方 FAQ 应考虑商业授权 | 专门处理在线 Office，提供打开、共编、保存接口 | 自建文件存储及管理；AI 工具和选区机制重适配；版本与 OEM 权利需明确 [22][23][24][25] |
| Collabora Online／CODE | 在线项目源码 MPL-2.0；官方支持的稳定产品为订阅，CODE 为免费开发版 | WOPI 集成，适合在线 Office；源码许可与闭源宿主可组合的空间较大 | WOPI 宿主、格式兼容和服务运维工作；CODE 官方不推荐生产 [26][27][28] |
| Nextcloud＋现有 Office | Server 为 AGPL；其他应用／插件另算 | 已有文件平台，官方 WebDAV 可做列目录、下载和上传 | 引入另一套文件、账号和运维体系；网页 Office 共编仍需独立编辑服务 [33][34] |

### ONLYOFFICE 的最新限制需要纠正

官方 2026 年 5 月的 9.4 发布说明明确：**从 9.4 起，开源 Community 取消 20 个同时连接的限制。** 当前部分对比页仍有“建议最多 20 用户”的表述，建议规模和硬限制不是同一个概念。不能用旧版本的 20 连接上限直接否决新版本。[24]

这也不代表社区版自动适用于所有商业嵌入场景。官方 FAQ 对闭源集成、衍生作品和商业许可给出了明确的厂商立场；代码许可中还有额外声明及商标相关条款。具体上线应锁定镜像版本，核对对应源码、声明及集成方式。报告不把“用了 HTTP 接口”当成确定免除许可义务的依据。[23][25]

技术上，ONLYOFFICE 负责编辑服务；文档列表和存储服务仍由集成方提供。它也不会自动兼容现有 Office MCP 和原生选区坐标。[22]

### Collabora 的生产建议与使用许可应分开

Collabora 在线项目源码为 MPL-2.0。Mozilla 说明 MPL 采用文件级 copyleft，可以与专有代码组合；修改并向组织外分发受覆盖代码时，需履行相应源码义务。不能简单描述成“商用必须整个产品开源”。[26][36]

CODE 官方定位是测试、家庭或小团队，明确不推荐生产；这是一项稳定性与支持方面的选型限制，不能直接改写成“法律上禁止商业使用”。需要稳定更新和支持时，应评估其正式订阅。[27][28]

**判断：** 对“在线 Office＋尽量保留闭源宿主”的需求，Collabora 值得与 ONLYOFFICE 商业版同时验证。最终由格式保真、AI 可操作性、资源消耗和交付支持决定，不仅由许可证名称决定。

## 推荐的 JuggleWork 接入边界

以下均为建议设计，尚未实现。

### 第一阶段：云文件与本地 Office 闭环

```mermaid
flowchart LR
    List[云端文件列表] --> Bridge[桌面文件适配]
    Bridge --> Copy[本地工作副本]
    Copy <--> Office[现有 Office 编辑与 AI]
    Office --> Saved[现有 Server 保存成功]
    Saved --> Upload[提交文件版本]
    Upload --> Cloud[自部署云文件服务]
    Cloud --> Storage[元数据与对象存储]
    Cloud --> Share[分享查看或下载页]
```

- 云端保存文件 ID、名称、目录、当前版本、归属及分享信息；文件内容使用部署方自有对象存储或文件存储。对象存储产品另按实际许可选型，不在本次假定某一实现免费可再分发。
- 桌面端保存“云文件 ID＋已下载版本＋本地工作副本”映射；现有 `OfficeDocumentSession` 继续管理本地编辑，不把远端 URL 当作本地文件路径。
- 用户上传／分享前，调用现有保存服务；只有成功保存的字节才能作为新云版本。UI 区分“已保存到本机”和“已同步到云端”。
- 首版按串行编辑设计，不额外引入分布式锁或自研协作协议。如果提交时云版本已经变化，保留本地副本并提示另存新版本，不静默覆盖他人文件。这只是文件回存的必要保护。
- 先提供明确的版本快照分享；如需“链接始终查看最新版”，再显式提供该模式。文件卡片与分享页应说明查看的是哪个版本。
- 浏览器中的分享体验先明确为下载或可生成的只读预览；没有在线编辑服务时，不承诺浏览器内编辑。
- 客户端继续使用现有账号和文件访问约束；内部服务调用沿用项目现有可信网络约定，不新增一套内部鉴权体系。

**第一阶段的交付结果：** 文件从云端打开，用户和 AI 在现有 Office 中编辑，保存后回存云端，可获得真实分享链接。它满足云文件能力，仍不等同于多人实时共编。

### 第二阶段：按需增加协作块文档

仅在产品明确需要实时共编、网页文档和页面知识库时开启：

- 采用 Tiptap 开源核心构建文字文档，按需使用 Yjs 与 Hocuspocus 开源协作服务；三者核心许可依据见前文。[29][30][31][32]
- Office 文件与块文档是两种资源。共用目录、账号和分享入口，但分别使用各自的编辑模型和保存协议。
- 第一版块文档可从标题、段落、列表、链接、图片、普通表格和页面层级开始。多维表格、复杂流程审批及白板应作为独立需求评估。
- Agent 通过服务接口或同一协作模型修改块文档；仍有协作者在线时，不能靠导出 DOCX、整文件覆盖上传来模拟实时协作。
- Office 选区、撤销和 AI 修改沿用现有 SDK；块文档的 block ID、协作事务和选区单独适配，不假定坐标通用。

该路线的优势是长期可控；缺点是产品开发量高于嵌入现成知识库。MIT 核心并不赠送完整的评论、历史和企业管理功能。

### 如果必须首版就支持在线 Office 共编

直接对 ONLYOFFICE 和 Collabora 做同一组样本 PoC：复用 JuggleWork 的文件列表和窗口入口，新增在线编辑入口与服务端保存适配。云端编辑时以在线引擎为权威，当前本地 Office 保留为本地文件模式；不要让两个互不理解的引擎同时覆盖同一文件。

ONLYOFFICE 通过其 Docs API／回调集成，Collabora 通过 WOPI 集成；两者都需要明确的存储宿主。[22][28] 不将本地 SDK 直接部署到服务器，除非供应方已证明并授权该运行方式。

## 商业使用与成本判断

AGPL 允许商业使用和收费；核心问题是修改、网络交互、分发及衍生作品所对应的义务。不能概括成“AGPL 禁止商用”，也不能保证“服务独立部署就永远不影响其他代码”。具体组合边界应按实际交付方式判断。[35]

| 业务前提 | 优先考虑 | 主要成本 |
| --- | --- | --- |
| 复用现有 Office，先做云端保存与分享 | 自建轻量云文件服务 | 云服务开发、存储流量、备份、当前 SDK 授权 |
| 只给公司内部用的团队知识库 | Docmost；Outline 在允许用途内 | 服务运维；SSO、API 等商业功能费用 |
| 面向客户、长期自研、希望减少许可限制 | 云文件服务＋MIT 开源编辑组件 | 自研产品能力及持续维护 |
| 接受对应 AGPL／GPL 义务，需要较快落地协作文字页 | La Suite Docs；Docmost 核心能力范围 | 依赖许可、二次开发、升级和独立应用运维 |
| 必须网页端 Office 三格式实时共编 | ONLYOFFICE／Collabora 专项验证 | 编辑服务、格式验收、AI 重适配及可能的商业订阅 |
| 已经部署 Nextcloud | 优先复用现有文件平台 | WebDAV／分享接入及账号映射 |

表中优先级为工程综合判断，不是厂商排名。免费许可证不会消除服务器、转换、流量、备份、升级和客服成本；用户量、文件大小、共编活跃度及交付方式未明确，因此本次不提供虚构的总价或精确人日。

## 验收范围与仍未确认的事项

选型资料支持候选筛选，尚未进行第三方部署、性能压测和实际文件往返测试。正式设计应以以下结果收敛范围：

1. **现有引擎授权：** 区分 wrapper 与原生内核，确认桌面商业分发、再分发、平台范围，以及是否存在经授权的服务端协作版本。
2. **文件闭环：** DOCX、XLSX、PPTX 分别完成云端下载、本地人类编辑、AI 修改、保存、上传新版本和再次打开；CSV 单独验证编码与单工作表边界。
3. **格式保真：** 使用中文字体、页眉页脚、目录、跨表公式、图表、透视表和 PPT 复杂对象样本，在目标 Office／WPS 中往返；现有项目的复杂格式和跨平台限制继续适用。
4. **集成体验：** 验证登录和账号切换、中文输入法、粘贴图片、快捷键、标签页、独立窗口、下载、主题及重新打开。第三方应用的 iframe 策略、Cookie 和导航行为未实测，不能承诺直接嵌入即可用。
5. **保存与恢复：** 验证断网重试、云端版本变化、上传失败、本地草稿保留、版本恢复；不要把本地保存成功显示成云端同步成功。
6. **若使用协作服务：** 两个用户和 Agent 同时修改同一文档，验证内容合并、撤销、断线重连和历史恢复。现成引擎承担协作算法，不自行制造 Office 二进制合并逻辑。
7. **部署与可退出：** 固定镜像及依赖版本，保留对应许可；验证数据库、附件、协作状态的一致备份与恢复，以及完整导出。不能只备份最终导出文件就假定保留了评论、权限和协作历史。

仍会改变最终选择的业务条件是：仅内部使用还是对外提供产品；是否接受 AGPL 修改开源；是否必须首版实时共编；是否要求浏览器完整编辑 Office；是否已有云端对象存储、身份服务和文件目录。报告已分别给出对应路线，不将这些未知项当作已确认需求。

## References

[1] [Docmost 仓库说明与许可划分](https://raw.githubusercontent.com/docmost/docmost/main/README.md)

[2] [Docmost Bases 免费／商业边界](https://docmost.com/docs/user-guide/bases)

[3] [Docmost 自托管价格与功能](https://docmost.com/pricing)

[4] [Docmost 功能与付费版本清单](https://docmost.com/docs/)

[5] [Docmost MCP 与许可要求](https://docmost.com/docs/user-guide/mcp)

[6] [Docmost 官方安装说明](https://docmost.com/docs/installation)

[7] [Outline 当前 BSL 许可](https://raw.githubusercontent.com/outline/outline/main/LICENSE)

[8] [Outline OIDC 配置](https://docs.getoutline.com/s/hosting/doc/oidc-8CPBm6uC0I)

[9] [AFFiNE 顶层许可划分](https://raw.githubusercontent.com/toeverything/AFFiNE/canary/LICENSE)

[10] [AFFiNE 后端许可原文及例外](https://raw.githubusercontent.com/toeverything/AFFiNE/canary/packages/backend/server/LICENSE)

[11] [AFFiNE 官方企业、自托管与 Code License 说明](https://affine.pro/enterprise)

[12] [AFFiNE 自托管 Team／Installable License](https://docs.affine.pro/self-host-affine/features/team-license)

[13] [AppFlowy 当前自托管服务、Free Tier 与部署说明](https://raw.githubusercontent.com/AppFlowy-IO/AppFlowy-SelfHost-Commercial/main/README.md)

[14] [AppFlowy 自托管商业协议](https://raw.githubusercontent.com/AppFlowy-IO/AppFlowy-SelfHost-Commercial/main/SELF_HOST_LICENSE_AGREEMENT.md)

[15] [AppFlowy-Cloud 旧仓库许可及归档状态](https://github.com/AppFlowy-IO/AppFlowy-Cloud/blob/main/LICENSE)

[16] [La Suite Docs 功能、主许可与非 MIT 构建说明](https://raw.githubusercontent.com/suitenumerique/docs/main/README.md)

[17] [La Suite Docs 服务组成与部署支持边界](https://raw.githubusercontent.com/suitenumerique/docs/main/documentation/installation/README.md)

[18] [La Suite Docs 外部 Resource Server API](https://raw.githubusercontent.com/suitenumerique/docs/main/documentation/resource_server.md)

[19] [La Suite Docs 当前协作服务依赖](https://raw.githubusercontent.com/suitenumerique/docs/main/src/yhub-server/package.json)

[20] [y/hub 官方许可说明](https://github.com/yjs/yhub)

[21] [BlockNote MPL 与 XL GPL 许可说明](https://github.com/TypeCellOS/BlockNote)

[22] [ONLYOFFICE Docs 集成与存储职责](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/)

[23] [ONLYOFFICE Community 商业集成 FAQ](https://helpcenter.onlyoffice.com/docs/faq/docs-community.aspx)

[24] [ONLYOFFICE 官方 9.4 发布说明：取消社区版 20 同时连接限制](https://community.onlyoffice.com/t/onlyoffice-docs-9-4-released-license-update-dark-document-for-sheets-horizontal-lines-new-slide-themes-transitions-and-more/19810)

[25] [ONLYOFFICE core 许可原文](https://raw.githubusercontent.com/ONLYOFFICE/core/master/LICENSE)

[26] [Collabora Online 源码 MPL 许可](https://raw.githubusercontent.com/CollaboraOnline/online/master/COPYING)

[27] [Collabora CODE 官方定位](https://www.collaboraonline.com/es/code/)

[28] [Collabora 官方 SDK 手册：WOPI、存储宿主与生产支持](https://sdk.collaboraonline.com/CO-SDK-manual.pdf)

[29] [Tiptap 开源核心 MIT 许可](https://raw.githubusercontent.com/ueberdosis/tiptap/main/LICENSE.md)

[30] [Hocuspocus 开源核心 MIT 许可](https://raw.githubusercontent.com/ueberdosis/hocuspocus/main/LICENSE.md)

[31] [Yjs MIT 许可](https://raw.githubusercontent.com/yjs/yjs/main/LICENSE)

[32] [Hocuspocus 协作服务说明](https://tiptap.dev/docs/hocuspocus/getting-started/overview)

[33] [Nextcloud Server AGPL 许可](https://raw.githubusercontent.com/nextcloud/server/master/COPYING)

[34] [Nextcloud WebDAV 文件与目录 API](https://docs.nextcloud.com/server/latest/developer_manual/client_apis/WebDAV/basic.html)

[35] [GNU AGPL-3.0 原文，尤其第 5、6、13 条](https://www.gnu.org/licenses/agpl-3.0.en.html)

[36] [Mozilla MPL 2.0 FAQ：商业组合与文件级义务](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)
