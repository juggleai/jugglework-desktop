---
name: jugglechat-im-sdk.conversation.getTotalUnreadcount
module: conversation
action: getTotalUnreadcount
title: 获取会话未读总数
source: conversation/unread/get_total_unread.md
---

# 获取会话未读总数

## 方法签名

```js
jim.getTotalUnreadcount(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "conversation",
  "action": "getTotalUnreadcount",
  "args": { /* 见下方参数表 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| params | Object | 否 | 无 | 查询条件 | 1.0.0 |
| params.conversationTypes | Array | 否 | 无 | 指定会话类型 | 1.0.0 |
| params.ignoreConversations | Array | 否 | 无 | 忽略指定会话 | 1.0.0 |

## 示例代码

```js
// 获取方式一：获取全部会话未读总数
jim.getTotalUnreadcount().then(({ count }) => {
  console.log('当前用户未读总数:', count);
})

/**
  获取方式二：按条件过滤后获取未读总数
  条件解释说明：获取除 userid2 外的全部单聊未读总数
*/ 
let params = {
  conversationTypes: [1],
  ignoreConversations: [
    {
      conversationType: 1,
      conversationId: 'userid2'
    }
  ]
};
jim.getTotalUnreadcount(params).then(({ count }) => {
  console.log('当前用户未读总数:', count);
})
```

## 文档来源

- im-docs 源文件：`conversation/unread/get_total_unread.md`