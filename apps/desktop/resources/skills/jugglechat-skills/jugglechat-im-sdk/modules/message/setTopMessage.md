---
name: jugglechat-im-sdk.message.setTopMessage
module: message
action: setTopMessage
title: 设置置顶
source: message/settop/set.md
---

# 设置置顶

## 方法签名

```js
jim.setTopMessage(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "message",
  "action": "setTopMessage",
  "args": { /* 见下方参数表 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| message | Object | 是 |  | 消息对象 | 1.0.0 |
| message.conversationType | Number | 是 |  | [会话类型](/docs/client/sdkintro/enum/web/#conversation) | 1.0.0 |
| message.conversationId | String | 是 |  | 会话 Id，会话类型是 `PRIVATE` 时，会话 Id 是接收方的 userId，会话类型是 `GROUP` 时是群组 Id | 1.0.0 |
| message.messageId | String | 是 |  | 被置顶的消息 Id | 1.0.0 |
| message.isTop | Boolean | 是 |  | 是否置顶 | 1.0.0 |

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
  messageId: 'xxxdkadhdsa',
  isTop: true
};

jim.setTopMessage(msg).then(() => {
  console.log('set message top successfully.')
}, (error) => {
  console.log(error)
});
```

## 文档来源

- im-docs 源文件：`message/settop/set.md`