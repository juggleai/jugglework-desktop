# 模块：groupMember — 群成员（拉人/踢人/退群/列表/搜索/申请/审批）

router 调用时 `module` 字段固定为 `groupMember`。

## Action 清单（9）

### `applications` — 入群申请列表

- 模块：`groupMember`
- HTTP：`GET /jim/groups/grpapplications`
- 文档：[`applications.md`](./applications.md)
- 源文件：im-docs `busserver/groups/membermanage/grpapplications.md`

### `apply` — 申请入群

- 模块：`groupMember`
- HTTP：`POST /jim/groups/apply`
- 文档：[`apply.md`](./apply.md)
- 源文件：im-docs `busserver/groups/membermanage/memberapply.md`

### `check` — 检查是否群成员

- 模块：`groupMember`
- HTTP：`POST /jim/groups/members/check`
- 文档：[`check.md`](./check.md)
- 源文件：im-docs `busserver/groups/membermanage/membercheck.md`

### `confirm` — 审批邀请入群申请

- 模块：`groupMember`
- HTTP：`POST /jim/groups/grpapplications/confirm`
- 文档：[`confirm.md`](./confirm.md)
- 源文件：im-docs `busserver/groups/membermanage/confirmapplications.md`

### `del` — 移除群成员

- 模块：`groupMember`
- HTTP：`POST /jim/groups/members/del`
- 文档：[`del.md`](./del.md)
- 源文件：im-docs `busserver/groups/membermanage/delmember.md`

### `invite` — 邀请入群

- 模块：`groupMember`
- HTTP：`POST /jim/groups/invite`
- 文档：[`invite.md`](./invite.md)
- 源文件：im-docs `busserver/groups/membermanage/invitemember.md`

### `list` — 查询群成员列表

- 模块：`groupMember`
- HTTP：`GET /jim/groups/members/list`
- 文档：[`list.md`](./list.md)
- 源文件：im-docs `busserver/groups/membermanage/qrygroupmembers.md`

### `quit` — 退出群组

- 模块：`groupMember`
- HTTP：`POST /jim/groups/quit`
- 文档：[`quit.md`](./quit.md)
- 源文件：im-docs `busserver/groups/membermanage/quitgroup.md`

### `search` — 搜索群成员

- 模块：`groupMember`
- HTTP：`POST /jim/groups/members/search`
- 文档：[`search.md`](./search.md)
- 源文件：im-docs `busserver/groups/membermanage/membersearch.md`
