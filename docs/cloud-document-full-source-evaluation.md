# JuggleWork 云文档全源码选型评估

日期：2026-11-05。范围：在已有组织、成员、IM、桌面端与本地 Office 基础上，选择可取得关键业务模块、编辑器、协作及导出实现源码，并有自行构建路径的云文档项目。商用费用不参与排序；源码公开与使用许可分别判断。

## 选型结论

**优先采用 La Suite Docs 作为文字云文档的验证对象，AFFiNE 作为文档与白板一体化的备选。** La Suite Docs 的应用、编辑器高级包、协作服务与导出编译器均找到了公开实现和构建入口，受查链路未发现类似 Docmost EE 的私有源码边界。[1][2][3][4][5][6][7][8]

这一结论适用于补齐“飞书式文字协作”，并继续使用现有 Office 处理本地文件。**La Suite Docs 不提供完整的在线 Excel、PPT、多维数据库套件**；其演示模式也不能等同于 PPTX 协同编辑。要求飞书全部内容类型由一个项目覆盖，当前没有可据此直接确认满足的项目。[1]

“有源码和构建入口”不等于“已实测全部构建成功”。本轮未执行干净环境的全链编译、部署、多人协作或格式保真测试，也未逐项审计全部传递依赖。

## 候选项目对比

| 项目 | 全源码要求下的判断 | 对 JuggleWork 的适配结论 |
| --- | --- | --- |
| **La Suite Docs** | 已核实主要应用、协作、编辑器及高级导出源码链；待实际构建验收 | **首选文字云文档方案**，功能边界集中 |
| **AFFiNE** | 原生后端、协作及关键 Rust 依赖有公开实现；全部高级模块与独立运行条件仍需逐项验收 | 白板与文档同等重要时优先；整体裁剪和维护范围更大 |
| **Think** | 公开客户端、服务端及协作实现，并有源码部署说明 | 中文 Wiki 参考方案；依赖基线较旧，需评估升级成本 |
| **Docmost** | 社区源码公开，EE 后端通过独立子模块引用 | 若要求全部高级模块源码公开，不满足 |
| **Outline** | 社区协作可自建；官方明确授权版不提供源码 | 若包含授权版高级模块，不满足 |
| **CryptPad** | 有应用和 Office 编辑／转换构建源码，但当前服务端及部分编辑器 WASM 构建链仍有未解决项 | 暂不按全源码通过；加密架构也增加统一身份、权限和 Agent 接入成本 |

AFFiNE、Think、Docmost、Outline 与 CryptPad 的判断分别依据下列源码或官方文档。[12][13][14][15][16][17][18][19][20][24][25] 此表不把“未完成核验”解释为“已经证实闭源”。

## La Suite Docs 的源码边界

| 模块 | 公开源码位置 | 构建证据 |
| --- | --- | --- |
| Web 编辑与文档界面 | `suitenumerique/docs/src/frontend` | Dockerfile 从源码执行依赖安装与前端构建 [2] |
| 文档、成员访问及应用 API | `suitenumerique/docs/src/backend` | Django 源码及后端镜像构建入口 [3][10][11] |
| 实时协作 | Docs 的 `src/yhub-server`，依赖 `yjs/yhub` | 应用包装服务与核心依赖均有公开源码；原生依赖 `y-crdt/yn` 也有 Rust 构建源 [4][7][8] |
| 高级编辑与导出 | `TypeCellOS/BlockNote/packages/xl-*` | Docs 使用 AI、多栏及 DOCX／ODT／PDF 包；对应版本的包源码公开 [5][21] |
| 服务端格式转换 | Docs 的 `src/frontend/servers/y-provider` | 转换服务本身有公开 TypeScript 源码及编译入口 [23] |
| PDF 编译内核 | BlockNote 的 `xl-typst-compiler` | Rust 实现与 WASM 构建脚本公开，并非只有一个不可追溯的 WASM 文件 [6][22] |

**BlockNote XL 的 GPL／商业双许可、yhub 的 AGPL／商业双许可，不代表源码没有公开。** 当前用户要求暂不比较商用授权，因此不因许可名称排除这些模块。也不能把 Docs 主仓库的 MIT 声明扩展为全部依赖都是 MIT。[1][5][7]

