---
name: jugglechat-im-sdk.message.getContextMessages
module: message
action: getContextMessages
title: 获取消息上下文
source: message/histories/get_context.md
---

# 获取消息上下文

## 方法签名

```js
jim.getContextMessages(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "message",
  "action": "getContextMessages",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 |  | 历史消息获取参数 | 1.8.3 |
| args.conversationType | Number | 是 |  | [会话类型](../../../enum/web#conversation) | 1.8.3 |
| args.conversationId | String | 是 |  | 会话 Id，会话类型是 `PRIVATE` 时，会话 Id 是对方的 userId，会话类型是 `GROUP` 时是群组 Id | 1.8.3 |
| args.time | Number | 否 | `第一条未读消息的时间` | 获取上下文消息的起始时间 | 1.8.3 |
| args.count | Object | 否 | 10 | 获取历史上下文消息的条数，会从指定 `time` 时间的前后各取 `count` 条消息，在 `frontMessages` 和 `backMessages` 返回, 范围 1 - 10 | 1.8.3 |

## 成功回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| result | Object |  | 1.8.3 |
| result.frontMessages | Object | 消息数组，每条消息的属性，请查看 [Message](../../../msg/message) 结构 | 1.8.3 |
| result.isFrontFinished | Object | `向前` 是否还有更多的历史消息没有获取 结构 | 1.8.3 |
| result.backMessages | Object | 消息数组，每条消息的属性，请查看 [Message](../../../msg/message) 结构 | 1.8.3 |
| result.isBackFinished | Object | `向后` 是否还有更多的历史消息没有获取 | 1.8.3 |

## 失败回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| error | Object | 发送失败后会有对应的状态码，可以直接查看 `error.msg`，或者查看 [状态码](../../../status_code/web) | 1.8.3 |

## 示例代码

```js
let { ConversationType } = JIM;

let params = {
  conversationType: 1,
  conversationId: 'userid2',
  count: 10
};

jim.getContextMessages(params).then((result) => {
  let { frontMessages, isFrontFinished, backMessages, isBackFinished } = result;
  console.log(result);
}, (error) => {
  console.log(error);
})
```

## 文档来源

- im-docs 源文件：`message/histories/get_context.md`