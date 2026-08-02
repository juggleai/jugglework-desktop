---
name: jugglechat-im-sdk.message.getTopMessage
module: message
action: getTopMessage
title: 查询置顶
source: message/settop/query.md
---

# 查询置顶

## 方法签名

```js
jim.getTopMessage(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "message",
  "action": "getTopMessage",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 |  | 消息对象 | 1.0.0 |
| args.conversationType | Number | 是 |  | [会话类型](/docs/client/sdkintro/enum/web/#conversation) | 1.0.0 |
| args.conversationId | String | 是 |  | 会话 Id，会话类型是 `PRIVATE` 时，会话 Id 是接收方的 userId，会话类型是 `GROUP` 时是群组 Id | 1.0.0 |

## 成功回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| result | Object |  | 1.0.0 |
| result.message | Object | 被置顶的消息对象 | 1.0.0 |
| result.isTop | Boolean | 是否置顶 | 1.0.0 |
| result.operator | Object | 操作人 | 1.0.0 |
| result.createdTime | Number | 操作置顶时间 | 1.0.0 |

## 失败回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| error | Object | 发送失败后会有对应的状态码，可以直接查看 `error.msg`，或者查看 [状态码](../../../../sdkintro/status_code/web) | 1.0.0 |

## 示例代码

```js
let { ConversationType } = JIM;

let conversation = {
  conversationType: 2,
  conversationId: 'groupid1',
};

jim.getTopMessage(conversation).then((result) => {

  let { message, isTop, operator, createdTime } = result;
  
  // message => 被置顶或取消置顶的原始消息，想系可查看 Message 对象
  
  // isTop => 是否置顶
  
  // operator => 操作人 { id: '', name: '', portrait: '' }
  
  // createdTime => 操作时间
  
}, (error) => {
  console.log(error)
});
```

## 文档来源

- im-docs 源文件：`message/settop/query.md`