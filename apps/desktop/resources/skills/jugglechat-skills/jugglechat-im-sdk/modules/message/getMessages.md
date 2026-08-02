---
name: jugglechat-im-sdk.message.getMessages
module: message
action: getMessages
title: 获取历史消息
source: message/histories/get_all.md
---

# 获取历史消息

## 方法签名

```js
jim.getMessages(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "message",
  "action": "getMessages",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 完整 router 调用示例（已验证）

```bash
curl -X POST http://127.0.0.1:17832/router \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "jugglechat-im-sdk",
    "module": "message",
    "action": "getMessages",
    "args": {
      "conversationType": 1,
      "conversationId": "userid2",
      "count": 20,
      "order": 0
    }
  }'
```

> 注意：`args` 平铺，**不要**写成 `"args": { "params": { ... } }`。

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 |  | 历史消息获取参数 | 1.0.0 |
| args.conversationType | Number | 是 |  | [会话类型](../../../enum/web#conversation) | 1.0.0 |
| args.conversationId | String | 是 |  | 会话 Id，会话类型是 `PRIVATE` 时，会话 Id 是对方的 userId，会话类型是 `GROUP` 时是群组 Id | 1.0.0 |
| args.count | Object | 否 | 20 | 历史消息获取条数，获取历史消息条数范围 1 - 20 条 | 1.0.0 |
| args.time | Number | 否 | 0 | 从指定时间开始获取历史消息，可用于调到历史某一条消息，获取前后消息 | 1.0.0 |
| args.order | Number | 否 | [BACKWARD](../../../enum/web) | 获取历史消息方向，BACKWARD 获取更早的历史消息 | 1.0.0 |

## 成功回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| result | Object |  | 1.0.0 |
| result.isFinished | Object | 是否还有更多的历史消息没有获取 | 1.0.0 |
| result.messages | Object | 消息数组，每条消息的属性，请查看 [Message](../../../msg/message) 结构 | 1.0.0 |

## 失败回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| error | Object | 发送失败后会有对应的状态码，可以直接查看 `error.msg`，或者查看 [状态码](../../../status_code/web) | 1.0.0 |

## 示例代码

```js
let { ConversationType } = JIM;

let params = {
  conversationType: 1,
  conversationId: 'userid2'
};

jim.getMessages(params).then((result) => {
  let { messages, isFinished } = result;
  console.log(messages, isFinished);
}, (error) => {
  console.log(error);
})
```

## 文档来源

- im-docs 源文件：`message/histories/get_all.md`