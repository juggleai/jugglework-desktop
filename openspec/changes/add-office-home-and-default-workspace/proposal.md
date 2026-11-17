# Change: Office-oriented new-task home and a default office workspace

## Why
北数Work targets everyday office work. An empty new task currently shows a bare transcript and a bottom-docked composer, and a fresh install has no workspace, so the user lands on the welcome flow before they can ask anything.

## What Changes
- Show a home on an empty, idle session: the bundled animated Juggle robot (`apps/app/public/pets/juggle/typing.gif`) and the title "北数Work，来帮你" horizontally centered at about 38% of the content height, with one row of office scenario chips and the composer at the bottom of the window (4% of the viewport height above the bottom edge). When the window is too short to center the title without touching the chips, the title falls back to normal flow above them.
- Scenario chips (创作文档, 制作PPT, 分析数据, 深度研究, 策划方案) fill an editable prompt template into the composer and never send it. The 定时任务 chip opens the scheduled-tasks page and is hidden when local automations are disabled.
- Below the composer, show a workspace selector and the permission selector. While the home is visible, the permission selector moves out of the composer so it is shown once.
- When no session is selected, the workspace page shows the same home instead of the "请选择或新建一个会话以开始。" starter cards (编辑 CSV, 浏览网页, 连接扩展). Its composer is an entry point: Enter or the send button creates a task with the typed text as its draft, and a scenario chip creates a task with that template. Nothing is sent automatically. The "connect a model provider" card stays below it when no model is connected.
- The home returns to the normal chat layout as soon as the session has a message, is sending, streaming, preparing, has queued drafts, or shows an error. The split-view secondary pane never shows the home.
- While a newly created session snapshot is loading, do not interpret the temporary empty message array as a real empty transcript: keep the transcript blank for the short loading grace period, show the delayed loading card only after that grace period, and never mount the legacy CSV/browser/extension starter cards when the office home is enabled.
- When the desktop shell starts with no local workspace and the default office workspace has never been provisioned, it creates the local workspace `~/Documents/北数Work/日常办公` and selects it. Provisioning is tracked by `defaultWorkspaceProvisioned` in the workspace state file: an already-populated state file is treated as provisioned, a state file written as an empty list before provisioning (older builds, interrupted provisioning, or a failed first attempt) still provisions once, and the workspace is not recreated after the user removes every workspace. `JUGGLEWORK_DESKTOP_DISABLE_DEFAULT_WORKSPACE=1` turns this off; `JUGGLEWORK_DEFAULT_WORKSPACE_ROOT` overrides the directory.

## Impact
- New specs: `session-office-home`, `desktop-default-workspace`
- Affected app areas: session surface, composer, session route, i18n (en, zh)
- Affected desktop areas: Electron workspace store
