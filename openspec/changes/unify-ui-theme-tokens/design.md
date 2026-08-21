# UI Theme Tokens Design

## Context

- 四个页面分别用不同机制定义背景：会话/自动化走 Tailwind `bg-background` → `--slate-1`(#fcfcfd)；列表走 `bg-sidebar` → `--slate-2`(#f9f9fb)；消息页在 shadow DOM 内自成体系(`--ui-chat-bg`/`--ui-surface`/硬编码 #fff)；顶栏高度分散在 markup `h-14`、`.session-header` 56px 覆盖、上游 `.tyn-chat-head` 60px、`.jw-im-contact-main-header` 56px。
- 消息页样式链：`jugglechat.css` → 上游 bundle/app/custom 等 → `snailchat-theme.css`(bridge，最后加载)。同特异性下后加载者胜，因此 bridge 是消息页样式的唯一可靠收口点。
- 自定义属性(CSS 变量)可穿透 shadow 边界从宿主继承，已有先例(`--ui-chat-bg` 引用宿主 `--background`)。

## Goals / Non-Goals

- Goals: 亮色下四个页面视觉统一（页面白/列表灰/顶栏 50px 白/气泡灰）；改任何一处规范值只动 `apps/app/src/app/index.css` 一个文件；暗色自动回退，不出现亮色块。
- Non-Goals: 不重设计暗色主题；不动列表区头部高度（工作区列表头 84/96px、会话列表头，内容密度不同）；不改 mac 毛玻璃策略以外的窗口效果。

## Decisions

### 1. token 唯一来源放在宿主 `:root`

`--app-page-bg` / `--app-list-bg` / `--app-topbar-height` / `--app-msg-sent-bg` 定义在 `apps/app/src/app/index.css`。既有语义 token（`--background`、`--sidebar`、`--dls-*`）全部改为 `var(--app-*)` 引用，一处改值全局生效。暗色在 `[data-theme="dark"]` 与 `.dark` 两个块都映射（双保险，防仅挂类不挂属性时塌回亮色）。

### 2. 消息页经 bridge 收口，绝不写 jugglechat.css

`jugglechat.css` 先于上游加载，同特异性必被上游覆盖（`.tyn-chat-head` 60px 事件）。所有消息页样式覆盖写在 `snailchat-theme.css`（bridge）：
- 覆盖规则选择器与上游保持同特异性（或更高），靠加载顺序取胜。
- 尺寸类覆盖必须同时改 `height`/`min-height`/`flex-basis`（column flex 下 flex-basis 优先于 height，漏改即失效）。
- 值优先引用宿主 token（`var(--app-topbar-height, 50px)` 带 fallback），亮暗自动跟随。

### 3. 顶栏统一 50px + 纯白背景

- `.session-header`/`.session-panel-header` 在 `styles/custom.css`（非 layer CSS，可压过 mac 半透明工具类）统一引用 token。
- markup 中的 `h-14`/死值 `h-10` 清理为 `h-[var(--app-topbar-height)]` 或删除。

### 4. 发送气泡统一 #f3f3f4

- 工作区会话：`message-list.tsx` 气泡 `bg-muted` → `bg-[var(--app-msg-sent-bg)]`。
- 消息页：bridge 用与上游同特异性 (0,3,0) 的选择器覆盖 `.tyn-root .outgoing .tyn-reply-text` 等四类元素（文本/文件/合并消息/通话），并清除上游 1px 描边，与工作区气泡形态一致。

### 5. 消息页输入区对齐工作区输入栏

- 卡片：无边框、`#ffffff` 底、`0 10px 30px rgba(15,23,42,.1)` 阴影、16px 圆角、`margin: 0 16px 16px`（footer padding 归零，margin 是唯一间距来源，避免叠加）。
- 布局：编辑器在上、操作行沉底（DOM 顺序书写，不再用 column-reverse）。
- 图标：表情/附件统一 lucide SVG 16px（`::before` 字形 display:none，SVG 显式 16×16），避免 iconfont 字形与 SVG 视觉尺寸不一致。
- 无发送按钮：回车发送（与工作区交互一致）。

## Risks / Trade-offs

- 亮色从 #fcfcfd → #ffffff、列表 #f9f9fb → #fcfcfc 是全局视觉变化，依赖旧灰底的截图/测试会失效。
- 顶栏 56→50px 影响 mac 标题栏拖拽区高度（仍 >= 系统最小值，实测可用）。
- 消息页卡片硬编码亮色 `#ffffff`（非 token）：为排除 token 解析问题的刻意选择，暗色由 `:host([data-theme=dark])` 覆盖回 `--ui-surface`。

## Migration Plan

1. token 定义 + 既有 token 引用切换（纯 CSS，可灰度自测）。
2. 顶栏高度/背景统一（markup 清死值）。
3. 气泡色统一（两处）。
4. 输入区重构（bridge + components.tsx）。
5. `vite build` + `tsc` 验证；产物 grep 确认规则级联顺序正确。
