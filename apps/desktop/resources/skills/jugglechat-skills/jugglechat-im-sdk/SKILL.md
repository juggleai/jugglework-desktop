---
name: jugglechat-im-sdk
description: 通过 juggleim SDK 客户端方法操作 IM（消息/会话/聊天室/朋友圈/在线状态），统一通过本地 router HTTP 端点（127.0.0.1:17832/router）派发到 Renderer 端 JIM 客户端。覆盖发送/撤回/已读/拉历史/反应/收藏/置顶等所有 jim.* SDK 方法。**重要**：发消息时 `args.name` 必须是 SDK MessageType 字符串（如 `"jg:text"`），不能用 MIME（如 `"text/plain"`），且 `args.content` 形状取决于 `name`——详见 SKILL.md 「按 message.name 取 content 形状」。
---

> **【严格模式 · Strict Mode】**
>
> 本 skill 被命中时，**严格按下方文档字面执行**，禁止基于常识/猜测/相似 API 进行联想、补全、改写或"等价替换"：
>
> 1. **路由形态**：所有调用必须使用本文档规定的 `POST http://127.0.0.1:17832/router` 形态，`source` 必须是 `"jugglechat-im-sdk"` 或 `"jugglechat-busserver"`（取自本 skill 的 `name`），`module`/`action`/`args` 三件套必须严格匹配 `modules/<module>/<action>.md` 中的定义。**不要**改用直连 App Server HTTP、SDK 直调、curl、JIM CLI、GraphQL 等任何替代路径。
> 2. **参数形状**：`args` 的字段名、嵌套层级、必填项**完全**按文档表格填，**不要**根据其他 SDK 的命名习惯"翻译"或"对齐"。例如 `conversationType` 不能写成 `conversation_type` 或 `convType`；`messageId` 不能写成 `msg_id` 或 `id`。**注意 args 平铺规则（见「关键约定」）**：参数表中 `params.xxx` / `message.xxx` / `conversation.xxx` / `chatroom.xxx` / `tag.xxx` / `option.xxx` 这类前缀是 SDK 方法**形参名**，构造 router 的 `args` 时必须**剥掉该前缀、平铺到 `args` 顶层**（`args.conversationType`），**禁止**写成 `args.params.conversationType` 或 `args.message.content` 之类；表内真实嵌套字段（如 `mentionInfo.members`、`content.file`）保留嵌套层级。
> 3. **枚举值**：消息 `name`、`conversationType`、事件 `Event.X` 等枚举**必须**使用本文档「枚举值速查」一节的字面字符串/数字（如 `"jg:text"` 而非 `"text/plain"`、`PRIVATE=1` 而非 `"PRIVATE"`），**禁止**用同义 MIME、英文别名或 camelCase 变体。
> 4. **content 形状**：发送消息时 `args.content` 的字段集**完全取决于 `args.name`**——必须按「按 message.name 取 content 形状」表的对应行填，**禁止**跨 name 复用字段（例如文本消息用 `{ content: "..." }`，不能用 `{ text: "..." }`）。
> 5. **skill 未覆盖的能力**：当用户请求的功能在本 skill `modules/` 下没有对应 `module/action`（含显式标注「暂未提供」的接口），**直接告知用户"该功能当前客户端/服务端未提供"**，**不要**尝试用其他 skill 的能力、通用 HTTP、`execute_code` 子进程、或自有 SDK 知识去模拟。`jugleim-*` 调用在沙箱内 `import` 会直接抛 `connection not set`，这是预期行为，不是错误。
> 6. **冲突时的优先级**：用户口头表述与 SKILL.md 冲突时，**以 SKILL.md 为准**并向用户说明文档约束；若用户坚持按其表述执行，确认风险后再继续。**文档内部冲突时**（如「参数说明」表 vs「示例代码」vs router 示例），以「示例代码」中 `jim.<action>(...)` 实参对象的形状为最高权威，其次按「完整 router 调用示例」，最后才是参数表。
>
> 其他与本 skill 无关的问题（闲聊、通用知识、代码任务等）不受上述约束，按常规处理即可。


# JuggleChat IM SDK

这个 skill 把 JuggleIM Web/JS 客户端 SDK 的方法整理成结构化文档。**所有操作最终都通过 router HTTP 接口派发到 Renderer 端 SDK**（不直接连服务端 HTTP API）。

## 触发场景

