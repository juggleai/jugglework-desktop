# Tasks

## 1. Token 基建

- [x] `apps/app/src/app/index.css`：`:root` 定义 `--app-page-bg: #ffffff`、`--app-list-bg: #fcfcfc`、`--app-topbar-height: 50px`、`--app-msg-sent-bg: #f3f3f4`，带 TIPS 注释
- [x] 既有 token（`--background`、`--sidebar`、`--dls-surface/sidebar/app-bg/background/canvas`）改为引用语义 token
- [x] `[data-theme="dark"]` 与 `.dark` 双块补暗色映射（页面 slate-1/列表 slate-2/气泡 slate-3）

## 2. 顶栏统一（50px + 纯白背景）

- [x] `styles/custom.css`：`.session-header`/`.session-panel-header` 高度+背景引用 token
- [x] `session-page.tsx`：移除 markup 死值 `h-10`
- [x] `automation-page.tsx` 两处 `h-14` → `h-[var(--app-topbar-height)]`；`bg-background/95` → `bg-background`
- [x] `settings-shell.tsx` 主顶栏同上
- [x] 消息页会话顶栏（bridge）：height/min-height/flex-basis 三件套引用 token，背景 `--app-page-bg`；dropzone `--chat-head-height` 同步
- [x] 通讯录页内容顶栏（bridge 既有规则）：三件套引用 token（修复 flex-basis 顶回 56px 的问题）

## 3. 发送气泡统一

- [x] `message-list.tsx`：气泡 `bg-muted` → `bg-[var(--app-msg-sent-bg)]`
- [x] bridge：覆盖上游 `.tyn-root .outgoing .tyn-reply-*` 四类元素背景为 token，清除 1px 描边

## 4. 消息页输入区重构

- [x] `components.tsx`：DOM 重排（编辑器在上/操作行沉底）、去头像与 @id 副行、去发送按钮、附件按钮改 lucide Paperclip
- [x] bridge：卡片（无边框/白底/阴影/圆角 16/margin 0 16px 16px）、footer padding 归零、表情+附件统一 16px SVG、编辑区与操作行 padding

## 5. 验证

- [x] `npx vite build` 通过；产物 grep 确认 token 定义、各覆盖规则级联顺序正确
- [x] `npm run typecheck` 通过
