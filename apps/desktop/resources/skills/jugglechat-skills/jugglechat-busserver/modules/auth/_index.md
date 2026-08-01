# 模块：auth — 登录鉴权（账号/邮箱/短信/二维码登录）

router 调用时 `module` 字段固定为 `auth`。

## Action 清单（10）

### `checkqr` — 检查扫码状态

- 模块：`auth`
- HTTP：`POST /jim/qrcode/check`
- 文档：[`checkqr.md`](./checkqr.md)
- 源文件：im-docs `busserver/login/checkqr.md`

### `confirmqr` — 扫码确认

- 模块：`auth`
- HTTP：`POST /jim/qrcode/confirm`
- 文档：[`confirmqr.md`](./confirmqr.md)
- 源文件：im-docs `busserver/login/confirmqr.md`

### `emaillogin` — 邮箱登录

- 模块：`auth`
- HTTP：`POST /jim/email/login`
- 文档：[`emaillogin.md`](./emaillogin.md)
- 源文件：im-docs `busserver/login/emaillogin.md`

### `emailsend` — 邮箱验证码

- 模块：`auth`
- HTTP：`POST /jim/email/send`
- 文档：[`emailsend.md`](./emailsend.md)
- 源文件：im-docs `busserver/login/emailsend.md`

### `getqr` — 登录二维码

- 模块：`auth`
- HTTP：`GET /jim/login/qrcode`
- 文档：[`getqr.md`](./getqr.md)
- 源文件：im-docs `busserver/login/getloginqr.md`

### `login` — 登录

- 模块：`auth`
- HTTP：`POST /jim/login`
- 文档：[`login.md`](./login.md)
- 源文件：im-docs `busserver/login/login.md`

### `passlogin` — 账户密码登录

- 模块：`auth`
- HTTP：`POST /jim/login`
- 文档：[`passlogin.md`](./passlogin.md)
- 源文件：im-docs `busserver/login/passlogin.md`

### `register` — 账号注册

- 模块：`auth`
- HTTP：`POST /jim/register`
- 文档：[`register.md`](./register.md)
- 源文件：im-docs `busserver/login/register.md`

### `smslogin` — 短验登录

- 模块：`auth`
- HTTP：`POST /jim/sms/login`
- 文档：[`smslogin.md`](./smslogin.md)
- 源文件：im-docs `busserver/login/smslogin.md`

### `smssend` — 短信验证码

- 模块：`auth`
- HTTP：`POST /jim/sms/send`
- 文档：[`smssend.md`](./smssend.md)
- 源文件：im-docs `busserver/login/smssend.md`
