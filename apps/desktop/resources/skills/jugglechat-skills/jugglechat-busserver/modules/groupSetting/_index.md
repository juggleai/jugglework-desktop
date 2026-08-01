# 模块：groupSetting — 群设置（群主/禁言/公告/昵称/加群验证/历史消息可见）

router 调用时 `module` 字段固定为 `groupSetting`。

## Action 清单（9）

### `chgowner` — 变更群主

- 模块：`groupSetting`
- HTTP：`POST /jim/groups/management/chgowner`
- 文档：[`chgowner.md`](./chgowner.md)
- 源文件：im-docs `busserver/groups/groupsetting/chgowner.md`

### `getannouncement` — 查询群公告

- 模块：`groupSetting`
- HTTP：`GET /jim/groups/getgrpannouncement`
- 文档：[`getannouncement.md`](./getannouncement.md)
- 源文件：im-docs `busserver/groups/groupsetting/getgrpannouncement.md`

### `setannouncement` — 设置群公告

- 模块：`groupSetting`
- HTTP：`POST /jim/groups/setgrpannouncement`
- 文档：[`setannouncement.md`](./setannouncement.md)
- 源文件：im-docs `busserver/groups/groupsetting/setgrpannouncement.md`

### `setdisplayname` — 设置群昵称

- 模块：`groupSetting`
- HTTP：`POST /jim/groups/setdisplayname`
- 文档：[`setdisplayname.md`](./setdisplayname.md)
- 源文件：im-docs `busserver/groups/groupsetting/setgrpdisplayname.md`

### `sethismsgvisible` — 新人入群是否可查看历史消息

- 模块：`groupSetting`
- HTTP：`POST /jim/groups/management/sethismsgvisible`
- 文档：[`sethismsgvisible.md`](./sethismsgvisible.md)
- 源文件：im-docs `busserver/groups/groupsetting/sethismsgvisible.md`

### `setmanageconf` — 设置群配置

- 模块：`groupSetting`
- HTTP：`POST /jim/groups/management/set`
- 文档：[`setmanageconf.md`](./setmanageconf.md)
- 源文件：im-docs `busserver/groups/groupsetting/setgrpmanageconf.md`

### `setmembersmute` — 设置群成员禁言

- 模块：`groupSetting`
- HTTP：`POST /jim/groups/management/setgrpmembersmute`
- 文档：[`setmembersmute.md`](./setmembersmute.md)
- 源文件：im-docs `busserver/groups/groupsetting/setgrpmembersmute.md`

### `setmute` — 设置群禁言

- 模块：`groupSetting`
- HTTP：`POST /jim/groups/management/setmute`
- 文档：[`setmute.md`](./setmute.md)
- 源文件：im-docs `busserver/groups/groupsetting/grpmute.md`

### `setverifytype` — 设置入群验证类型

- 模块：`groupSetting`
- HTTP：`POST /jim/groups/management/setgrpverifytype`
- 文档：[`setverifytype.md`](./setverifytype.md)
- 源文件：im-docs `busserver/groups/groupsetting/setgrpverifytype.md`
