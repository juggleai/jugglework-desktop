---
name: jugglechat-im-sdk.conversation.removeConversation
module: conversation
action: removeConversation
title: 删除指定会话
source: conversation/operator/remove.md
---

# 删除指定会话

## 方法签名

```js
jim.removeConversation(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "conversation",
  "action": "removeConversation",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 | 无 | 删除的会话，支持删除单个会话，或者传入一个会话数组 | 1.0.0 |

## 示例代码

```js
let { ConversationType } = JIM;

let conversation = {
  conversationType: 1,
  conversationId: 'userId01'
};

// 删除单个会话
jim.removeConversation(conversation).then(() => {
  console.log('remove conversation successfully');
});

// 批量删除会话
let conversations = [conversation];
jim.removeConversation(conversation).then(() => {
  console.log('remove conversations successfully');
});
```

## 文档来源

- im-docs 源文件：`conversation/operator/remove.md`