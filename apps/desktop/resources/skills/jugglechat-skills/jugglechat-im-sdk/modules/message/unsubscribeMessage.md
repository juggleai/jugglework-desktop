---
name: jugglechat-im-sdk.message.unsubscribeMessage
module: message
action: unsubscribeMessage
title: 消息订阅
source: message/msg_subscribe.md
---

# 消息订阅

## 方法签名

```js
jim.unsubscribeMessage(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "message",
  "action": "unsubscribeMessage",
  "args": { /* 见下方参数表 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| conversation | Object | 是 |  | 会话对象 | 1.7.18 |
| conversation.conversationType | Number | 是 |  | [会话类型](../../enum/web#conversation) | 1.7.18 |
| conversation.conversationId | String | 是 |  | 会话 Id，会话类型是 `PRIVATE` 时，会话 Id 是接收方的 userId，会话类型是 `GROUP` 时是群组 Id | 1.7.18 |

## 失败回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| error | Object | 发送失败后会有对应的状态码，可以直接查看 `error.msg`，或者查看 [状态码](../../status_code/web) | 1.7.18 |

## 示例代码

```js
let { ConversationType } = JIM;

let convesation = {
  conversationType: 2,
  conversationId: 'group02',
};
// 订阅消息，若连接断开请主动调用 unsubscribeMessage 取消订阅
jim.subscribeMessage(convesation).then(() => {
  console.log('subscribeMsg successfully.')
}, (error) => {
  console.log(error)
});


// 取消订阅
jim.unsubscribeMessage(convesation).then(() => {
  console.log('unsubscribeMsg successfully.')
}, (error) => {
  console.log(error)
});
```

## 文档来源

- im-docs 源文件：`message/msg_subscribe.md`