本次检查的 Docs 提交为 `3799ef60cec43b3a939b0fd2b3a775ce9f824e5a`。其前端使用 BlockNote `0.56.0`，应配套该版本源码，而非随意混用编辑器主分支；协作依赖也应按锁文件固定。[21]

默认 Docker 构建仍会安装公开 npm 包。若要求第三方编辑器、原生模块和 WASM 也由自己编译，需要分别构建匹配版本，并将产物接入应用依赖；不能把执行应用 Dockerfile 等同于重新编译所有依赖。[2][4][6][7][8]

## 与 JuggleWork 的接入关系

下列是结合现有源码作出的工程判断，非已实现功能。已有能力详见[组织、IM 与桌面适配评估](cloud-document-feishu-fit-evaluation.md)。

| 已有能力 | 建议接入方式 | 必须补齐的工作 |
| --- | --- | --- |
| 全局用户、组织和成员 | JuggleWork 保持身份权威，映射到 Docs 用户与文档访问关系 | 登录适配、组织范围隔离、成员退出后的权限及在线会话撤销 |
| 团队和 IM 群 | 作为文档共享对象的来源 | 显式映射群成员与文档 ACL；组织角色不能直接替代文档权限 |
| IM 通知 | 复用现有消息投递、气泡和桌面路由 | 评论／提及通知、文档卡片和定位链接；实时编辑继续由协作引擎承担 |
| 桌面和本地 Office | 增加云文档标签页，继续保留本地 Office 入口 | 组织切换时清理会话和缓存；云文档与本地 Office 文件分别识别 |
| Agent | 接入同一内容模型及协作写入路径 | 校验正文更新、评论锚点与版本历史；不能用静态文件覆盖在线编辑状态 |

标准部署要求 OIDC 身份服务，现有账号系统不能直接视为已提供 OIDC；需要登录桥接或应用认证适配。外部 API 有可配置的动作范围，应按具体接口验收，不能仅因存在 API 就认定所有文档能力可直接调用。[9][10]

Docs 引入 Django、PostgreSQL、对象存储及协作所需 Redis／Valkey 等组件，不能直接共用现有 MySQL 模型。官方 Compose 方案标注为实验性，生产部署指南以 Kubernetes 为主，部署和维护成本需纳入评估。[9]

**当前数据库模型还不满足本项目“禁止外键”的规则。** 受查 Django 模型含默认生成数据库约束的 `ForeignKey` 定义。采用前需调整模型、迁移及应用层删除处理，并检查协作库的约束；公开源码不等于直接符合全部本地规范。[11]

## AFFiNE 为什么保留为备选

AFFiNE 的 Web、服务端、同步网关及 Rust 原生运行时有公开实现。关键 `affine_core` 等依赖虽不全在主仓库，也有版本化发布源码；使用 `.node` 原生模块或 npm 工作区的 `private: true` 均不能据此认定源码不公开。[12][13][14]

它更适合把文档、无限画布和块模型作为统一产品方向。对当前以“已有桌面、已有 IM，新增云文档”为主的需求，La Suite Docs 的接入范围更集中，因此优先级更高。这是工程取舍，不是性能测试排名。

AFFiNE 的所有高级功能是否与托管版完全一致、哪些功能还需要厂商凭据或外部服务，仍需建立清单并运行验证；目前不作“所有商业功能无条件可独立运行”的承诺。

## 验收边界

首个验证对象确定为 **La Suite Docs**。进入业务接入前，应完成匹配版本的应用、协作、编辑器和导出构建；两用户同时编辑、断线恢复、评论定位及历史恢复；组织切换、成员退出和跨组织访问；中文内容及 DOCX／PDF 导出验收。

当前环境没有 Docker，未实际执行上述构建和部署。这份结论支持项目选择和验证范围，不构成全依赖可复现构建认证。

## References

