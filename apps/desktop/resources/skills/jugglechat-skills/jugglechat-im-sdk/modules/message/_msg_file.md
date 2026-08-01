---
name: jugglechat-im-sdk.message.msg_file
module: message
title: 文件消息
source: msg/file.mdx
---

# 文件消息

> 本文件描述数据模型 / 消息类型，**不直接对应 router action**。
>
> 来源：im-docs `msg/file.mdx`

## 示例代码

```js
let fileMsg = {
  name: "demo.pptx",
  url: "https://example.com/demo.pptx",
  size: 1000,
  type: "pptx",
  extra: '{"Priority":"P0"}'
}

let message = {
  conversationType: 1,
  conversationId: 'userId1',
  name: 'jg:file',
  content: fileMsg
};
```