---
name: jugglechat-im-sdk.message.msg_text
module: message
title: 文本消息
source: msg/text.mdx
---

# 文本消息

> 本文件描述数据模型 / 消息类型，**不直接对应 router action**。
>
> 来源：im-docs `msg/text.mdx`

## 示例代码

```js
let textMsg = {
  content: 'hello world',
  extra: '{"Priority":"P0"}'
}

let message = {
  conversationType: 1,
  conversationId: 'userId1',
  name: 'jg:text',
  content: textMsg
};
```