---
name: jugglechat-im-sdk.message.removeMessages
module: message
action: removeMessages
title: 删除历史消息
source: message/histories/remove.md
---

# 删除历史消息

## 方法签名

```js
jim.removeMessages(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "message",
  "action": "removeMessages",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 是否必需 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 | - | 清理历史消息 | 1.0.0 |
| args.conversationType | Number | 是 | - | [会话类型](/docs/client/sdkintro/enum/web/#conversation) | 1.0.0 |
| args.conversationId | String | 是 | - | 会话 Id，会话类型是 `PRIVATE` 时，会话 Id 是接收方的 userId，会话类型是 `GROUP` 时是群组 Id | 1.0.0 |
| args.messageIndex | Number | 是 | - | 消息的索引，可在 [Message](/docs/client/sdkintro/msg/message/) 中获取 | 1.0.0 |
| args.sentTime | Number | 是 | - | 消息的发送时间，可在 [Message](/docs/client/sdkintro/msg/message/) 中获取 | 1.0.0 |
| args.tid | String | 是 | - | 消息的 ID ，可在 [Message](/docs/client/sdkintro/msg/message/) 中获取 | 1.0.0 |
| args.messageId | String | 是 | - | 消息的唯一 ID ，可在 [Message](/docs/client/sdkintro/msg/message/) 中获取 | 1.0.0 |

## 失败回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| error | Object | 发送失败后会有对应的状态码，可以直接查看 `error.msg`，或者查看 [状态码](/docs/client/sdkintro/status_code/web/) | 1.0.0 |

## 示例代码

```js
let { ConversationType } = JIM;

// 示例为模拟数据，实际调用可从历史消息接口中获取
let messages = [
  {
    conversationType: 1, 
    conversationId: 'userid1', 
    messageIndex: 128, 
    sentTime: 1714235241490, 
    messageId: 'nreayt7ha4ggqlcv',
    tid: 'nreayt7ha4ggqlcv',
  },
  //...
];

jim.removeMessages(messages).then(() => {
  console.log('remove messages successfully.')
});
```

## 文档来源

- im-docs 源文件：`message/histories/remove.md`