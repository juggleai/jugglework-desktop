---
name: jugglechat-im-sdk.message.getMessagesByIds
module: message
action: getMessagesByIds
title: 通过 Id 获取历史消息
source: message/histories/get_by_ids.md
---

# 通过 Id 获取历史消息

## 方法签名

```js
jim.getMessagesByIds(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "message",
  "action": "getMessagesByIds",
  "args": { /* 见下方参数表 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| params | Object | 是 |  | 历史消息获取参数 | 1.0.0 |
| params.conversationType | Number | 是 |  | [会话类型](/docs/client/sdkintro/enum/web/#conversation) | 1.0.0 |
| params.conversationId | String | 是 |  | 会话 Id，会话类型是 `PRIVATE` 时，会话 Id 是接收方的 userId，会话类型是 `GROUP` 时是群组 Id | 1.0.0 |
| message.messageIds | Array | 是 |  | 获取的消息 Id 数组 | 1.0.0 |

## 成功回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| result | Object |  | 1.0.0 |
| result.messages | Object | 消息数组，每条消息的属性，请查看 [Message](/docs/client/sdkintro/msg/message/) 结构 | 1.0.0 |

## 失败回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| error | Object | 发送失败后会有对应的状态码，可以直接查看 `error.msg`，或者查看 [状态码](/docs/client/sdkintro/status_code/web/) | 1.0.0 |

## 示例代码

```js
let { ConversationType } = JIM;

let params = {
  conversationType: 1,
  conversationId: 'userid2',
  messageIds: ['nnx3axfbglsgv6fp', 'nnx3aw5wglqgv6fp']
};

jim.getMessagesByIds(params).then((result) => {
  let { messages } = result;
  console.log(messages);
}, (error) => {
  console.log(error);
})
```

## 文档来源

- im-docs 源文件：`message/histories/get_by_ids.md`