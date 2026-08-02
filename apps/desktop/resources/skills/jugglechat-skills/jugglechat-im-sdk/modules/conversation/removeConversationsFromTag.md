---
name: jugglechat-im-sdk.conversation.removeConversationsFromTag
module: conversation
action: removeConversationsFromTag
title: 从标签里删除会话
source: conversation/tag/remove_convers.md
---

# 从标签里删除会话

## 方法签名

```js
jim.removeConversationsFromTag(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "conversation",
  "action": "removeConversationsFromTag",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 |  | Tag 对象 | 1.7.5 |
| args.id | String | 是 |  | 标签 ID，开发者可自定义，最大长度 64 个字符 | 1.7.5 |
| args.conversations | Array | 是 |  | 会话列表，详见代码示例 | 1.7.5 |

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

jim.removeConversationsFromTag(tag).then(() => {
  console.log('removeConversationsFromTag successfully')
}, (error) => {
  console.log(error)
});
```

## 文档来源

- im-docs 源文件：`conversation/tag/remove_convers.md`