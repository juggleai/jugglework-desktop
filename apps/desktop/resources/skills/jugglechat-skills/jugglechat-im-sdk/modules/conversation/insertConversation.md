---
name: jugglechat-im-sdk.conversation.insertConversation
module: conversation
action: insertConversation
title: 插入指定会话
source: conversation/operator/insert.md
---

# 插入指定会话

## 方法签名

```js
jim.insertConversation(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "conversation",
  "action": "insertConversation",
  "args": { /* 见下方参数表 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| conversation | Object | 是 | 无 | 会话对象 | 1.0.0 |
| conversation.conversationId | String | 是 | 无 | 会话 Id | 1.0.0 |
| conversation.conversationType | Number | 是 | 无 | 会话类型 | 1.0.0 |
| conversation.conversationTitle | String | 否 | 无 | 会话名称 | 1.0.0 |
| conversation.conversationPortrait | String | 否 | 无 | 会话头像 | 1.0.0 |

## 回调说明

| 属性 | 类型 | 描述 | 版本 |
|---|---|---|---|
| result | Object | 查询结果 | 1.0.0 |
| result.conversation | Object | [会话对象](../../../conversation)，包含用户或群组信息 | 1.0.0 |

## 示例代码

```js
let { ConversationType } = JIM;

let conversation = {
  conversationType: 1,
  conversationId: 'userId01'
};

jim.insertConversation(conversation).then((result) => {
  let { conversation } = result;
  console.log(conversation);
});
```

## 文档来源

- im-docs 源文件：`conversation/operator/insert.md`