# 设计

## 背景约束（既有代码事实）

- **入口/容器**：`session-route.tsx:2221` 以 `<SettingsSurface embedded initialPath="extensions" workspaceId=…>` 渲染右侧面板；`settings-page.tsx` 的 `case "extensions"` 是 extensions 路由的渲染点，独立设置页与 rail 面板**共用同一组件**，靠 `embedded` 布尔区分。
- **IPC 模型**：主进程 `main.mjs` 用 `desktopCommandHandlers` 映射（如 `installSkillTemplate` @1876、`listLocalSkills` @1893、`uninstallSkill` @1915），经 `handleDesktopInvoke` @2224 分发；渲染端在 `apps/app/src/app/lib/desktop.ts` 封装为函数导出。
- **技能目录**：`collectProjectSkillRoots`（`.opencode/skills`、`.opencode/skill`、`.claude/skills`，向上找到 `.git` 为止）与 `collectGlobalSkillRoots`（`~/.config/opencode/skills`、`~/.claude/skills`、`~/.agents/skills`、`~/.agent/skills`）；`ensureProjectSkillRoot` 返回项目 `.opencode/skills`。
- **MCP 数据**：`mcp-view` 已具备 `mcpServers`（已装）、`orgMcpItems`（org 下发连接器）、`quickConnect`（快速连接目录）及状态判定（`connected/needs_auth/disconnected`）与连接/授权动作。
- **SkillHub API（已实测，匿名）**：
  - 列表：`GET /api/web/skills?q=&sort=newest&namespace=&label=&page=&size=` → `{code,msg,data:{items,total,page,size}}`；item：`{id, slug, displayName, summary, namespace, downloadCount, starCount, ratingAvg, updatedAt, headlineVersion:{version}, resolutionMode}`。
  - 详情：`GET /api/web/skills/{ns}/{slug}`；`GET .../resolve`、`.../versions` 含 `parsedMetadataJson`（SKILL.md 正文）。
  - 下载：`GET /api/web/skills/{ns}/{slug}/download` → `application/zip`（含 `SKILL.md` 等文件）。
  - `GET /api/web/labels` 目前返回空 `[]`；列表项无 icon、无分类字段。

## 决策一：新面板仅在 embedded rail 变体启用，独立设置页不动

`settings-page.tsx` 的 `case "extensions"` 按 `embedded` 分流：`embedded === true` 渲染新的分组卡片面板 `ProjectExtensionsPanel`；否则维持现有 `mcp-view`。

理由：满足「只改会话右侧扩展面板」的范围约束，把回归风险隔离在 rail 场景；独立设置页保持现状，零回归。任务阶段需先核实 `embedded` 确实只在 rail（`settingsSlot`）为真、独立设置页为假。

## 决策二：SkillHub 所有网络调用走主进程 IPC，不在渲染进程直连

新增主进程处理项：
- `skillhubSearch({ q, sort, page, size })` → 转发到 `${SKILLHUB_BASE}/api/web/skills`，回传解析后的 `{items,total,page,size}`。
- `skillhubInstall({ namespace, slug, version? })` → `GET .../download` 取 ZIP → 解压进 `ensureProjectSkillRoot(projectDir)/<slug>/` → 回传安装结果。

理由：
1. 下载+解压+落盘本就必须在主进程（Node fs）完成。
2. 渲染进程直连跨域到 `skillhub.juggle.im` 存在 CORS 不确定性；统一走主进程彻底规避，且集中管理 base URL 与未来鉴权。
3. base URL 以常量默认 `https://skillhub.juggle.im`，允许 `SKILLHUB_BASE_URL` 环境变量覆盖。

## 决策三：ZIP 解压用 `fflate`

`apps/desktop` 现无任何解压依赖，Node 内置 `zlib` 只处理 raw deflate/gzip，不能解 ZIP 容器。选 `fflate`（纯 JS、零依赖、体积小、跨平台）在主进程 `unzipSync` 解 ZIP 后逐条写盘。

- 备选（不采用）：调系统 `unzip`/`Expand-Archive`——跨平台脆弱，依赖外部命令。
- 备选（不采用）：改用 `.../versions/{v}/files` + 逐文件 `.../file?path=` 拉取——省去解压但变成 N 次请求，且需要额外处理目录结构。ZIP 单请求更简单，多文件技能天然支持。

落盘安全：解压时对每个 entry 的目标路径做归一化，拒绝越出目标目录的路径（防 zip-slip）；目标目录已存在同名技能时按「覆盖」语义写入。

## 决策四：技能 scope 标记由 `listLocalSkills` 输出

`listLocalSkills` 遍历时记录每个 skill 命中的根属于 project 还是 global，返回新增 `scope: "project" | "global"`。合并去重规则保持不变（同名优先项目级，因为项目根在 `collectSkillRoots` 中排在全局前）。

UI 约定：技能网格中 `scope==="project"` 可卸载/管理；`scope==="global"` 只读并标注「全局」徽标，禁用卸载入口，计数以项目级为准（参考图 2 的「当前项目已添加 N 个技能」只数项目级）。

## 决策五：技能中心的 tab、分类与图标降级

- **tab**：`SkillHub` = `sort=newest` 全量分页；`推荐` = 热度排序（`sort` 取 downloads/stars，具体值以后端支持为准，缺省回落 `newest`）；`已安装` = 用 `listLocalSkills` 结果按 `slug`/`name` 与 SkillHub item 交叉比对，命中即标「已安装」并在该 tab 过滤展示。
- **分类行**：`/api/web/labels` 当前为空，暂**只保留「全部」**，分类 tab 行在 labels 有数据时再启用（渲染层按 labels 是否非空条件渲染，无需二次改造）。
- **图标**：列表项无 icon 字段，用「`displayName` 首字母 + 基于名称哈希的背景色」生成占位头像（与参考图 3 多数为字母色块一致）。
- **已选/多选**：卡片右上勾选态，底部「已选 N 个」+「确认」；确认后对每个新选中的技能依次调用 `skillhubInstall`，展示逐个安装进度与失败项。

## 决策六：连接器(MCP) 选择 modal 的数据源与分组

汇总三源并按身份去重：`orgMcpItems`（org 下发）∪ `quickConnect`（目录）∪ `mcpServers`（已装）。用既有状态判定拆成两组：
- **已连接**：状态为 `connected` 的项。
- **未连接**：其余（未装/未授权/未连接），点击触发既有连接/授权动作（org 走成员授权，目录走 `connectMcp`，已装但断开走 `authorizeMcp`）。

不重复造连接逻辑，只做「聚合 + 分组 + 复用动作」。

## 决策七：「指令」分组的落点（**待确认假设**）

「指令」目前无独立实现（extensions-view 里的 "Instructions" 只是创建本地 skill 的正文输入）。本设计将「指令」暂定为：`+` 打开一个编辑**项目级指令文件**的 modal，写入项目根的 `AGENTS.md`（opencode 读取的项目指令约定）。此为假设，apply 前请确认落点文件与语义；若暂不做，可先渲染分组卡片占位、`+` 置灰。

## 影响面小结

- 新增：分组面板组件、三个 modal（连接器/技能/技能中心）、SkillHub 客户端封装、主进程 3 类处理项（search/install/enhanced-list）、`fflate` 依赖、i18n 文案。
- 修改：`settings-page.tsx` extensions 分流、`main.mjs` 的 `listLocalSkills` 增字段。
- 不动：独立设置页 extensions tab、现有 MCP/技能连接与卸载逻辑、其它路由。
