---
name: jugglechat-im-sdk.conversation.clearTotalUnreadcount
module: conversation
action: clearTotalUnreadcount
title: 清空会话未读总数
source: conversation/unread/clear_total_unread.md
---

# 清空会话未读总数

## 方法签名

```js
jim.clearTotalUnreadcount(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "conversation",
  "action": "clearTotalUnreadcount",
  "args": { /* 见下方参数表 */ }
}
```

## 示例代码

```js
jim.clearTotalUnreadcount().then(() => {
  console.log('clear total unreadcount successfully');
})
```

## 文档来源

- im-docs 源文件：`conversation/unread/clear_total_unread.md`