# 会话右侧「扩展」面板改造为分组卡片式并新增技能中心

## Why

会话页右侧配置 icon（`Settings2`）打开的「扩展」面板，当前渲染的是 `apps/app/src/react-app/domains/settings/pages/mcp-view.tsx`（约 1469 行）——一个带 `All / MCPs / Skills` 过滤 tab 的**扁平长列表**（「你的应用」+「扩展市场」）。它把 MCP 与技能混在一个列表里，没有按扩展类别分组，也无法一眼看清项目配置了哪些能力。

事实依据：

- 入口链路：`session-page.tsx:638` 的 `openExtensionsRailPane` → `session-route.tsx:2221` 渲染 `<SettingsSurface embedded initialPath="extensions" workspaceId=…>`，该面板天然是**项目级**（带 `workspaceId`）。
- 技能能力缺失：全仓无任何 `skillhub` 引用；现有技能功能只有「本地已装列表 + `installSkillTemplate` 模板安装器」，**没有从技能市场检索/安装的流程**；截图里的「扩展市场」是云端 org 的 Den marketplace，与 SkillHub 是两套系统。
- 技能来源不可区分：主进程 `main.mjs` 的 `listLocalSkills` 把项目级根目录（`.opencode/skills`、`.opencode/skill`、`.claude/skills`）与全局根目录（`~/.config/opencode/skills`、`~/.claude/skills` 等）**合并去重后返回 `{name, path, description, trigger}`，不带 scope 标记**，因此 UI 无法区分「项目级 vs 全局」技能。
- SkillHub 已具备可用能力：`https://skillhub.juggle.im` 提供匿名可访问的 `GET /api/web/skills`（搜索/分页）、`GET /api/web/skills/{ns}/{slug}`（详情）、`GET /api/web/skills/{ns}/{slug}/download`（返回 **ZIP** 技能包）。桌面端尚未接入。

用户可见后果：项目能力配置分散、技能只能靠手动放文件或写模板，无法从技能市场一键添加；也看不出某个技能是项目独有还是全局共享。

## What Changes

改造范围**仅限会话右侧「扩展」rail 面板**（`SettingsSurface embedded` 变体），独立设置页的 extensions tab 维持现状。

- **分组卡片面板**：`embedded` 变体下，extensions 路由改为按扩展类别分组的卡片列表，首批支持三组：`指令`、`连接器`、`技能`（`专家`、`自动化` 预留占位，本次不实现功能）。每组卡片右上角有 `+` 号打开对应新增流程。
- **连接器(MCP) 加号 modal**：打开一个汇总所有来源（组织下发 org MCP 连接器、快速连接目录 `quickConnect`、已装 MCP 服务）的 modal，按「已连接 / 未连接」两组展示，复用现有连接/授权动作。
- **技能 加号 modal**（对应参考图 2）：展示当前项目已添加技能网格 + 右上「+ 添加」下拉（`上传技能`=从本地上传至项目、`从技能中心添加`=打开技能中心）。技能网格中**项目级技能可管理，全局技能只读并标注「全局」**。
- **技能中心 modal**（对应参考图 3）：接入 SkillHub 匿名 API 检索技能，支持关键字搜索、分页、多选、确认后安装。安装＝主进程下载 ZIP 并解压进项目 `.opencode/skills/<slug>/`。tab `推荐 / SkillHub / 已安装`：`SkillHub` 拉全量（`sort=newest`），`推荐` 用热度排序，`已安装` 与本地技能交叉比对标记。
- **技能来源标记**：`listLocalSkills` 增加 `scope: "project" | "global"` 字段，UI 据此区分项目级与全局技能。

**BREAKING**: 无。仅在 `embedded` rail 变体内替换渲染内容；`listLocalSkills` 为**新增字段**，不改动既有字段与既有独立设置页。

## Impact

- 受影响规格：`session-extensions-panel`（新增能力）
- 受影响代码：
  - 渲染层（新增，`embedded` 变体门控）：
    - `apps/app/src/react-app/domains/settings/pages/`：新增分组面板组件（如 `project-extensions-panel.tsx`）
    - 新增 modal：连接器选择、技能管理、技能中心（选择技能）
    - `apps/app/src/react-app/domains/settings/shell/settings-page.tsx`：`case "extensions"` 按 `embedded` 分流到新面板
  - SkillHub 接入（新增）：
    - `apps/app/src/app/lib/`：SkillHub 客户端类型与 IPC 封装（`skillhubSearch`、`skillhubInstall`）
    - `apps/desktop/electron/main.mjs`：新增 `desktopCommandHandlers` 处理项——SkillHub 检索代理、下载 ZIP + 解压进项目技能根目录；`listLocalSkills` 增加 `scope` 字段
    - `apps/desktop/package.json`：新增轻量解压依赖 `fflate`
  - i18n：`apps/app/src/react-app/i18n/locales/*` 新增文案键
- 部署/配置：SkillHub base URL 默认 `https://skillhub.juggle.im`，匿名访问，无需鉴权；如需可覆盖为环境变量/设置项。
- 独立设置页：无改动（仍走现有 `mcp-view`）。
