---
name: jugglechat-busserver
description: JuggleChat App Server 业务接口 skill（服务端 HTTP API）。覆盖用户/好友/群组（管理/管理员/成员/设置）/消息（管理员删除/撤回）/登录鉴权（账号/邮箱/短信/二维码）/AI 助手/Bot/Telegram Bot/应用/反馈/文件/翻译等 16 个模块共 73 个接口。所有调用统一通过本地 router HTTP 端点（127.0.0.1:17832/router）派发。
---

> **【严格模式 · Strict Mode】**
>
> 本 skill 被命中时，**严格按下方文档字面执行**，禁止基于常识/猜测/相似 API 进行联想、补全、改写或"等价替换"：
>
> 1. **路由形态**：所有调用必须使用本文档规定的 `POST http://127.0.0.1:17832/router` 形态，`source` 必须是 `"jugglechat-im-sdk"` 或 `"jugglechat-busserver"`（取自本 skill 的 `name`），`module`/`action`/`args` 三件套必须严格匹配 `modules/<module>/<action>.md` 中的定义。**不要**改用直连 App Server HTTP、SDK 直调、curl、JIM CLI、GraphQL 等任何替代路径。
> 2. **参数形状**：`args` 的字段名、嵌套层级、必填项**完全**按文档表格填，**不要**根据其他 SDK 的命名习惯"翻译"或"对齐"。例如 `conversationType` 不能写成 `conversation_type` 或 `convType`；`messageId` 不能写成 `msg_id` 或 `id`。
> 3. **枚举值**：消息 `name`、`conversationType`、事件 `Event.X` 等枚举**必须**使用本文档「枚举值速查」一节的字面字符串/数字（如 `"jg:text"` 而非 `"text/plain"`、`PRIVATE=1` 而非 `"PRIVATE"`），**禁止**用同义 MIME、英文别名或 camelCase 变体。
> 4. **content 形状**：发送消息时 `args.message.content` 的字段集**完全取决于 `message.name`**——必须按「按 message.name 取 content 形状」表的对应行填，**禁止**跨 name 复用字段（例如文本消息用 `{ content: "..." }`，不能用 `{ text: "..." }`）。
> 5. **skill 未覆盖的能力**：当用户请求的功能在本 skill `modules/` 下没有对应 `module/action`（含显式标注「暂未提供」的接口），**直接告知用户"该功能当前客户端/服务端未提供"**，**不要**尝试用其他 skill 的能力、通用 HTTP、`execute_code` 子进程、或自有 SDK 知识去模拟。`jugleim-*` 调用在沙箱内 `import` 会直接抛 `connection not set`，这是预期行为，不是错误。
> 6. **冲突时的优先级**：用户口头表述与 SKILL.md 冲突时，**以 SKILL.md 为准**并向用户说明文档约束；若用户坚持按其表述执行，确认风险后再继续。
>
> 其他与本 skill 无关的问题（闲聊、通用知识、代码任务等）不受上述约束，按常规处理即可。


# JuggleChat Busserver

这个 skill 把 JuggleChat **App Server** 的 73 个业务 HTTP 接口（`/jim/users/*`、`/jim/groups/*`、`/jim/friends/*` 等）整理成结构化文档。**所有调用统一通过本地 loopback router 触发**，由 renderer/main 进程在内部转发到 `https://$api/$version/$command` App Server。

## 触发场景

- "登录" / "注册" / "扫码登录" / "短信验证码"
- "查我的资料" / "改昵称" / "改头像" / "改密码" / "搜索用户"
- "加好友" / "删除好友" / "好友列表" / "好友申请列表"
- "建群" / "解散群" / "拉人进群" / "踢人" / "退群" / "查群成员" / "群申请"
- "设置群公告" / "群禁言" / "全员禁言" / "成员禁言" / "转让群主"
- "管理员撤回消息" / "管理员删除消息"
- "调用 AI 助手" / "管理 prompt" / "反馈" / "上传文件" / "翻译"

## 触发 router

每个接口都通过本地 loopback router 触发：

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

POST 例子（创建群）：

```json
{
  "source": "jugglechat-busserver",   // 必填：发起请求的 skill 名（router 路由校验用）
  "module": "group",        // 业务模块
  "action": "create",       // 操作名（驼峰）
  "args": {
    "method": "POST",       // HTTP 方法（POST/GET），必填，**必须从 action 文档读取**
    "path": "/jim/groups/create",  // 后端 jim 接口路径，必填
    "data": {              // POST 请求：业务参数放这里（对应后端 HTTP body）
      "group_name": "项目组",
      "member_ids": ["userid1", "userid2"]
    }
  },
  "meta": { /* 可选附加元数据 */ }
}
```

