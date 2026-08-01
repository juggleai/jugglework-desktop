# 模块：message — 消息管理（管理员删除/撤回）

router 调用时 `module` 字段固定为 `message`。

## Action 清单（2）

### `del` — 管理员删除消息

- 模块：`message`
- HTTP：`POST /jim/messages/del`
- 文档：[`del.md`](./del.md)
- 源文件：im-docs `busserver/msgopt/delmsgs.md`

### `recall` — 管理员撤回消息

- 模块：`message`
- HTTP：`POST /jim/messages/recall`
- 文档：[`recall.md`](./recall.md)
- 源文件：im-docs `busserver/msgopt/recallmsg.md`