- "发个文本消息给 xxx" / "撤回这条消息" / "把消息标记已读" / "把这条消息置顶"
- "看一下会话列表" / "建一个新会话" / "把会话删了" / "置顶某个会话" / "开启/关闭免打扰"
- "查一下用户在线状态" / "订阅某人的在线状态"
- "加入/退出聊天室" / "设置/读取聊天室属性"
- "发朋友圈" / "评论朋友圈" / "点赞"

## 触发 router

所有 action 都通过本地 loopback router 触发：

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",   // 必填：发起请求的 skill 名（router 用于路由校验）
  "module": "message",         // 业务模块
  "action": "sendMessage",     // SDK 驼峰方法名
  "args": { /* 透传给 jim.<action> 的参数字典（平铺，不带形参名前缀，见「关键约定·args 平铺规则」）*/ },
  "meta": { /* 可选附加元数据 */ },
  "timeoutMs": 30000           // 可选
}
```

响应：

```json
{ "ok": true,  "data": <SDK 返回> }
{ "ok": false, "error": { "code": "...", "message": "..." } }
```

## 模块清单

| module | 含义 | 数量 |
| --- | --- | --- |
| message | 消息收发/历史/反应/收藏/置顶/撤回/已读/搜索 | 28 |
| conversation | 会话/草稿/标签/未读/免打扰/置顶 | 21 |
| chatroom | 聊天室加入/退出/属性读写 | 7 |
| user_status | 在线状态查询/订阅 | 2 |
| moment | 朋友圈（增删查/评论/点赞） | 10 |
| user | 用户信息/群信息（仅部分有 JS 实现） | 0 |
| system | 系统方法（init/connect/on 等事件） | 7 |

详细文件见 `modules/<module>/<action>.md`。机器可读索引见 `_meta/actions.json`。

## 使用流程

1. **确认 module / action**：根据用户意图从 `modules/` 下选对应文件。
2. **构造 args**：严格按文件里的「参数说明」表格填字段；引用消息用 `messageId`，会话对象用 `conversationType` + `conversationId`。
3. **校验 args 形状**：构造完 `args` 后，与「示例代码」中 `jim.<action>(...)` 的实参对象逐字段比对，两者形状必须一致（参看「args 平铺规则」）。若不一致，以示例代码为准修正。
4. **POST /router**：`module`/`action`/`args` 三件套。
5. **处理响应**：`ok=true` 取 `data`；`ok=false` 把 `error.message` 反馈给用户。

## 关键约定

- **args 平铺规则（最重要）**：router 报文的 `args` 对象**直接等于** `jim.<action>` 方法的第一个参数对象，不透传、不包一层。文档参数表里 `params.xxx` / `message.xxx` / `conversation.xxx` / `chatroom.xxx` / `tag.xxx` / `option.xxx` 前缀只是 SDK 方法**形参名**（如 `jim.getMessages(params)` 里的 `params`），**不是 args 的嵌套层**；构造 args 时剥掉该前缀、把字段**平铺**到 `args` 顶层，例如：

  ```json
  // jim.getMessages({ conversationType, conversationId, count }) —— 正确
  "args": { "conversationType": 1, "conversationId": "userid2", "count": 20 }
  // 错误：包了一层 params
  "args": { "params": { "conversationType": 1 } }
  ```

  而参数表里**真实嵌套**的字段（如 `mentionInfo.members`、`content.file`、`messages[0].conversationId`、`reaction.key`）**保留嵌套层级**，对应 `args.mentionInfo.members`、`args.content.file` 等。判断准则：**以「示例代码」中 `jim.<action>(...)` 实参对象的形状为准**。

- `conversationType` 用 `JIM.ConversationType` 枚举（`PRIVATE=1`、`GROUP=2`、`CHATROOM=3` 等，详见 im-docs `enum/web#conversation`）。
- `name`（消息名）必须是 `MessageType` 枚举值字符串（`"jg:text"`、`"jg:img"` 等），**不能用 MIME 类型如 `"text/plain"`**。每个 `name` 对应的 `content` 字段形状见下方「按 message.name 取 content 形状」一节。
- 引用消息用 `referMsg: { messageId, ... }`。
- 监听事件（`jim.on(Event.X, ...)`）**不走 router**，需要 Renderer 端在启动时注册回调，agent 端只能触发 SDK 调用而不能订阅事件。
- 文档里标注「暂未提供」的接口，agent 应直接告知用户该功能当前客户端未支持。

## 枚举值速查

