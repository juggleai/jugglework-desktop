---
name: jugglechat-im-sdk.message.msg_voice
module: message
title: 语音消息
source: msg/voice.mdx
---

# 语音消息

> 本文件描述数据模型 / 消息类型，**不直接对应 router action**。
>
> 来源：im-docs `msg/voice.mdx`

## 示例代码

```js
let voiceMsg = {
  url: 'https://example.com/xxas.aac',
  type: 'aac',
  duration: 40,
  extra: '{"Priority":"P0"}'
}

let message = {
  conversationType: 1,
  conversationId: 'userId1',
  name: 'jg:voice',
  content: voiceMsg
};
```