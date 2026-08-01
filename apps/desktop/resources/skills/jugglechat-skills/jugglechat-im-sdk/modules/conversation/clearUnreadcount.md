---
name: jugglechat-im-sdk.conversation.clearUnreadcount
module: conversation
action: clearUnreadcount
title: 清空单个会话未读数
source: conversation/unread/clear_unread.md
---

# 清空单个会话未读数

## 方法签名

```js
jim.clearUnreadcount(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "conversation",
  "action": "clearUnreadcount",
  "args": { /* 见下方参数表 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| conversation | Object | 是 |  |  | 1.0.0 |
| conversation.conversationType | Number | 是 |  | 会话类型 | 1.0.0 |
| conversation.conversationId | String | 是 |  | 会话 Id | 1.0.0 |
| conversation.unreadIndex | Number | 是 |  | 会话最后一条消息的索引, 可在 `conversation.latestUnreadIndex` 获取 | 1.0.0 |
| conversation.messageId | String | 是 |  | 会话最后的 messageId, 可在 `conversation.latestMessage` 获取 | 1.0.0 |
| conversation.messageSentTime | Number | 是 |  | 会话最后一条消息的发送时间 可在 `conversation.latestMessage` 获取 | 1.0.0 |

## 示例代码

```js
let { ConversationType } = JIM;

let conversation = {
  conversationType: 1,
  conversationId: 'userId02',
  messageSentTime: 1724675506002,
  messageId: 'djdjakdk394alkjda',
  unreadIndex: 9
};

jim.clearUnreadcount(conversation).then(() => {
  console.log('clear unreadCount successfully');
})
```

## 文档来源

- im-docs 源文件：`conversation/unread/clear_unread.md`