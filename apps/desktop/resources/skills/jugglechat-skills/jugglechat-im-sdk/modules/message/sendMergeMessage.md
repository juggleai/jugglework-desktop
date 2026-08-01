---
name: jugglechat-im-sdk.message.sendMergeMessage
module: message
action: sendMergeMessage
title: 合并转发
source: message/msg_send/send_merge.md
description: 发送消息类 action。`args.message.name` 必须是 MessageType 字符串（如 `jg:merge`），不能用 MIME（如 `text/plain`）；`args.message.content` 形状取决于 `name`，见下一节「message.name 取值 + message.content 形状」。
---

# 合并转发

## 方法签名

```js
jim.sendMergeMessage(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "message",
  "action": "sendMergeMessage",
  "args": { /* 见下方参数表 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| message | Object | 是 |  | 消息对象 | 1.0.0 |
| message.conversationType | Number | 是 |  | [会话类型](../../../enum/web#conversation) | 1.0.0 |
| message.conversationId | String | 是 |  | 会话 Id，会话类型是 `PRIVATE` 时，会话 Id 是接收方的 userId，会话类型是 `GROUP` 时是群组 Id | 1.0.0 |
| message.messages | Array | 是 |  | 合并转发的消息列表，格式见下方示例 | 1.0.0 |
| message.previewList | Array | 是 |  | 自定义的消息内容简介，数组内容和多端约定好即可 | 1.0.0 |
| message.title | String | 是 |  | 转发消息的标题 | 1.0.0 |
| lifeTime | Number | 否 | 0 | 消息的销毁时间段，必须大于 `0`, 单位 `ms`, 例如 60s: `1 * 60 * 1000` | 1.9.0 |
| lifeTimeAfterRead | Number | 否 | 0 | 消息的阅后即焚的时间段，必须大于 0, 单位 `ms`, 例如 60s: `1 * 60 * 1000` | 1.9.0 |

## message.name 取值 + message.content 形状

`args.message.name` 必须是下列值之一（与 im-docs `msg/*.mdx` 一致），`args.message.content` 的字段形状**完全取决于 `name` 的取值**。

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
let { ConversationType } = jetim;

let params = {
  conversationType: 1,
  conversationId: 'userid02',
  // message 是通过历史消息或在消息监听收到的消息对象
  messageIdList: [message],
  previewList: [
    { content: 'Hello Chat', sender: { name: '小可', other: '可多端约定扩展' } }
  ],
  title: '小 J 和小 G 的聊天记录'
};

let callbacks = {
  onbefore: (message) => {
    // 渲染至页面，可通过 message.tid 做唯一标识
  }
};
jetim.sendMergeMessage(params, callbacks).then((msg) => {
  console.log('send merge message successfully', msg);
}, (result) => {
  let { error, tid } = result;
  // 可根据 tid 修改消息发送失败的状态, Web 端消息失败仅在 SDK 内存中保存，刷新后将无法获取到发送失败的消息
  console.log(tid, error);
});
```

## 文档来源

- im-docs 源文件：`message/msg_send/send_merge.md`