下表是示例代码里 `MessageType.X` / `ConversationType.X` / `Event.X` 等枚举对应的真实字符串/数字值。生成文档时已自动把示例代码里的枚举引用替换为字面量，**agent 直接复用示例代码里的字面量即可**，不必再 import `JIM` 的命名空间。

### MessageType — 消息类型 `name` 字段

| 名称 | 值 |
| --- | --- |
| `MessageType.TEXT` | `'jg:text'` |
| `MessageType.STREAM_TEXT` | `'jg:streamtext'` |
| `MessageType.STREAM_APPEND` | `'jg:streamappend'` |
| `MessageType.IMAGE` | `'jg:img'` |
| `MessageType.VOICE` | `'jg:voice'` |
| `MessageType.VIDEO` | `'jg:video'` |
| `MessageType.FILE` | `'jg:file'` |
| `MessageType.MERGE` | `'jg:merge'` |
| `MessageType.RECALL` | `'jg:recall'` |
| `MessageType.RECALL_INFO` | `'jg:recallinfo'` |
| `MessageType.READ_MSG` | `'jg:readntf'` |
| `MessageType.READ_GROUP_MSG` | `'jg:grpreadntf'` |
| `MessageType.MODIFY` | `'jg:modify'` |
| `MessageType.CLEAR_MSG` | `'jg:cleanmsg'` |
| `MessageType.CLEAR_UNREAD` | `'jg:clearunread'` |
| `MessageType.CALL_1V1_FINISHED` | `'jg:callfinishntf'` |
| `MessageType.COMMAND_DELETE_MSGS` | `'jg:delmsgs'` |
| `MessageType.COMMAND_UNDISTURB` | `'jg:undisturb'` |
| `MessageType.COMMAND_TOPCONVERS` | `'jg:topconvers'` |
| `MessageType.COMMAND_REMOVE_CONVERS` | `'jg:delconvers'` |
| `MessageType.COMMAND_ADD_CONVER` | `'jg:addconver'` |
| `MessageType.COMMAND_CLEAR_TOTALUNREAD` | `'jg:cleartotalunread'` |
| `MessageType.COMMAND_MARK_UNREAD` | `'jg:markunread'` |
| `MessageType.COMMAND_LOG_REPORT` | `'jg:logcmd'` |
| `MessageType.COMMAND_MSG_EXSET` | `'jg:msgexset'` |
| `MessageType.COMMAND_MSG_SET_TOP` | `'jg:topmsg'` |
| `MessageType.COMMAND_RTC_1V1_FINISHED` | `'jg:callfinishntf'` |
| `MessageType.COMMAND_STATUS_CHANGED` | `'jg:onlinechg'` |
| `MessageType.COMMAND_CONVERSATION_TAG_CREATE` | `'jg:createconvertags'` |
| `MessageType.COMMAND_CONVERSATION_TAG_REMOVE` | `'jg:delconvertags'` |
| `MessageType.COMMAND_ADD_CONVERSATION_TO_TAG` | `'jg:tagaddconvers'` |
| `MessageType.COMMAND_REMOVE_CONVERS_FROM_TAG` | `'jg:tagdelconvers'` |
| `MessageType.CLIENT_REMOVE_MSGS` | `'jgc:removemsgs'` |
| `MessageType.CLIENT_REMOVE_CONVERS` | `'jgc:removeconvers'` |
| `MessageType.CLIENT_MARK_UNREAD` | `'jgc:markunread'` |

### ConversationType — 会话类型 `conversationType` 字段

| 名称 | 值 |
| --- | --- |
| `ConversationType.PRIVATE` | `1` |
| `ConversationType.GROUP` | `2` |
| `ConversationType.CHATROOM` | `3` |
| `ConversationType.SYSTEM` | `4` |
| `ConversationType.PUBLICH` | `7` |
| `ConversationType.SUBSTATUS` | `8` |

### ConversationOrder — 会话分页方向 `order` 字段

| 名称 | 值 |
| --- | --- |
| `ConversationOrder.FORWARD` | `0` |
| `ConversationOrder.BACKWARD` | `1` |

### MessageOrder — 消息分页方向 `order` 字段

| 名称 | 值 |
| --- | --- |
| `MessageOrder.FORWARD` | `1` |
| `MessageOrder.BACKWARD` | `0` |

### MentionType — @ 消息类型 `mentionType` 字段

| 名称 | 值 |
| --- | --- |
| `MentionType.ALL` | `1` |
| `MentionType.SOMEONE` | `2` |
| `MentionType.ALL_SOMEONE` | `3` |

