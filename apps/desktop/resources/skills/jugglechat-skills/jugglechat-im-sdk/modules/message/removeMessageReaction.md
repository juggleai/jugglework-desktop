---
name: jugglechat-im-sdk.message.removeMessageReaction
module: message
action: removeMessageReaction
title: 删除消息回应
source: message/reaction/remove.md
---

# 删除消息回应

## 方法签名

```js
jim.removeMessageReaction(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "message",
  "action": "removeMessageReaction",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 |  | 消息对象 | 1.8.0 |
| args.conversationType | Number | 是 |  | [会话类型](/docs/client/sdkintro/enum/web/#conversation) | 1.8.0 |
| args.conversationId | String | 是 |  | 会话 Id，会话类型是 `PRIVATE` 时，会话 Id 是接收方的 userId，会话类型是 `GROUP` 时是群组 Id | 1.8.0 |
| args.messageId | String | 是 |  | 被删除回复的消息 Id | 1.8.0 |
| args.reactionId | String | 是 |  | 回应消息的唯一表示，开发者可自定义，需要多端约定一致 | 1.8.0 |

## 失败回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| error | Object | 发送失败后会有对应的状态码，可以直接查看 `error.msg`，或者查看 [状态码](../../../../sdkintro/status_code/web) | 1.8.0 |

## 示例代码

```js
let { ConversationType } = JIM;

let msg = {
  conversationType: 2,
  conversationId: 'groupid1',
  messageId: 'xxxdkadhdsa',
  reactionId: ':smile'
};

jim.removeMessageReaction(msg).then(() => {
  console.log('remove message reaction successfully.')
}, (error) => {
  console.log(error)
});
```

## 文档来源

- im-docs 源文件：`message/reaction/remove.md`