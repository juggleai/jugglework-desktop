---
name: jugglechat-im-sdk.conversation.addConversationsToTag
module: conversation
action: addConversationsToTag
title: 向标签里添加会话
source: conversation/tag/add_convers.md
---

# 向标签里添加会话

## 方法签名

```js
jim.addConversationsToTag(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "conversation",
  "action": "addConversationsToTag",
  "args": { /* 见下方参数表 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| tag | Object | 是 |  | Tag 对象 | 1.7.5 |
| tag.id | String | 是 |  | 标签 ID，开发者可自定义，最大长度 64 个字符 | 1.7.5 |
| tag.conversations | Array | 是 |  | 会话列表，详见代码示例 | 1.7.5 |

## 失败回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| error | Object | 发送失败后会有对应的状态码，可以直接查看 `error.msg`，或者查看 [状态码](../../../../sdkintro/status_code/web) | 1.0.0 |

## 示例代码

```js
let { ConversationType } = JIM;

let tag = {
  id: 'tag_01',
  conversations: [
    { conversationType: 1, conversationId: 'userId01' }
  ]
};

jim.addConversationsToTag(tag).then(() => {
  console.log('addConversationsToTag successfully')
}, (error) => {
  console.log(error)
});
```

## 文档来源

- im-docs 源文件：`conversation/tag/add_convers.md`