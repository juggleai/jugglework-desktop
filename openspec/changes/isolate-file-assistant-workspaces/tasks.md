## 1. 已实现合同
- [x] 1.1 每外部文件使用稳定 hash 子工作区及独立真实会话，原件不复制、不移动，登记键只解析原件。
- [x] 1.2 持久标记 fileAssistantManaged，普通工作区 UI 隐藏、有效登记在正常 API 可见，支持精确 ID 主窗口跳转并排除默认恢复。
- [x] 1.3 已有聊天继续按 workspace/session 对分窗；文件助手统一多来源窗口，固定 source/tabId 和 activeTabId 活动投影。
- [x] 1.4 model、agent、variant 与窗口局部草稿按 source 隔离，提交捕获来源，保持 Office owner 及选区合同。
- [x] 1.5 Main fetch/SSE 使用 registered source authority，来源移除/窗口关闭取消传输并拒绝迟到响应，不自动 abort accepted run。
- [x] 1.6 realpath 稳定身份、Windows 身份 casefold、32 位 ASCII hash 目录及 Windows/UNC 路径校验；不承诺 MAX_PATH。
- [x] 1.7 v1 保留共享历史和 legacy 归属，旧存活 Office owner 优先、延后迁移；已有会话仅查询 404 创建替代会话。
- [x] 1.8 picker、argv、Server 登记共用 FILE_WINDOW_EXTENSIONS，文本名单单一来源；Office helper 保持四格式，不加入 Markdown；安装关联仍仅 DOCX/XLSX/CSV/PPTX。
- [x] 1.9 Markdown/可编辑 UTF-8 文本沿用共享 file-editor 写回登记原件，强制 baseUpdatedAt、409 冲突且 force 不覆盖；Office 保持原生保存，PDF/图片/视频/HTML/XLS/ODS 只读，外部批量写入、删除和重命名不开放。
- [x] 1.10 冷启动以不创建、不修复目录的校验隔离无效 child，持久保留原工作区元数据及文件/会话关联，运行时会话/文件路由、watcher 和引擎不可访问该 cwd；服务只读模式同样执行，普通工作区继续可用。
- [x] 1.11 普通工作区改名、新增 child 及正常配置持久化保留隔离登记；目录修复后冷启动恢复相同 ID 和元数据；显式删除隔离工作区登记不访问无效 cwd，后续持久化不复活删除项。
- [x] 1.12 raw/content 保存通过 r+ 验证原件可写，审批后及替换前仍复核；不可写返回 403，POSIX 临时文件显式 chmod 保留原 mode & 0o777，不因 umask 丢失权限位。
- [x] 1.13 Server 外部原件映射限文件助手管理命名空间；普通工作区 external-files 磁盘目录正常读写，已登记其他来源原件键仍拒绝跨来源回退。
- [x] 1.14 Office open 返回 created 位，自动回滚校验 owner/onlyIfClean；预检新建模型的清理责任持续到 tab 接管，后续 open 返回 created=false 不解除责任；不关闭请求之前已存在的 reused owner，不丢弃 dirty，不恢复已注销来源。
- [x] 1.15 只读 clean 文本允许真实 Main/文件窗口 prepare/close，保留来源与文件校验；update/save/external 写保护及未保存草稿保护继续生效。

## 2. 自动化验证事实
- [x] 2.1 合并后已提供测试结果：App 225 pass；Server 157 pass、2 skip；预检交接修复后 Server 相关组 253 pass、Desktop 相关组 140 pass、真实 Electron runtime/sandbox 2 pass。测试组有 overlap，不合计为独立用例总数；skip 不计为完成验收，不宣称全仓测试通过。
- [x] 2.2 App、Server typecheck 及 Server build/check 通过。
- [x] 2.3 Markdown 格式与入口覆盖：`packages/types/test/file-window.test.ts`、`apps/desktop/scripts/file-window-runtime.test.mjs`、`apps/desktop/electron/system-file-opening.test.mjs`、`apps/server/src/office/file-window-markdown-entry.test.ts`。
- [x] 2.4 冷启动及真实 HTTP 原件保存覆盖：`apps/server/src/office/local-text-files.test.ts`，包括隔离元数据保留/修复/显式删除、r+ 不可写、审批期间变只读、umask 下权限保留、普通 external-files 目录和 managed 未登记键拒绝回退。
- [x] 2.5 Office created 位、owner/dirty 自动清理与只读文本 clean 生命周期覆盖：`apps/server/src/office/documents.test.ts`、`apps/server/src/office/file-window-isolation.test.ts`。
- [ ] 2.6 Electron 完整 typecheck：被 `native-actions-api.test` 的 5 个错误阻塞；同一 config 仅排除该 test 后，208 个 root files 为 0 diagnostics。限定检查不等于完整 typecheck 通过。
- [x] 2.7 预检模型 handoff 的 9 个回归场景通过，覆盖来源撤销、stat/预检失败、成功接管、reused owner、dirty 清理拒绝及布尔 API 兼容；独立静态复核通过。

以上为已提供的自动化事实，不是原生平台实测；真实平台验收仍保持未完成。

## 3. Change 规范
- [x] 3.1 design/tasks 与必要 delta specs 明确冷启动隔离、元数据持久保留、文本权限、managed 命名空间、Office created 回滚及只读 clean 生命周期合同。
- [x] 3.2 分类可见性与隔离不可访问一致；管理命名空间拒绝回退与普通同名磁盘目录正常读写一致；clean 关闭例外不扩大写权限。
- [x] 3.3 本 change 通过 OpenSpec 1.10.0 strict 校验。
- [x] 3.4 MODIFIED「启动与文件窗口名称」保留现行「Windows 第二实例文件请求」及「有值启动开关不产生文档请求」完整场景。

## 4. 真实平台验收
- [x] 4.1 Windows 实机 Office：多文件统一窗口、独立 AI 历史/草稿/模型选项、合法 UNC、原件保存与重开、关闭不停止已接受运行、精确主窗口定位。 （免验收，2026-11-28，用户确认：真实设备/真实环境验收不再执行）
- [x] 4.2 macOS 实机 Office：多文件来源切换、原生选区添加/发送、原模型 owner/dirty 保持、原件保存与重开、无主窗口及 v1 旧 owner 延后迁移。 （免验收，2026-11-28，用户确认：真实设备/真实环境验收不再执行）
- [x] 4.3 桌面最终 verify：真实 manual 验收及证据核对未完成；自动化结果不替代两平台手动验收，不标记本 change 全部完成。 （免验收，2026-11-28，用户确认：真实设备/真实环境验收不再执行）
