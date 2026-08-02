---
name: jugglechat-im-sdk.message.readMessage
module: message
action: readMessage
title: 设置已读
source: message/operator/read.md
---

# 设置已读

## 方法签名

```js
jim.readMessage(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "message",
  "action": "readMessage",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 |  | 消息对象 | 1.0.0 |
| args.conversationType | Number | 是 |  | [会话类型](/docs/client/sdkintro/enum/web/#conversation) | 1.0.0 |
| args.conversationId | String | 是 |  | 会话 Id，会话类型是 `PRIVATE` 时，会话 Id 是接收方的 userId，会话类型是 `GROUP` 时是群组 Id | 1.0.0 |
| args.messageId | String | 是 |  | 消息 UId | 1.0.0 |
| args.unreadIndex | Number | 是 |  | 消息索引，可从 `message.messageIndex` 获取 | 1.0.0 |

## 失败回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| error | Object | 发送失败后会有对应的状态码，可以直接查看 `error.msg`，或者查看 [状态码](../../../../sdkintro/status_code/web) | 1.0.0 |

## 示例代码

```js
let { ConversationType } = JIM;

// 方式一：单条消息设置已读
let message = {
  conversationType: 2,
  conversationId: 'groupid1',
  messageId: 'xxxdkadhdsa',
  unreadIndex: 1
};
jim.readMessage(message).then(() => {
  console.log('read message successfully.')
}, (error) => {
  console.log(error)
});

// 方式二：多条消息设置已读
let msgs = [
  {
    conversationType: 2,
    conversationId: 'groupid1',
    messageId: 'xxxdkadhdsa',
    unreadIndex: 2
  }
];
jim.readMessage(msgs).then(() => {
  console.log('read message successfully.')
}, (error) => {
  console.log(error)
});
```

## 文档来源

- im-docs 源文件：`message/operator/read.md`