### UndisturbType — 免打扰设置 `type` 字段

| 名称 | 值 |
| --- | --- |
| `UndisturbType.DISTURB` | `1` |
| `UndisturbType.UNDISTURB` | `0` |

### UnreadTag — 会话未读标记

| 名称 | 值 |
| --- | --- |
| `UnreadTag.READ` | `0` |
| `UnreadTag.UNREAD` | `1` |

### FileType — 文件类型

| 名称 | 值 |
| --- | --- |
| `FileType.IMAGE` | `1` |
| `FileType.AUDIO` | `2` |
| `FileType.VIDEO` | `3` |
| `FileType.FILE` | `4` |

### ConversationTagType — 会话标签类型

| 名称 | 值 |
| --- | --- |
| `ConversationTagType.USER` | `0` |
| `ConversationTagType.SYSNTEM` | `1` |
| `ConversationTagType.GLOBAL` | `2` |

### Event — 事件订阅（仅 Renderer 端注册，agent 端不可用）

| 名称 | 值 |
| --- | --- |
| `Event.STATE_CHANGED` | `'state_changed'` |
| `Event.MESSAGE_RECEIVED` | `'message_received'` |
| `Event.MESSAGE_RECALLED` | `'message_recalled'` |
| `Event.MESSAGE_UPDATED` | `'message_updated'` |
| `Event.MESSAGE_SET_TOP` | `'message_set_top'` |
| `Event.MESSAGE_READ` | `'message_read'` |
| `Event.MESSAGE_REMOVED` | `'message_removed'` |
| `Event.MESSAGE_CLEAN` | `'message_clean'` |
| `Event.MESSAGE_CLEAN_SOMEONE` | `'message_clean_someone'` |
| `Event.MESSAGE_REACTION_CHANGED` | `'message_reaction_changed'` |
| `Event.TAG_CREATED` | `'tag_created'` |
| `Event.TAG_ADDED` | `'tag_added'` |
| `Event.TAG_REMOVED` | `'tag_removed'` |
| `Event.TAG_CHANGED` | `'tag_changed'` |
| `Event.TAG_CONVERSATION_ADDED` | `'tag_conversation_added'` |
| `Event.TAG_CONVERSATION_REMOVED` | `'tag_conversation_removed'` |
| `Event.CONVERSATION_SYNC_FINISHED` | `'conversation_sync_finished'` |
| `Event.CONVERSATION_UNDISTURBED` | `'conversation_undisturb'` |
| `Event.CONVERSATION_TOP` | `'conversation_top'` |
| `Event.CONVERSATION_CLEARUNREAD` | `'conversation_clearunead'` |
| `Event.CLEAR_TOTAL_UNREADCOUNT` | `'conversation_total_unreadcount'` |
| `Event.CONVERSATION_CHANGED` | `'conversation_changed'` |
| `Event.CONVERSATION_ADDED` | `'conversation_added'` |
| `Event.CONVERSATION_REMOVED` | `'conversation_removed'` |
| `Event.CHATROOM_ATTRIBUTE_UPDATED` | `'chatroom_attr_updated'` |
| `Event.CHATROOM_ATTRIBUTE_DELETED` | `'chatroom_attr_deleted'` |
| `Event.CHATROOM_DESTROYED` | `'chatroom_destroyed'` |
| `Event.CHATROOM_USER_QUIT` | `'chatroom_user_quit'` |
| `Event.CHATROOM_USER_KICKED` | `'chatroom_user_kicked'` |
| `Event.RTC_ROOM_EVENT` | `'rtc_room_event'` |
| `Event.RTC_INVITE_EVENT` | `'rtc_invite_event'` |
| `Event.RTC_FINISHED_1V1_EVENT` | `'rtc_finished_1v1_event'` |
| `Event.STREAM_APPENDED` | `'stream_appended'` |
| `Event.STREAM_COMPLETED` | `'stream_completed'` |
| `Event.USER_STATUS_CHANGED` | `'user_status_changed'` |
| `Event.CHATROOM_USER_REJOINED` | `'chatroom_user_rejoined'` |
| `Event.CHATROOM_USER_JOINED` | `'chatroom_user_joined'` |
| `Event.CHATROOM_MEMBER_JOINED` | `'chatroom_member_joined'` |
| `Event.CHATROOM_MEMBER_QUIT` | `'chatroom_member_quit'` |