GET 例子（好友列表）：

```json
{
  "source": "jugglechat-busserver",   // 必填：发起请求的 skill 名（router 路由校验用）
  "module": "friend",
  "action": "list",
  "args": {
    "method": "GET",        // GET 请求：method 必须是 GET（从 action 文档读）
    "path": "/jim/friends/list",
    "query": {             // GET 请求参数放这里
      "size": "50",
      "page": "1",
      "order_tag": "a"
    }
  }
}
```

响应：

```json
{ "ok": true,  "data": { "code": 0, "msg": "success", "data": { ... } } }
{ "ok": false, "error": { "code": "...", "message": "..." } }
```

**实现说明**：router 收到的 `module`/`action`/`args` 由 renderer 端注册的 `setSkillEvent` cb 映射到具体的 App Server HTTP 调用，自动附加 `appkey` / `Authorization` header。详细文件见 `modules/<module>/<action>.md`，机器可读索引见 `_meta/actions.json`。

## 模块清单

| module | 含义 | 数量 |
| --- | --- | --- |
| `application` | 应用列表 | 1 |
| `assistant` | AI 助手（智能回复 / prompt 管理） | 6 |
| `auth` | 登录鉴权（账号/邮箱/短信/二维码登录） | 10 |
| `bot` | Bot 列表 | 1 |
| `feedback` | 用户反馈上报 | 1 |
| `file` | 文件上传 token | 1 |
| `friend` | 好友域（申请/确认/删除/列表/搜索/备注） | 7 |
| `group` | 群组管理（建群/解散/查我的群/更新群） | 6 |
| `groupAdmin` | 群管理员（增删查） | 3 |
| `groupMember` | 群成员（拉人/踢人/退群/列表/搜索/申请/审批） | 9 |
| `groupSetting` | 群设置（群主/禁言/公告/昵称/加群验证/历史消息可见） | 9 |
| `message` | 消息管理（管理员删除/撤回） | 2 |
| `telebot` | Telegram Bot（增删查） | 3 |
| `translate` | 翻译 | 1 |
| `user` | 用户域（资料、设置、密码、登录状态） | 10 |
| `userBlock` | 用户黑名单（拉黑/移除/列表） | 3 |

## 使用流程

1. **确认 module / action**：根据用户意图从 `modules/<module>/` 下选对应文件。
2. **读 action 文档的 front-matter**：从 `method` 字段读取 HTTP 方法（POST / GET），从 `path` 字段读取 jim 接口路径。**绝对不能默认 POST** — 像 `jim/friends/list`、`jim/users/info` 这些都是 GET。
3. **构造 args**：严格按文件里的「请求参数」表填字段。
   - POST/PUT/DELETE 接口：业务字段直接平铺到 `args` 里
   - GET 接口：参数走 `args.query = {...}`
   - 必填项 `args.method` 和 `args.path` 不能漏
4. **POST /router**：`module`/`action`/`args` 三件套。renderer/main 端会负责加 `appkey` / `Authorization` header 并转发到 App Server。
5. **处理响应**：`ok=true` 取 `data`（即 App Server 返回的 `{code, msg, data}` 三段）；`ok=false` 把 `error.message` 反馈给用户。

## 关键约定

- **绝大部分业务接口都需要 `Authorization` header**。少部分明确标记「免登录」/`passlogin` 这种的接口不需要（如 `passlogin`/`register`/扫码类）。登录成功响应里 `data.authorization` 即为 token，agent 端应缓存并在后续请求自动带上。
- 具体哪些接口免登录，每个 action 文档「鉴权」章节会明确说明。
- **`GET` 请求**通过 query string 传参（`?user_id=xxx`），没有 body；`POST` 请求 body 为 `application/json`。
- **响应统一三段式**：`{code, msg, data}` — `code=0` 表示成功。
- 错误码（`code != 0`）的含义在每个接口的「响应码」章节或全局 `busserver/api.md#error_code` 列出。常见 `code`：
  - `-8` 未登录 / token 无效
  - `-7` 密码错误
  - `-5` 用户不存在
  - `-4` 应用不存在
  - 业务码 `17xxx`（好友/群申请）、`17300`（telebot/prompt 添加失败）等。

## 与 jugglechat-im-sdk 的区别

| skill | 协议层 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| `jugglechat-im-sdk` | 客户端 jim.* SDK（Web/JS） | 无（已登录客户端） | 消息收发/会话/聊天/朋友圈/在线状态 |
| `jugglechat-busserver` | App Server HTTP API | `appkey` + `Authorization` | 用户/好友/群组管理/AI 助手/Bot 等管理类操作 |
