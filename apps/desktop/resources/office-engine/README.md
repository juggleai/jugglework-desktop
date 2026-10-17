# Office 本地供应资源

本目录是 JuggleWork 自带的 SDK 快照，不从 WorkBuddy、Office 或 WPS 安装目录加载文件。

- wrapper：`@tencent/tencent-docs-ai-engine 0.2.196-wb`。
- 原生内核：`editor_sdk 0.0.0.499`，编辑页面 HTML/JS/WASM 内嵌在原生二进制中。
- 已有实际资源：`darwin-arm64`。Windows x64、macOS Intel 只有上游平台声明，尚缺二进制。
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

截至 2026-10-17，配套下载脚本给出的以下地址实测返回 HTTP 404，尚未取得对应资源：

- `https://mirrors.tencent.com/repository/generic/docx-online/tools/latest/editor/0.0.0.499/win32-x64/editor.zip`
- `https://mirrors.tencent.com/repository/generic/docx-online/tools/latest/editor/0.0.0.499/darwin-x64/editor.zip`

打包钩子从本目录复制 wrapper 及目标平台完整目录到 ASAR 外的 `Resources/office-engine`。缺失目标平台、校验失败或只有 LFS 指针时停止打包。macOS 使用主应用实际选定的身份先签 SDK，更新安装包清单哈希，再封存主应用；源快照不变。

桌面运行时显式将自身资源目录传给 Server。内核的工作目录、日志和相对临时文件使用用户数据目录，安装目录保持只读。完整签名安装包、跨平台实机及 SDK 正式分发范围仍按 OpenSpec 单独验收。
