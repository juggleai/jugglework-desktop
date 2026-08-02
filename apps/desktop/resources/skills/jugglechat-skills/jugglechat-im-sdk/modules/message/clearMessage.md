---
name: jugglechat-im-sdk.message.clearMessage
module: message
action: clearMessage
title: 清空历史消息
source: message/histories/clear.md
---

# 清空历史消息

## 方法签名

```js
jim.clearMessage(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "message",
  "action": "clearMessage",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 是否必需 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 | - | 清理历史消息 | 1.0.0 |
| args.conversationType | Number | 是 | - | [会话类型](../../../enum/web#conversation) | 1.0.0 |
| args.conversationId | String | 是 | - | 会话 Id，会话类型是 `PRIVATE` 时，会话 Id 是接收方的 userId，会话类型是 `GROUP` 时是群组 Id | 1.0.0 |
| args.time | Number | 是 | - | 清理指定时间之前的历史消息, 清理全部可传入会话最后一条消息的 sentTime | 1.0.0 |

## 失败回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| error | Object | 发送失败后会有对应的状态码，可以直接查看 `error.msg`，或者查看 [状态码](../../../status_code/web) | 1.0.0 |

## 示例代码

```js
let { ConversationType } = JIM;

let params = {
  conversationType: 1,
  conversationId: 'userid2',
  time: 1702180128970
};

jim.clearMessage(params).then((result) => {
  console.log('clear messages successfully');
}, (error) => {
  console.log(error);
})
```

## 文档来源

- im-docs 源文件：`message/histories/clear.md`