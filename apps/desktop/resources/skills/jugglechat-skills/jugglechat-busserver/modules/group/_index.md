# 模块：group — 群组管理（建群/解散/查我的群/更新群）

router 调用时 `module` 字段固定为 `group`。

## Action 清单（6）

### `create` — 创建群组

- 模块：`group`
- HTTP：`POST /jim/groups/create`
- 文档：[`create.md`](./create.md)
- 源文件：im-docs `busserver/groups/groupmanage/creategroup.md`

### `dissolve` — 解散群组

- 模块：`group`
- HTTP：`POST /jim/groups/dissolve`
- 文档：[`dissolve.md`](./dissolve.md)
- 源文件：im-docs `busserver/groups/groupmanage/dissolvegroup.md`

### `info` — 查询群信息

- 模块：`group`
- HTTP：`GET /jim/groups/info`
- 文档：[`info.md`](./info.md)
- 源文件：im-docs `busserver/groups/groupmanage/qrygroupinfo.md`

### `list` — 查询加入的群列表

- 模块：`group`
- HTTP：`GET /jim/groups/mygroups`
- 文档：[`list.md`](./list.md)
- 源文件：im-docs `busserver/groups/groupmanage/qrymygroups.md`

### `search` — 搜索加入的群

- 模块：`group`
- HTTP：`POST /jim/groups/mygroups/search`
- 文档：[`search.md`](./search.md)
- 源文件：im-docs `busserver/groups/groupmanage/searchmygroups.md`

### `update` — 更新群组信息

- 模块：`group`
- HTTP：`POST /jim/groups/update`
- 文档：[`update.md`](./update.md)
- 源文件：im-docs `busserver/groups/groupmanage/updategroup.md`
