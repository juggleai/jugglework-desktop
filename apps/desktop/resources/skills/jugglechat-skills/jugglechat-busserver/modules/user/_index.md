# 模块：user — 用户域（资料、设置、密码、登录状态）

router 调用时 `module` 字段固定为 `user`。

## Action 清单（10）

### `bindemail` — 绑定邮箱

- 模块：`user`
- HTTP：`POST /jim/users/bindemail`
- 文档：[`bindemail.md`](./bindemail.md)
- 源文件：im-docs `busserver/users/bindemail.md`

### `bindemailSend` — 绑定邮箱-发送邮件

- 模块：`user`
- HTTP：`POST /jim/users/bindemail/send`
- 文档：[`bindemailSend.md`](./bindemailSend.md)
- 源文件：im-docs `busserver/users/bindemail_send.md`

### `bindphone` — 绑定手机号

- 模块：`user`
- HTTP：`POST /jim/users/bindphone`
- 文档：[`bindphone.md`](./bindphone.md)
- 源文件：im-docs `busserver/users/bindphone.md`

### `bindphoneSend` — 绑定手机号-发送短信

- 模块：`user`
- HTTP：`POST /jim/users/bindphone/send`
- 文档：[`bindphoneSend.md`](./bindphoneSend.md)
- 源文件：im-docs `busserver/users/bindphone_send.md`

### `info` — 获取用户信息

- 模块：`user`
- HTTP：`GET /jim/users/info`
- 文档：[`info.md`](./info.md)
- 源文件：im-docs `busserver/users/qryuserinfo.md`

### `onlinestatus` — 查询在线状态

- 模块：`user`
- HTTP：`POST /jim/users/onlinestatus`
- 文档：[`onlinestatus.md`](./onlinestatus.md)
- 源文件：im-docs `busserver/users/onlinestatus.md`

### `search` — 搜索用户

- 模块：`user`
- HTTP：`POST /jim/users/search`
- 文档：[`search.md`](./search.md)
- 源文件：im-docs `busserver/users/search.md`

### `update` — 更新用户信息

- 模块：`user`
- HTTP：`POST /jim/users/update`
- 文档：[`update.md`](./update.md)
- 源文件：im-docs `busserver/users/upduserinfo.md`

### `updpass` — 更新密码

- 模块：`user`
- HTTP：`POST /jim/users/updpass`
- 文档：[`updpass.md`](./updpass.md)
- 源文件：im-docs `busserver/users/updpass.md`

### `updsettings` — 更新用户设置

- 模块：`user`
- HTTP：`POST /jim/users/updsettings`
- 文档：[`updsettings.md`](./updsettings.md)
- 源文件：im-docs `busserver/users/updusersettings.md`
