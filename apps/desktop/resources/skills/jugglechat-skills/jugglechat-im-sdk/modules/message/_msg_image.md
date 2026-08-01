---
name: jugglechat-im-sdk.message.msg_image
module: message
title: 图片消息
source: msg/image.mdx
---

# 图片消息

> 本文件描述数据模型 / 消息类型，**不直接对应 router action**。
>
> 来源：im-docs `msg/image.mdx`

## 示例代码

```js
let imageMsg = {
  url: "https://example.com/avatar.png",
  thumbnail: "https://example.com/avatar_th.png",
  height: 640,
  width: 480,
  size: 100,
  extra: '{"Priority":"P0"}'
}

let message = {
  conversationType: 1,
  conversationId: 'userId1',
  name: 'jg:img',
  content: imageMsg
};
```