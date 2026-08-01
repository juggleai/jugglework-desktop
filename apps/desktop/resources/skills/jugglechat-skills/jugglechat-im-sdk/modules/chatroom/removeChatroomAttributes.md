---
name: jugglechat-im-sdk.chatroom.removeChatroomAttributes
module: chatroom
action: removeChatroomAttributes
title: 删除属性
source: chatroom/remove_kvs.md
---

# 删除属性

## 方法签名

```js
jim.removeChatroomAttributes(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "chatroom",
  "action": "removeChatroomAttributes",
  "args": { /* 见下方参数表 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| chatroom | Object | 是 | 无 | 聊天室对象 | 1.6.0 |
| chatroom.id | String | 是 | 无 | 聊天室 ID | 1.6.0 |
| chatroom.attributes | Array | 是 | 无 | 删除的属性列表 | 1.6.0 |

## 示例代码

```js
let chatroom = {
  id: 'chatroom1001',
  attributes: [
    { key: 'name', isForce: true },
    { key: 'age' }
  ]
};

jim.removeChatroomAttributes(chatroom).then((result) => {
  console.log('remove chatroom attributes successfully');
  /* 
    result => { success: [{ key: 'name' }], fail:[{ key: 'age', code: 14006 }] }
  */
}, (error) => {
  console.log('error', error);
});
```

## 文档来源

- im-docs 源文件：`chatroom/remove_kvs.md`