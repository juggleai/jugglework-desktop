---
name: jugglechat-im-sdk.conversation.conversation
module: conversation
title: 会话结构
source: conversation.mdx
---

# 会话结构

> 本文件描述数据模型 / 消息类型，**不直接对应 router action**。
>
> 来源：im-docs `conversation.mdx`

## 示例代码

```js
{
  conversationId: 'Akd1kdlsf'
  conversationType: 2,
  //...
  mentions: {
    // 是否有 @ 自己
    isMentioned: true,
    senders: [
      { id: "userId01", name: "Xs", portrait: "https://xxx.com/avatar.png", updatedTime: 1726113434045, exts: {} }
    ],
    msgs: [
      { senderId: "userId01", messageId: "nut3lupwjgnlukc9", sentTime: 1728964798161 }
    ],
    count: 2
	},
}
```