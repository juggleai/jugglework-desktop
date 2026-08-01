# 模块：groupAdmin — 群管理员（增删查）

router 调用时 `module` 字段固定为 `groupAdmin`。

## Action 清单（3）

### `add` — 添加管理员

- 模块：`groupAdmin`
- HTTP：`POST /jim/groups/management/administrators/add`
- 文档：[`add.md`](./add.md)
- 源文件：im-docs `busserver/groups/groupadmins/addadmin.md`

### `del` — 移除管理员

- 模块：`groupAdmin`
- HTTP：`POST /jim/groups/management/administrators/del`
- 文档：[`del.md`](./del.md)
- 源文件：im-docs `busserver/groups/groupadmins/deladmin.md`

### `list` — 查询群管理员列表

- 模块：`groupAdmin`
- HTTP：`GET /jim/groups/management/administrators/list`
- 文档：[`list.md`](./list.md)
- 源文件：im-docs `busserver/groups/groupadmins/qrygroupmembers.md`
