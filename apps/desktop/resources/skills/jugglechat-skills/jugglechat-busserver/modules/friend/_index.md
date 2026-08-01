# 模块：friend — 好友域（申请/确认/删除/列表/搜索/备注）

router 调用时 `module` 字段固定为 `friend`。

## Action 清单（7）

### `applications` — 好友申请列表

- 模块：`friend`
- HTTP：`GET /jim/friends/applications`
- 文档：[`applications.md`](./applications.md)
- 源文件：im-docs `busserver/friends/friendapplications.md`

### `apply` — 申请添加好友

- 模块：`friend`
- HTTP：`POST /jim/friends/apply`
- 文档：[`apply.md`](./apply.md)
- 源文件：im-docs `busserver/friends/applyfriend.md`

### `confirm` — 处理好友申请

- 模块：`friend`
- HTTP：`POST /jim/friends/confirm`
- 文档：[`confirm.md`](./confirm.md)
- 源文件：im-docs `busserver/friends/ confirmfriend.md`

### `del` — 移除好友

- 模块：`friend`
- HTTP：`POST /jim/friends/del`
- 文档：[`del.md`](./del.md)
- 源文件：im-docs `busserver/friends/delfriend.md`

### `list` — 好友列表

- 模块：`friend`
- HTTP：`GET /jim/friends/list`
- 文档：[`list.md`](./list.md)
- 源文件：im-docs `busserver/friends/friendlist.md`

### `search` — 好友搜索

- 模块：`friend`
- HTTP：`POST /jim/friends/search`
- 文档：[`search.md`](./search.md)
- 源文件：im-docs `busserver/friends/friendsearch.md`

### `setdisplayname` — 添加好友备注

- 模块：`friend`
- HTTP：`POST /jim/friends/setdisplayname`
- 文档：[`setdisplayname.md`](./setdisplayname.md)
- 源文件：im-docs `busserver/friends/setdisplayname.md`
