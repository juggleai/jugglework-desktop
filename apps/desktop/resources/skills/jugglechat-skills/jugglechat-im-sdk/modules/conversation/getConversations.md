---
name: jugglechat-im-sdk.conversation.getConversations
module: conversation
action: getConversations
title: 获取会话列表
source: conversation/get_all.md
---

# 获取会话列表

## 方法签名

```js
jim.getConversations(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "conversation",
  "action": "getConversations",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 否 |  |  | 1.0.0 |
| args.count | Number | 否 | 50 | 获取指定数量的会话列表，单次最多获取 100 个会话 | 1.0.0 |
| args.order | Number | 否 | [FORWARD](../../enum/web#conversation) | 获取方向，支持获取更早的会话或者更（四声）新的会话，配合 `time` 属性一起使用 | 1.0.0 |
| args.time | Number | 否 | 0 | 从指定时间点开始获取会话，可以配合 `order` 获取新老会话 | 1.0.0 |

## 回调说明

| 属性 | 类型 | 描述 | 版本 |
|---|---|---|---|
| result | Object | 查询结果 | 1.0.0 |
| result.conversations | Array | 会话数组，单个会话对象结构请查看 [Conversation](../conversation.mdx) | 1.0.0 |
| result.isFinished | Boolean | 标志会话是否获取完成 | 1.0.0 |

## 示例代码

```js
/* 
  假设当前用户有 199 个会话，每页获取 50 条，会话列表按时间倒序排列，实现会话列表分页逻辑如下：
  1、加载第 1 页获取参数： { count: 50, time: 0 }
  2、加载第 2 页获取参数： { count: 50, time: '获取第 1 页会话数组中最小的 sortTime（数组下标最大的会话）' }
  3、加载第 3 页获取参数： { count: 50, time: '获取第 2 页会话数组中最小的 sortTime（数组下标最大的会话）' }
  4、加载第 4 页获取参数： { count: 50, time: '获取第 3 页会话数组中最小的 sortTime（数组下标最大的会话）' }
  5、结束：isFinished 返回 true，停止加载
*/
jim.getConversations().then((result) => {
  let { conversations, isFinished } = result;
  console.log(isFinished, conversations);
})
```

## 文档来源

- im-docs 源文件：`conversation/get_all.md`