[1] [La Suite Docs 功能与源码范围](https://raw.githubusercontent.com/suitenumerique/docs/main/README.md)

[2] [Docs 前端源码构建](https://raw.githubusercontent.com/suitenumerique/docs/main/src/frontend/Dockerfile)

[3] [Docs 后端源码构建](https://raw.githubusercontent.com/suitenumerique/docs/main/Dockerfile)

[4] [Docs 协作包装服务构建](https://raw.githubusercontent.com/suitenumerique/docs/main/src/yhub-server/Dockerfile)

[5] [BlockNote 0.56.0 DOCX 高级包](https://raw.githubusercontent.com/TypeCellOS/BlockNote/v0.56.0/packages/xl-docx-exporter/package.json)

[6] [BlockNote 0.56.0 PDF 编译器 Rust 实现](https://raw.githubusercontent.com/TypeCellOS/BlockNote/v0.56.0/packages/xl-typst-compiler/rust/src/lib.rs)

[7] [yhub 对应发布源码与构建定义](https://raw.githubusercontent.com/yjs/yhub/f1f937e6ac8ad71d9262868ea34f5f644ddb2424/package.json)

[8] [协作原生依赖 yn 构建源码](https://raw.githubusercontent.com/y-crdt/yn/main/Cargo.toml)

[9] [Docs Compose 部署及依赖限制](https://raw.githubusercontent.com/suitenumerique/docs/main/documentation/installation/compose.md)

[10] [Docs 外部资源 API](https://raw.githubusercontent.com/suitenumerique/docs/main/documentation/resource_server.md)

[11] [Docs 受查数据库模型](https://raw.githubusercontent.com/suitenumerique/docs/3799ef60cec43b3a939b0fd2b3a775ce9f824e5a/src/backend/core/models.py)

[12] [AFFiNE 自行构建说明](https://raw.githubusercontent.com/toeverything/AFFiNE/8bbbfcf07874078bcb37cf88c40b81002382d0ba/docs/BUILDING.md)

[13] [AFFiNE 原生后端实现](https://raw.githubusercontent.com/toeverything/AFFiNE/8bbbfcf07874078bcb37cf88c40b81002382d0ba/packages/backend/native/src/runtime/backend_runtime/mod.rs)

[14] [AFFiNE 关键依赖的公开权限实现](https://docs.rs/crate/affine_core/0.0.9/source/src/access_control/permission.rs)

[15] [Outline 官方源码构建与授权版边界](https://docs.getoutline.com/s/hosting/doc/from-source-BlBxrNzMIP)

[16] [Docmost EE 子模块声明](https://raw.githubusercontent.com/docmost/docmost/main/.gitmodules)

[17] [Think 项目与源码部署入口](https://raw.githubusercontent.com/fantasticit/think/main/README.md)

[18] [CryptPad 当前服务端公开仓库树](https://api.github.com/repos/cryptpad/cryptpad-server/git/trees/65355845eab4295739ccece63a81ab798cc10582?recursive=1)

[19] [CryptPad SSO 的能力与限制](https://github.com/cryptpad/sso/blob/c149256066f6684dfc0fef701d4096d6ef7bbd9c/README.md)

[20] [CryptPad Office 编辑器构建入口](https://github.com/cryptpad/onlyoffice-editor/blob/f79dded6570c02a8723dd557390e0d0eb0d7b489/Dockerfile)

[21] [Docs 受查前端依赖版本](https://raw.githubusercontent.com/suitenumerique/docs/3799ef60cec43b3a939b0fd2b3a775ce9f824e5a/src/frontend/apps/impress/package.json)

[22] [BlockNote WASM 编译脚本](https://raw.githubusercontent.com/TypeCellOS/BlockNote/main/packages/xl-typst-compiler/scripts/ensure-wasm.mjs)

[23] [Docs 格式转换服务构建](https://raw.githubusercontent.com/suitenumerique/docs/main/src/frontend/servers/y-provider/Dockerfile)

[24] [Think 服务端依赖基线](https://raw.githubusercontent.com/fantasticit/think/d620a02623d6d3ae39ee9ee7295f8c10dad9a3e2/packages/server/package.json)

[25] [CryptPad 服务端启动依赖](https://github.com/cryptpad/cryptpad/blob/a4209cca7db6dca4b9cefc5b34fa765e9ae3c6a8/server.js)
