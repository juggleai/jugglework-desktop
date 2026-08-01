---
name: jugglechat-im-sdk.message.msg_merge
module: message
title: 合并消息
source: msg/merge.mdx
---

# 合并消息

> 本文件描述数据模型 / 消息类型，**不直接对应 router action**。
>
> 来源：im-docs `msg/merge.mdx`

## 示例代码

```js
let mergeMsg = {
  title: '小 J 和 阿罗 的聊天记录',
  previewList: [{ content: '[文件]', senderName: '阿罗' }],
  messageIdList: ['ns7c4mzpsa4g7sb5', 'ns6wbh472ayg7sb5']
}

let message = {
  conversationType: 1,
  conversationId: 'userId1',
  name: 'jg:merge',
  content: mergeMsg
};
```