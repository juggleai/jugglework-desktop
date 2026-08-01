---
name: jugglechat-im-sdk.message.msg_message
module: message
title: 消息对象
source: msg/message.mdx
---

# 消息对象

> 本文件描述数据模型 / 消息类型，**不直接对应 router action**。
>
> 来源：im-docs `msg/message.mdx`

## 示例代码

```js
let message = {
  //... 其他属性
  reactions: {
    // :smile 是添加回应时自定义的 Key 值
    :simle: [{
      key: '回应消息时设置的 key',
      value: '触发回应操作的用户 Id',
      timestamp: '设置回应时间，单位：ms',
      // 触发回应操作的用户信息
      user: {
        id: '触发回应操作的用户 Id',
        name: '触发回应操作的用户名称',
        portrait: '触发回应操作的用户头像'
      }
    }],
  }
};
```