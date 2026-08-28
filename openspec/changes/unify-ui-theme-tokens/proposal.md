# Unified UI Theme Tokens Proposal

## Why

四个主页面（工作区列表/会话、通讯录/消息、自动化任务）的背景色、顶栏高度、发送消息气泡色此前分散在各自的 CSS/token 中（slate 灰阶、硬编码十六进制、shadow DOM 内独立定义混用），且暗色主题映射不完整。跨页面视觉不统一，改一处色值需要在多个文件里同步，还多次出现"改了不生效"（shadow DOM 加载顺序、flex-basis 优先级等隐蔽问题）。

## What Changes

- 在 `apps/app/src/app/index.css` `:root` 建立四个唯一来源语义 token（`--app-page-bg` 页面白、`--app-list-bg` 列表灰、`--app-topbar-height` 顶栏高、`--app-msg-sent-bg` 发送气泡灰），暗色在 `[data-theme="dark"]` / `.dark` 双块统一映射。
- 亮色规范值：页面 `#ffffff`、列表 `#fcfcfc`、顶栏 `50px`、发送气泡 `#f3f3f4`。
- 所有既有 token（`--background`、`--sidebar`、`--dls-surface` 等）改为引用语义 token；消息页（jugglechat）shadow DOM 内样式经自定义属性穿透引用同一批 token。
- 顶栏统一 50px：会话页头、文件/扩展/设置面板头、设置页、自动化任务页（×2）、消息页会话头、通讯录页内容头（height/min-height/flex-basis 三件套同改）。
- 顶栏背景统一引用 `--app-page-bg`（纯白，覆盖 mac 半透明工具类）。
- 发送消息气泡（工作区会话 `bg-muted` → token；消息页 bridge 覆盖上游 `--ui-active`）统一 `#f3f3f4`，同步去除上游 1px 描边。
- 消息页输入区重构为工作区会话输入栏风格：无边框白底卡片 + 阴影、margin `0 16px 16px`、圆角 16px、编辑器在上/操作行沉底、表情与附件图标统一 16px lucide SVG、无发送按钮（回车发送）。
- 消息页顶栏去头像与 @id 副行，仅显示会话名称。

## Capabilities

### New Capabilities

- `ui-theme-tokens`: 语义 token 的定义、亮暗映射与各页面/区域的引用契约（页面与列表背景、顶栏高度与背景、发送气泡背景、消息页输入区卡片形态）。

### Modified Capabilities

无。

## Impact

- 渲染层：`apps/app/src/app/index.css`（token 唯一来源）、`apps/app/src/styles/custom.css`（`.session-header`/`.session-panel-header`）、`components/chat/message-list.tsx`（会话气泡）、`react-app/domains/automations/automation-page.tsx`、`settings/shell/settings-shell.tsx`、`session/chat/session-page.tsx`、`shell/list-panel-header.css`、`domains/jugglechat/{components.tsx,jugglechat.css,snailchat-theme.css}`（shadow DOM 桥接层）。
- 消息页样式覆盖统一收口在 `snailchat-theme.css`（bridge，shadow 内加载顺序最末），需与上游同特异性规则竞争时以加载顺序取胜；不得写回 `jugglechat.css`（先加载，会被上游压掉）。
- 暗色主题全部经 token 映射（slate 灰阶/上游 ui-* token），不引入新硬编码暗色值。
- 不改主进程、服务端与依赖。
