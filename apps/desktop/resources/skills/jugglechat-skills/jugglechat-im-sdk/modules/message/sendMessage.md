---
name: jugglechat-im-sdk.message.sendMessage
module: message
action: sendMessage
title: 发送消息
source: message/msg_send/send.md
description: 发送消息类 action。`args.message.name` 必须是 MessageType 字符串（如 `jg:text`），不能用 MIME（如 `text/plain`）；`args.message.content` 形状取决于 `name`，见下一节「message.name 取值 + message.content 形状」。
---

# 发送消息

## 方法签名

```js
jim.sendMessage(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "message",
  "action": "sendMessage",
  "args": { /* 见下方参数表 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| message | Object | 是 |  | 消息对象 | 1.0.0 |
| message.conversationType | Number | 是 |  | [会话类型](../../../enum/web#conversation) | 1.0.0 |
| message.conversationId | String | 是 |  | 会话 Id，会话类型是 `PRIVATE` 时，会话 Id 是接收方的 userId，会话类型是 `GROUP` 时是群组 Id | 1.0.0 |
| message.name | String | 是 |  | 消息名称，根据实际需要发送不同消息类型，详细枚举请查看 [MessageType](../../../enum/web#message) | 1.0.0 **必须是 MessageType 字符串**，取值 `jg:text`、`jg:img`、`jg:voice`、`jg:video`、`jg:file`、`jg:merge`（详见下一节「message.name 取值 + message.content 形状」）。不能用 MIME 类型（如 `text/plain`）。 |
| message.content | Object | 是 |  | 消息内容，构建 `message.name` 消息 | 1.0.0 **字段形状完全取决于 `message.name`**，见下一节「message.name 取值 + message.content 形状」。 |
| message.referMsg | Object | 否 | 无 | 引用回复消息，参数要求是完整的 [Message](../../../msg/message) | 1.0.0 |
| message.mentionInfo | Object | 否 | 无 | conversationType 为 `GROUP` 时有效，设置 mentionInfo 表示本条消息是 @ 消息 | 1.0.0 |
| mentionInfo.mentionType | Number | 否 | 无 | @ 类型，详细可查看 [@ 消息枚举](../../../enum/web#mention) 说明 | 1.0.0 |
| mentionInfo.members | Array | 否 | 无 | @ 指定人列表，SDK 会优先根据 [@ 消息枚举](../../../enum/web#mention) 判断消息的 @ 类型 | 1.0.0 |
| lifeTime | Number | 否 | 0 | 消息的销毁时间段，必须大于 `0`, 单位 `ms`, 例如 60s: `1 * 60 * 1000` | 1.9.0 |
| lifeTimeAfterRead | Number | 否 | 0 | 消息的阅后即焚的时间段，必须大于 0, 单位 `ms`, 例如 60s: `1 * 60 * 1000` | 1.9.0 |

## message.name 取值 + message.content 形状

`args.message.name` 必须是下列值之一（与 im-docs `msg/*.mdx` 一致），`args.message.content` 的字段形状**完全取决于 `name` 的取值**。

### `jg:text` — 文本消息

**`content` 字段集合**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `content` | String | 是 | 文本消息内容，用户输入的文字、Emoji 表情等 |
| `extra` | String | 否 | 扩展字段，支持 JSON 字符串，设置后不可修改 |

**示例**：

```js
{
  content: "hello world",
  extra: '{"Priority":"P0"}'
}
```

### `jg:img` — 图片消息

**`content` 字段集合**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | String | 是 | 原图 URL |
| `thumbnail` | String | 否 | 缩略图 URL |
| `height` | Number | 否 | 图片高度 px |
| `width` | Number | 否 | 图片宽度 px |
| `size` | Number | 否 | 文件大小，字节 |
| `extra` | String | 否 | 扩展字段 JSON |

**示例**：

```js
{
  url: "https://example.com/avatar.png",
  thumbnail: "https://example.com/avatar_th.png",
  height: 640,
  width: 480,
  size: 100,
  extra: '{"Priority":"P0"}'
}
```

### `jg:voice` — 语音消息

**`content` 字段集合**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | String | 是 | 语音文件 URL |
| `type` | String | 否 | 格式如 aac/amr/mp3 |
| `duration` | Number | 否 | 时长，单位秒 |
| `extra` | String | 否 | 扩展字段 JSON |

**示例**：

```js
{
  url: "https://example.com/xxas.aac",
  type: "aac",
  duration: 40,
  extra: '{"Priority":"P0"}'
}
```

### `jg:video` — 小视频消息

**`content` 字段集合**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `snapshotUrl` | String | 是 | 首帧缩略图 URL |
| `url` | String | 是 | 视频文件 URL |
| `height` | Number | 否 | 视频高度 px |
| `width` | Number | 否 | 视频宽度 px |
| `size` | Number | 否 | 文件大小，字节 |
| `duration` | Number | 否 | 时长，单位秒 |
| `extra` | String | 否 | 扩展字段 JSON |

**示例**：

```js
{
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

**`content` 字段集合**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | String | 是 | 文件名 |
| `url` | String | 是 | 文件 URL |
| `size` | Number | 否 | 文件大小，字节 |
| `type` | String | 否 | 文件扩展名如 zip/pptx/pdf |
| `extra` | String | 否 | 扩展字段 JSON |

**示例**：

```js
{
  name: "demo.pptx",
  url: "https://example.com/demo.pptx",
  size: 1000,
  type: "pptx",
  extra: '{"Priority":"P0"}'
}
```

### `jg:merge` — 合并转发消息

**`content` 字段集合**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `title` | String | 是 | 合并消息标题 |
| `previewList` | Array | 是 | 预览列表，每项 { content, senderName } |
| `messageIdList` | Array | 是 | 被合并的消息 messageId 列表 |

**示例**：

```js
{
  title: "小 J 和 阿罗 的聊天记录",
  previewList: [{ content: "[文件]", senderName: "阿罗" }],
  messageIdList: ["ns7c4mzpsa4g7sb5", "ns6wbh472ayg7sb5"]
}
```

## callbacks 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| callbacks | Object | 否 |  | 回调对象 | 1.0.0 |
| callbacks.onbefore | Function | 否 |  | 消息发送前回调，此方法触发后会返回临时消息标识 `tid`，可向页面渲染消息，消息发送成功后台根据 `tid` 更新消息状态 | 1.0.0 |

## 成功回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| message | Object | 发送成功后返回带 `messageId` 和 `sentTime` 消息对象，消息结构请查看 [Message](../../../msg/message) | 1.0.0 |

## 失败回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| result | Object | 发送失败后会返回对象中包含 `tid` 属性信息，同时包含 `error` 信息，可以直接查看 `error.msg`，或者查看 [状态码](../../../status_code/web) | 1.0.0 |

## 示例代码

```js
let { ConversationType, MessageType, MentionType } = JIM;

let msg = {
  conversationType: 2,
  conversationId: 'groupid1',
  name: 'jg:text',
  content: {
    content: 'hello world'
  },
  mentionInfo: {
    mentionType: 1,
    members: [{ id: 'userid2' }]
  }
};

let callbacks = {
  onbefore: (message) => {
    // 渲染至页面，可通过 message.tid 做唯一标识
  }
};

jim.sendMessage(msg, callbacks).then((message) => {
  console.log(message);
}, (result) => {
  let { error, tid } = result;
  // 可根据 tid 修改消息发送失败的状态, Web 端消息失败仅在 SDK 内存中保存，刷新后将无法获取到发送失败的消息
  console.log(tid, error);
});
```

## 文档来源

- im-docs 源文件：`message/msg_send/send.md`