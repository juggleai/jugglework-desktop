---
name: jugglechat-im-sdk.conversation.markUnread
module: conversation
action: markUnread
title: 标记会话状态
source: conversation/operator/mark_unread.md
---

# 标记会话状态

## 方法签名

```js
jim.markUnread(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "conversation",
  "action": "markUnread",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 | 无 | 获取会话的对象 | 1.5.0 |
| args.conversationId | String | 是 | 无 | 会话 Id | 1.5.0 |
| args.conversationType | Number | 是 | 无 | 会话类型 | 1.5.0 |
| args.unreadTag | Number | 是 |  | [会话标记状态](../../../enum/web#unreadtag) | 1.5.0 |

## 示例代码

```js
jim.markUnread({
  conversationId: '7KeH8fjCO',
  conversationType: 2,
  unreadTag: 1,
}).then(() => {
  console.log('markunread successfully')
}, (error) => {
  console.log(error)
});
```

## 文档来源

- im-docs 源文件：`conversation/operator/mark_unread.md`