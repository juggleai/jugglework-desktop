---
name: jugglechat-im-sdk.message.registerMessage
module: message
action: registerMessage
title: 发送自定义消息
source: message/msg_send/custom.md
---

# 发送自定义消息

## 方法签名

```js
jim.registerMessage(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "message",
  "action": "registerMessage",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 |  | 消息对象 | 1.0.0 |
| args.conversationType | Number | 是 |  | [会话类型](../../../enum/web#conversation) | 1.0.0 |
| args.conversationId | String | 是 |  | 会话 Id，会话类型是 `PRIVATE` 时，会话 Id 是接收方的 userId，会话类型是 `GROUP` 时是群组 Id | 1.0.0 |
| args.name | String | 是 |  | 消息名称，根据实际需要发送不同消息类型，详细枚举请查看 [MessageType](../../../enum/web#message) | 1.0.0 |
| args.content | Object | 是 |  | 消息内容，构建 `message.name` 消息 | 1.0.0 |
| args.mentionInfo | Object | 否 | 无 | conversationType 为 `GROUP` 时有效，设置 mentionInfo 表示本条消息是 @ 消息 | 1.0.0 |
| args.mentionInfo.mentionType | Number | 否 | 无 | @ 类型，详细可查看 [@ 消息枚举](../../../enum/web#mention) 说明 | 1.0.0 |
| args.mentionInfo.targetIds | Array | 否 | 无 | @ 指定人列表，SDK 会优先根据 mentionType 判断消息的 @ 类型 | 1.0.0 |

## 成功回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| message | Object | 发送成功后返回带 `messageId` 和 `sentTime` 消息对象，消息结构请查看 [Message](../../../msg/message) | 1.0.0 |

## 失败回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| result | Object | 发送失败后会返回对象中包含 `tid` 属性信息，同时包含 `error` 信息，可以直接查看 `error.msg`，或者查看 [状态码](../../../status_code/web) | 1.0.0 |

## 示例代码

```js
let { ConversationType } = JIM;

/** 第一步：注册自定义消息,全局注册一次 ***********/ 
let MSG_NAME = {
  TEST_MSG_NAME: 'test:msgname'
};
let msgs = [
  // isCount: 表示对方收到消息后会话是否未读数 +1
  // isStorage： 表示消息是否存入历史消息
  { name: MSG_NAME.TEST_MSG_NAME,  isCount: true, isStorage: true },
];
jim.registerMessage(msgs)

/** 第二步：发送自定消息 ***********/ 
let msg = {
  conversationType: 2,
  conversationId: 'groupid1',
  name: MSG_NAME.TEST_MSG_NAME,
  content: {
    // text 属性可根据多端实际约定自行定义
    text: 'Hello JIM'
  }
};
jim.sendMessage(msg).then((message) => {
  console.log(message);
}, (error) => {
   let { error, tid } = result;
  // 可根据 tid 修改消息发送失败的状态, Web 端消息失败仅在 SDK 内存中保存，刷新后将无法获取到发送失败的消息
  console.log(tid, error);
});
```

## 文档来源

- im-docs 源文件：`message/msg_send/custom.md`