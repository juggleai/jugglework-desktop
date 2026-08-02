---
name: jugglechat-im-sdk.conversation.getTopConversations
module: conversation
action: getTopConversations
title: 获取置顶会话
source: conversation/operator/get_top_all.md
---

# 获取置顶会话

## 方法签名

```js
jim.getTopConversations(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "conversation",
  "action": "getTopConversations",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 回调说明

| 属性 | 类型 | 描述 | 版本 |
|---|---|---|---|
| result | Object | 查询结果 | 1.0.0 |
| result.conversations | Array | 会话数组，单个会话对象结构请查看 [Conversation](../../conversation.mdx) | 1.0.0 |
| result.isFinished | Boolean | 标志会话是否获取完成 | 1.0.0 |

## 示例代码

```js
jim.getTopConversations().then((result) => {
  let { conversations, isFinished } = result;
  console.log(isFinished, conversations);
})
```

## 文档来源

- im-docs 源文件：`conversation/operator/get_top_all.md`