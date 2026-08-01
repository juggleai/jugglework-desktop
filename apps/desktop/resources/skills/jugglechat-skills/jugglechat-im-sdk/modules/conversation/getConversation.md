---
name: jugglechat-im-sdk.conversation.getConversation
module: conversation
action: getConversation
title: 获取单个会话
source: conversation/get_one.md
---

# 获取单个会话

## 方法签名

```js
jim.getConversation(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "conversation",
  "action": "getConversation",
  "args": { /* 见下方参数表 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| conversation | Object | 是 | 无 | 获取会话的对象 | 1.0.0 |
| conversation.conversationId | String | 是 | 无 | 会话 Id | 1.0.0 |
| conversation.conversationType | Number | 是 | 无 | 会话类型 | 1.0.0 |

## 示例代码

```js
let { ConversationType } = JIM;

let conversation = {
  conversationType: 1,
  conversationId: 'userId01'
};

jim.getConversation(conversation).then(({ conversation }) => {
  console.log(conversation);
});
```

## 文档来源

- im-docs 源文件：`conversation/get_one.md`