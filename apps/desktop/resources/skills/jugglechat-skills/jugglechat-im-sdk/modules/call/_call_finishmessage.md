---
name: jugglechat-im-sdk.call.call_finishmessage
module: call
title: 通话结束消息
source: call/finishmessage.md
---

# 通话结束消息

> 本文件描述数据模型 / 消息类型，**不直接对应 router action**。
>
> 来源：im-docs `call/finishmessage.md`

## 示例代码

```js
let content = message.content;

/*
  duration: 通话时长
  media_type: 0 表示音频，1 表示视频
  reason: 0 主叫取消，1 被叫拒绝，2 被叫无应答，3 通话结束
*/ 
let { duration, media_type, reason } = content;
```