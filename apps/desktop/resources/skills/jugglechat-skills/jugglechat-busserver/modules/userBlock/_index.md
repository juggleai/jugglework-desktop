# 模块：userBlock — 用户黑名单（拉黑/移除/列表）

router 调用时 `module` 字段固定为 `userBlock`。

## Action 清单（3）

### `add` — 添加用户黑名单

- 模块：`userBlock`
- HTTP：`POST /jim/users/blockusers/add`
- 文档：[`add.md`](./add.md)
- 源文件：im-docs `busserver/users/blockusers/addblockusers.md`

### `del` — 移除用户黑名单

- 模块：`userBlock`
- HTTP：`POST /jim/users/blockusers/del`
- 文档：[`del.md`](./del.md)
- 源文件：im-docs `busserver/users/blockusers/delblockusers.md`

### `list` — 查询黑名单用户列表

- 模块：`userBlock`
- HTTP：`GET /jim/users/blockusers/list`
- 文档：[`list.md`](./list.md)
- 源文件：im-docs `busserver/users/blockusers/qryblockusers.md`
