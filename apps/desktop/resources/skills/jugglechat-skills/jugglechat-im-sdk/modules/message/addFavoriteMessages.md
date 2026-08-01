---
name: jugglechat-im-sdk.message.addFavoriteMessages
module: message
action: addFavoriteMessages
title: 添加收藏
source: message/favorite/add.md
---

# 添加收藏

## 方法签名

```js
jim.addFavoriteMessages(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "message",
  "action": "addFavoriteMessages",
  "args": { /* 见下方参数表 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| params | Object | 是 |  | 消息对象 | 1.0.0 |
| params.messages | Array | 是 |  | 收藏消息列表 | 1.0.0 |
| params.messages[0].conversationType | Number | 是 |  | [会话类型](/docs/client/sdkintro/enum/web/#conversation) | 1.0.0 |
| params.messages[0].conversationId | String | 是 |  | 会话 Id，会话类型是 `PRIVATE` 时，会话 Id 是接收方的 userId，会话类型是 `GROUP` 时是群组 Id | 1.0.0 |
| params.messages[0].senderId | String | 是 |  | 消息发送人 Id，[Message.sender.id](/docs/client/sdkintro/msg/message/) 可获取 | 1.0.0 |
| params.messages[0].messageId | String | 是 |  | 消息 Id，[Message.messageId](/docs/client/sdkintro/msg/message/) 可获取 | 1.0.0 |

## 失败回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| error | Object | 发送失败后会有对应的状态码，可以直接查看 `error.msg`，或者查看 [状态码](../../../../sdkintro/status_code/web) | 1.0.0 |

## 示例代码

```js
let { ConversationType } = JIM;

let params = {
  messages: [{
    conversationType: 2,
    conversationId: 'groupz001',
    messageId: 'nwmz3nrps6yj3rk8',
    senderId: "675NdFjkx"
  }] 
};

jim.addFavoriteMessages(params).then(() => {
  console.log('addFavoriteMessages successfully.')
}, (error) => {
  console.log(error);
});
```

## 文档来源

- im-docs 源文件：`message/favorite/add.md`