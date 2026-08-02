---
name: jugglechat-im-sdk.message.updateMessage
module: message
action: updateMessage
title: 修改消息
source: message/operator/update.md
---

# 修改消息

## 方法签名

```js
jim.updateMessage(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "message",
  "action": "updateMessage",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 |  | 消息对象 | 1.0.0 |
| args.conversationType | Number | 是 |  | [会话类型](/docs/client/sdkintro/enum/web/#conversation) | 1.0.0 |
| args.conversationId | String | 是 |  | 会话 Id，会话类型是 `PRIVATE` 时，会话 Id 是接收方的 userId，会话类型是 `GROUP` 时是群组 Id | 1.0.0 |
| args.content | Object | 是 |  | 消息内容，构建 `message.name` 消息 | 1.0.0 |
| args.tid | String | 是 |  | 被修改的消息的本地 Id | 1.0.0 |
| args.messageId | String | 是 |  | 被修改的消息 Id | 1.0.0 |
| args.sentTime | Number | 是 |  | 被修改的消息的发送时间 | 1.0.0 |

## 失败回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| error | Object | 发送失败后会有对应的状态码，可以直接查看 `error.msg`，或者查看 [状态码](../../../../sdkintro/status_code/web) | 1.0.0 |

## 示例代码

```js
let { ConversationType } = JIM;

let msg = {
  conversationType: 2,
  conversationId: 'groupid1',
  tid: 'dkaadjdk30dls',
  messageId: 'xxxdkadhdsa',
  sentTime: 1702180128970,
  content: {
    content: 'new hello world'
  }
};

jim.updateMessage(msg).then(() => {
  console.log('update message successfully.')
}, (error) => {
  console.log(error)
});
```

## 文档来源

- im-docs 源文件：`message/operator/update.md`