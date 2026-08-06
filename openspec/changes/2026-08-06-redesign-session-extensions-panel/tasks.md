# 实施任务

## 1. 前置核实

- [x] 1.1 核实 `embedded` 仅在会话右侧 rail（`session-route.tsx` 的 `settingsSlot`）为 `true`，独立设置页为 `false`，确认可用它做分流门控
- [x] 1.2 核实 `settings-route.tsx` 传给 `mcp-view` 的 props（`mcpServers`、`orgMcpItems`、`quickConnect`、`installedSkills`、`connectMcp`、`authorizeMcp`、`uninstallSkill`、各状态 map），确认新面板可复用同一批 props/store
- [x] 1.3 实测 `https://skillhub.juggle.im` 从主进程可匿名访问 `GET /api/web/skills` 与 `GET .../download`（ZIP）
- [x] 1.4 确认「指令」分组落点（design 决策七）：确认写 `AGENTS.md` 还是其它；若暂缓则本次仅占位

## 2. 主进程：技能 scope 与 SkillHub 接入（`apps/desktop`）

- [x] 2.1 新增依赖 `fflate` 到 `apps/desktop/package.json` 并安装
- [x] 2.2 `main.mjs` `listLocalSkills`：遍历时按命中根区分 project/global，返回项新增 `scope: "project" | "global"`；保持同名去重（项目级优先）
- [x] 2.3 新增 `desktopCommandHandlers["skillhubSearch"]`：参数 `{ q, sort, page, size }`，转发 `${SKILLHUB_BASE}/api/web/skills`，回传 `{items,total,page,size}`；`SKILLHUB_BASE` 常量默认 `https://skillhub.juggle.im`，支持 `SKILLHUB_BASE_URL` 覆盖
- [x] 2.4 新增 `desktopCommandHandlers["skillhubInstall"]`：参数 `{ projectDir, namespace, slug, version? }`，`GET .../download` 取 ZIP → `fflate.unzipSync` → 写入 `ensureProjectSkillRoot(projectDir)/<slug>/`
- [x] 2.5 解压做 zip-slip 防护：每个 entry 目标路径归一化后必须仍在目标目录内，否则跳过并计入失败
- [x] 2.6 `skillhubInstall` 返回 `{ ok, installedPath, skippedEntries, message }`；同名技能按覆盖写入
- [x] 2.7 `desktop.ts` 封装 `skillhubSearch`、`skillhubInstall` 导出；`SkillItem` 类型加 `scope`

## 3. 渲染层：分组卡片面板（`embedded` 变体）

- [x] 3.1 新增 `project-extensions-panel.tsx`：分组卡片布局，首批 `指令 / 连接器 / 技能`，`专家 / 自动化` 占位卡片（`+` 置灰或提示"即将支持"）
- [x] 3.2 每组卡片：标题 + 描述 + 右上 `+`；`技能` 卡片展示已装技能图标行与计数（参考图 1）
- [x] 3.3 `settings-page.tsx` `case "extensions"`：`embedded` 为真渲染 `ProjectExtensionsPanel`，否则维持 `mcp-view`
- [x] 3.4 从现有 store/props 取数据接入面板，不新造数据源

## 4. 连接器(MCP) 选择 modal

- [x] 4.1 新增连接器 modal：汇总 `orgMcpItems` ∪ `quickConnect` ∪ `mcpServers`，按身份去重
- [x] 4.2 按状态拆「已连接 / 未连接」两组分区展示
- [x] 4.3 未连接项点击复用既有动作：org→成员授权、目录→`connectMcp`、已装断开→`authorizeMcp`
- [x] 4.4 已连接项展示状态徽标与断开/管理入口（复用现有动作）
- [x] 4.5 由 `连接器` 卡片 `+` 打开

## 5. 技能管理 modal（参考图 2）

- [x] 5.1 新增技能 modal：项目已装技能网格 + 顶部「当前项目已添加 N 个技能」（仅数 `scope==="project"`）
- [x] 5.2 右上「+ 添加」下拉：`上传技能`（本地上传至项目）、`从技能中心添加`（打开技能中心）
- [x] 5.3 `scope==="project"` 卡片可卸载（复用 `uninstallSkill`）；`scope==="global"` 只读并标「全局」徽标、禁用卸载
- [x] 5.4 `上传技能`：选择本地目录/文件写入项目 `.opencode/skills/`（复用/扩展现有安装通道）
- [x] 5.5 由 `技能` 卡片 `+` 打开；确认/取消按参考图 2

## 6. 技能中心 modal（参考图 3）

- [x] 6.1 新增技能中心 modal：顶部搜索框 + tab `推荐 / SkillHub / 已安装`
- [x] 6.2 列表用 `skillhubSearch` 分页拉取，卡片展示 `displayName / summary`，图标用首字母+哈希色占位
- [x] 6.3 `已安装` tab：与 `listLocalSkills` 按 `slug`/`name` 交叉比对，命中标「已安装」并过滤
- [x] 6.4 分类行：`/api/web/labels` 非空时渲染分类 tab，当前为空则只显示「全部」
- [x] 6.5 多选：卡片勾选态 + 底部「已选 N 个」+「确认」
- [x] 6.6 确认后对每个新选中技能调 `skillhubInstall`，展示逐个进度与失败项；成功后刷新技能列表
- [x] 6.7 已安装项在选择态下置为已选且禁用取消（避免重复安装）

## 7. i18n 与文案

- [x] 7.1 新增分组标题/描述、modal 标题、按钮、空态、错误提示等文案键（zh + en）
- [x] 7.2 复用既有键（如卸载、取消、确认、已连接/未连接状态）避免重复

## 8. 验证

- [x] 8.1 会话右侧扩展面板显示三组卡片；独立设置页 extensions tab 无变化
- [x] 8.2 连接器 modal 正确分「已连接/未连接」，连接/授权动作生效
- [x] 8.3 技能中心可搜索、多选、确认安装；技能包解压进项目 `.opencode/skills/<slug>/` 且能被识别
- [x] 8.4 技能网格正确区分项目级（可卸载）与全局（只读标注），计数只数项目级
- [x] 8.5 `@jugglework/app` typecheck 通过；应用启动无 Vite 报错叠层
- [x] 8.6 zip-slip 防护有效（构造越界路径的技能包被拒绝）
