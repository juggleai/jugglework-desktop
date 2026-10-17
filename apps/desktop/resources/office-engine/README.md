# Office 本地供应资源

本目录是 JuggleWork 自带的 SDK 快照，不从 WorkBuddy、Office 或 WPS 安装目录加载文件。

- wrapper：`@tencent/tencent-docs-ai-engine 0.2.196-wb`。
- 原生内核：`editor_sdk 0.0.0.499`，编辑页面 HTML/JS/WASM 内嵌在原生二进制中。
- 已有实际资源：`darwin-arm64`、`darwin-x64`、`win32-x64`。三个平台共用逐字节一致的 wrapper，分别使用原生内核。
- 原生二进制使用 Git LFS；wrapper、平台标记和版本清单为普通 Git 文件。日志和临时目录不纳入供应资源。

检出仓库后，准备实际的大文件，再构建：

```sh
git lfs install --local
git lfs pull
```

Git LFS 仅用于开发与构建时检出源资源，用户运行安装包无需 Git、Git LFS、系统 Node 或联网下载 SDK。

每个平台使用 `<platform>/version.json`，记录配套版本、相对路径和二进制 SHA-256。根 `version.json` 保留单平台资源兼容；随安装包交付时仅包含该包的目标平台。

取得完整本地 SDK 后，可在任意开发主机上导入目标平台，不需要启动那个平台的二进制：

```sh
node scripts/import-office-engine.mjs /path/to/local/sdk apps/desktop/resources/office-engine win32-x64
node scripts/import-office-engine.mjs /path/to/local/sdk apps/desktop/resources/office-engine darwin-x64
```

### 平台供应清单

| 平台 | 原生文件大小（字节） | SHA-256 |
| --- | ---: | --- |
| `darwin-arm64` | 227697760 | `4108b17c870cc3d5b6aa6b42f7030c3a59be992d52b4fa4c7e1eb5d55a836201` |
| `darwin-x64` | 238583472 | `1d07fd2e060f2300f0229852a8e2935dcdb66955dfc8c5202d667d3810ce0a24` |
| `win32-x64` | 209234760 | `b372679233c2ea586cc9e2ee9f491b06a702780bf72b8ef15cec1761994fd45c` |

Intel 资源来自 `WorkBuddy-darwin-x64-5.8.3.41334564-db0e9b51.dmg`，安装包 SHA-256 为 `be38d473d41d3aed0958c80170213c90e6dba6404668849e4f7d0fda74b24f6e`。Windows 资源来自 `WorkBuddy-win32-x64-user-5.8.4.41366630-73952edb.exe`，安装包 SHA-256 为 `1ca65684338e8b803afb246a0c4b7d49c90dcefcc30c296a1424bbfb9c80b843`。本地解包后导入完整 SDK 平台目录，产品运行无需这些安装包或 WorkBuddy。

Intel 原生文件为单架构 x86_64 Mach-O，声明最低 macOS 10.15，11 项动态依赖均为系统框架或库；JuggleWork 仍沿用自身系统基线。Windows 原生文件为 PE32+ x64，原包平台目录只有 EXE 和版本标记，11 项静态导入均为 Windows 系统 DLL，没有延迟导入表；动态加载行为尚未在 Windows 实机验证。

静态分析依据：Intel Mach-O 的 REA Evidence 为 `ev_f489a91b2987e2b132e0f9a51b4fd1fd667a229a7c96e3e2ea06f5f8875d53d1`，Intel wrapper 为 `ev_42affd05665761179f6c2ccf7b8c0dbf4d17d11c4e93af818d88187fc0433286`，Windows wrapper 为 `ev_5399be245f87a37041132fa27358bc4254f15f5ad5bf57203ec8ef0958dbe6b8`。Windows NSIS 成员由系统 bsdtar 枚举解包，PE 静态依赖由导入表解析确认，不声明为 REA 动态执行证据。

三个平台实际资源均通过按目标平台复制到 ASAR 外及哈希校验。Intel 内核在 Apple Silicon 上通过 Rosetta 完成 DOCX、CSV、XLSX、PPTX 修改、保存、重开回读和本地页面入口检查，中文及带空格路径可用，只读资源目录未变化；磁盘核对确认 XLSX 两表及跨表公式、PPT 第二页保留。这不等于 Intel 实机、Windows 运行或完整桌面安装包验收；跨窗口迁移仍仅开放已验收的 macOS ARM64。

打包钩子从本目录复制 wrapper 及目标平台完整目录到 ASAR 外的 `Resources/office-engine`。缺失目标平台、校验失败或只有 LFS 指针时停止打包。macOS 使用主应用实际选定的身份先签 SDK，更新安装包清单哈希，再封存主应用；源快照不变。

桌面运行时显式将自身资源目录传给 Server。内核的工作目录、日志和相对临时文件使用用户数据目录，安装目录保持只读。完整签名安装包、跨平台实机及 SDK 正式分发范围仍按 OpenSpec 单独验收。
