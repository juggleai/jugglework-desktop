---
name: jugglechat-im-sdk.message.sendFileMessage
module: message
action: sendFileMessage
title: 发送文件
source: message/msg_send/send_file.md
description: 发送消息类 action。`args.name` 必须是 MessageType 字符串（如 `jg:file`），不能用 MIME（如 `text/plain`）；`args.content` 形状取决于 `name`，见下一节「message.name 取值 + message.content 形状」。
---

# 发送文件

## 方法签名

```js
jim.sendFileMessage(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "message",
  "action": "sendFileMessage",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 |  | 消息对象 | 1.0.0 |
| args.conversationType | Number | 是 |  | [会话类型](../../../enum/web#conversation) | 1.0.0 |
| args.conversationId | String | 是 |  | 会话 Id，会话类型是 `PRIVATE` 时，会话 Id 是接收方的 userId，会话类型是 `GROUP` 时是群组 Id | 1.0.0 |
| args.content | Object | 是 |  |  | 1.0.0 **字段形状完全取决于 `message.name`**，见下一节「message.name 取值 + message.content 形状」。 |
| args.content.file | File | 是 |  | 发送 File 对象，通过 `<input type="file">` 获取 | 1.0.0 |
| args.content.name | String | 是 |  | 自定义文件名称，透传给对端 | 1.0.0 |
| args.content.type | String | 是 |  | 文件类型，透传给对端，用来自定义文件类型并展示 UI | 1.0.0 |
| args.mentionInfo | Object | 否 | 无 | conversationType 为 `GROUP` 时有效，设置 mentionInfo 表示本条消息是 @ 消息 | 1.0.0 |
| args.mentionInfo.mentionType | Number | 否 | 无 | @ 类型，详细可查看 [@ 消息枚举](../../../enum/web#mention) 说明 | 1.0.0 |
| args.mentionInfo.targetIds | Array | 否 | 无 | @ 指定人列表，SDK 会优先根据 mentionType 判断消息的 @ 类型 | 1.0.0 |
| args.lifeTime | Number | 否 | 0 | 消息的销毁时间段，必须大于 `0`, 单位 `ms`, 例如 60s: `1 * 60 * 1000` | 1.9.0 |
| args.lifeTimeAfterRead | Number | 否 | 0 | 消息的阅后即焚的时间段，必须大于 0, 单位 `ms`, 例如 60s: `1 * 60 * 1000` | 1.9.0 |

## message.name 取值 + message.content 形状

`args.name` 必须是下列值之一（与 im-docs `msg/*.mdx` 一致），`args.content` 的字段形状**完全取决于 `name` 的取值**。

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

## callbacks 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| callbacks | Object | 否 |  | 回调对象 | 1.0.0 |
| callbacks.onbefore | Function | 否 |  | 消息发送前回调，此方法触发后会返回临时消息标识 `tid`，可向页面渲染消息，消息发送成功后台根据 `tid` 更新消息状态 | 1.0.0 |
| callbacks.onprogress | Function | 否 |  | 文件上传进度回调 | 1.0.0 |
| callbacks.onerror | Function | 否 |  | 文件上传失败，会返回具体的异常说明，消息将会停止发送 | 1.0.0 |

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
let { ConversationType } = JIM;

// 通过 <input type="file"> onchange 获取 file 对象
let file = e.target.files[0];

let message = {
  conversationType: 1,
  conversationId: 'userid02',
  content: {
    file: file,
    name: 'hello.zip',
    type: 'zip'
  },
};

jim.sendFileMessage(message, {
  onbefore: (message) => {
    /* 
      message.tid  此时可将消息渲染至页面，可通过 message.tid 做唯一标识，onprogress 触发后通过 message.tid 更新进度条
    */
  },
  onprogress: ({ percent, message }) => {
    console.log(`${percent}%`, message);
  },
  onerror: (error, message) => {
    console.log('upload file error', error);
  }
}).then((msg) => {
  console.log('send file message successfully', msg)
}, ({ tid, error }) => {
  // 可根据 tid 修改消息发送失败的状态, Web 端消息失败仅在 SDK 内存中保存，刷新后将无法获取到发送失败的消息
  console.log(tid, error)
});
```

## 文档来源

- im-docs 源文件：`message/msg_send/send_file.md`