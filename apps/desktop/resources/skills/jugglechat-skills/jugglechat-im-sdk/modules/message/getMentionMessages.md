---
name: jugglechat-im-sdk.message.getMentionMessages
module: message
action: getMentionMessages
title: 获取 @ 消息
source: message/histories/get_mentions.md
---

# 获取 @ 消息

## 方法签名

```js
jim.getMentionMessages(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "message",
  "action": "getMentionMessages",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 |  | 会话对象 | 1.0.0 |
| args.conversationType | Number | 是 |  | 会话类型 | 1.0.0 |
| args.conversationId | String | 是 |  | 会话 Id | 1.0.0 |
| args.messageIndex | Number | 否 | 0 | 消息索引，查询 @ 消息会以 messageIndex 为起始点向前或向后获取 `count` 条消息 | 1.0.0 |
| args.count | Number | 否 | 20 | 获取消息条数 | 1.0.0 |
| args.order | Number | 否 | [BACKWARD](../../../enum/web#mention_order) | 获取方向 | 1.0.0 |

## 回调说明

| 属性 | 类型 | 描述 | 版本 |
|---|---|---|---|
| result | Object | 查询结果 | 1.0.0 |
| result.isFinished | Boolean | @ 消息是否查询完成，false 表示服务端还有更多的 @ 消息列表 | 1.0.0 |
| result.msgs | Array | @ 消息列表，获取消息内容可通过 [按 ID 查询消息](../get_by_ids) 获取 | 1.0.0 |

## 示例代码

```js
let { ConversationType, MentionOrder } = JIM;

let conversation = {
  conversationType: 2,
  conversationId: 'groupid1',
  count: 10,
  messageIndex: 0,
  order: MentionOrder.BACKWARD
};

jim.getMentionMessages(conversation).then((result) => {
  let { isFinished, msgs } = result;
  console.log(isFinished, msgs);
})
```

## 文档来源

- im-docs 源文件：`message/histories/get_mentions.md`