### ConnectionState — 连接状态（事件回调里的 state 值）

| 名称 | 值 |
| --- | --- |
| `ConnectionState.CONNECTED` | `0` |
| `ConnectionState.CONNECTING` | `1` |
| `ConnectionState.DISCONNECTED` | `2` |
| `ConnectionState.CONNECT_FAILED` | `3` |
| `ConnectionState.DB_OPENED` | `4` |
| `ConnectionState.DB_CLOSED` | `5` |
| `ConnectionState.RECONNECTING` | `6` |


## 按 message.name 取 content 形状

调用 `sendMessage` / `sendMassMessage` / `sendMergeMessage` 等发送类接口时，`message.content` 字段的形状**完全取决于 `message.name` 的值**。下表是 im-docs `msg/*.mdx` 里规定的字段集合（已与 renderer bundle 中 SDK 实现核对）。

### `jg:text` — 文本消息

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `content` | String | 是 | 文本消息内容，用户输入的文字、Emoji 表情等 |
| `extra` | String | 否 | 扩展字段，支持 JSON 字符串，设置后不可修改 |

```js
let {
  content: "hello world",
  extra: '{"Priority":"P0"}'
}
```

### `jg:img` — 图片消息

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | String | 是 | 原图 URL |
| `thumbnail` | String | 否 | 缩略图 URL |
| `height` | Number | 否 | 图片高度 px |
| `width` | Number | 否 | 图片宽度 px |
| `size` | Number | 否 | 文件大小，字节 |
| `extra` | String | 否 | 扩展字段 JSON |

```js
let {
  url: "https://example.com/avatar.png",
  thumbnail: "https://example.com/avatar_th.png",
  height: 640,
  width: 480,
  size: 100,
  extra: '{"Priority":"P0"}'
}
```

### `jg:voice` — 语音消息

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | String | 是 | 语音文件 URL |
| `type` | String | 否 | 格式如 aac/amr/mp3 |
| `duration` | Number | 否 | 时长，单位秒 |
| `extra` | String | 否 | 扩展字段 JSON |

```js
let {
  url: "https://example.com/xxas.aac",
  type: "aac",
  duration: 40,
  extra: '{"Priority":"P0"}'
}
```

### `jg:video` — 小视频消息

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `snapshotUrl` | String | 是 | 首帧缩略图 URL |
| `url` | String | 是 | 视频文件 URL |
| `height` | Number | 否 | 视频高度 px |
| `width` | Number | 否 | 视频宽度 px |
| `size` | Number | 否 | 文件大小，字节 |
| `duration` | Number | 否 | 时长，单位秒 |
| `extra` | String | 否 | 扩展字段 JSON |

```js
let {
  snapshotUrl: "https://example.com/snapshot.png",
  url: "https://example.com/demo.mp4",
  height: 500,
  width: 800,
  size: 2000,
  duration: 48,
  extra: '{"Priority":"P0"}'
}
```

### `jg:file` — 文件消息

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 文件名 |
| `url` | String | 是 | 文件 URL |
| `size` | Number | 否 | 文件大小，字节 |
| `type` | String | 否 | 文件扩展名如 zip/pptx/pdf |
| `extra` | String | 否 | 扩展字段 JSON |

```js
let {
  name: "demo.pptx",
  url: "https://example.com/demo.pptx",
  size: 1000,
  type: "pptx",
  extra: '{"Priority":"P0"}'
}
```

### `jg:merge` — 合并转发消息

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `title` | String | 是 | 合并消息标题 |
| `previewList` | Array | 是 | 预览列表，每项 { content, senderName } |
| `messageIdList` | Array | 是 | 被合并的消息 messageId 列表 |

```js
let {
  title: "小 J 和 阿罗 的聊天记录",
  previewList: [{ content: "[文件]", senderName: "阿罗" }],
  messageIdList: ["ns7c4mzpsa4g7sb5", "ns6wbh472ayg7sb5"]
}
```


> **重要**：构造 `args.content` 时务必按上表选对应 `name` 的字段名。例如文本消息的 `content` 字段名是 `content`（`{ content: "hello" }`），不是 `text`（`{ text: "hello" }`）。`name` 也必须是 SDK 字符串枚举值，不能用 MIME（不要用 `"text/plain"`）。

## 数据模型

消息体 / 会话体 / 文件消息结构等数据模型放在 `modules/<module>/_<name>.md`，**不直接对应 router action**，仅作参数构造参考。
