---
name: jugglechat-im-sdk.message.recallMessage
module: message
action: recallMessage
title: 撤回消息
source: message/operator/recall.md
---

# 撤回消息

## 方法签名

```js
jim.recallMessage(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "message",
  "action": "recallMessage",
  "args": { /* 见下方参数表 */ }
}
```

## 参数说明

| 名称 | 类型 | 是否必需 | 描述 | 版本 |
|---|---|---|---|---|
| message | Object | 是 | 消息对象，可在 [历史消息](../../histories/get_all) 获取消息 | 1.0.0 |
| message.conversationType | Number | 是 | [会话类型](../../../../sdkintro/enum/web#conversation) | 1.0.0 |
| message.conversationId | String | 是 | 会话 Id，会话类型是 `PRIVATE` 时，会话 Id 是接收方的 userId，会话类型是 `GROUP` 时是群组 Id | 1.0.0 |
| message.messageId | String | 是 | 被撤回的消息 Id | 1.0.0 |
| message.sentTime | Number | 是 | 被撤回的消息的发送时间 | 1.0.0 |
| message.exts | Object | 否 | 撤回消息时的扩展信息 | 1.7.0 |

## 失败回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| error | Object | 发送失败后会有对应的状态码，可以直接查看 `error.msg`，或者查看 [状态码](../../../../sdkintro/status_code/web) | 1.0.0 |

## 示例代码

```js
let { ConversationType } = JIM;

// 实际项目中，可以直接把 SDK 返回 message 对象传入 recallMessage 方法
let message = { 
  conversationType: 1, 
  conversationId: 'userid01',
  messageId: 'xxxdkadhdsa',
  sentTime: 1702180128970,
  exts: {
    name: 'xiaoshan',
    custom1: 'HaHa',
    //... 更多自定义属性
  }
};

jim.recallMessage(message).then((result) => {
  console.log('recall message successfully');
}, (error) => {
  console.log(error);
});
```

## 文档来源

- im-docs 源文件：`message/operator/recall.md`