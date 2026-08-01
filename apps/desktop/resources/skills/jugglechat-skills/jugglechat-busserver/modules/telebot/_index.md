# 模块：telebot — Telegram Bot（增删查）

router 调用时 `module` 字段固定为 `telebot`。

## Action 清单（3）

### `add` — 添加Bot

- 模块：`telebot`
- HTTP：`POST /jim/telegrambots/add`
- 文档：[`add.md`](./add.md)
- 源文件：im-docs `busserver/telebots/botadd.md`

### `del` — 移除Bot

- 模块：`telebot`
- HTTP：`POST /jim/telegrambots/batchdel`
- 文档：[`del.md`](./del.md)
- 源文件：im-docs `busserver/telebots/botdel.md`

### `list` — Bot列表

- 模块：`telebot`
- HTTP：`GET /jim/telegrambots/list`
- 文档：[`list.md`](./list.md)
- 源文件：im-docs `busserver/telebots/botlist.md`
