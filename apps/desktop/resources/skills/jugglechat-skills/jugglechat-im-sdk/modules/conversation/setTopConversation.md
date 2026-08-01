---
name: jugglechat-im-sdk.conversation.setTopConversation
module: conversation
action: setTopConversation
title: 设置会话置顶
source: conversation/operator/settop.md
---

# 设置会话置顶

## 方法签名

```js
jim.setTopConversation(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "conversation",
  "action": "setTopConversation",
  "args": { /* 见下方参数表 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| conversation | Object | 是 | 无 | 会话对象 | 1.0.0 |
| conversation.conversationType | Number | 是 | 无 | 会话类型 | 1.0.0 |
| conversation.conversationId | String | 是 | 无 | 会话 Id | 1.0.0 |
| conversation.isTop | Boolean | 是 | 无 | 是否置顶 | 1.0.0 |

## 示例代码

```js
let { ConversationType } = JIM;

let conversation = {
  conversationType: 1,
  conversationId: 'userId01',
  isTop: true
};

jim.setTopConversation(conversation).then(() => {
  console.log('set conversation top successfully');
});
```

## 文档来源

- im-docs 源文件：`conversation/operator/settop.md`