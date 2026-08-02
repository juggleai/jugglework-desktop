---
name: jugglechat-im-sdk.chatroom.setChatroomAttributes
module: chatroom
action: setChatroomAttributes
title: 设置属性
source: chatroom/set_kvs.md
---

# 设置属性

## 方法签名

```js
jim.setChatroomAttributes(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "chatroom",
  "action": "setChatroomAttributes",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 | 无 | 聊天室对象 | 1.6.0 |
| args.id | String | 是 | 无 | 聊天室 ID | 1.6.0 |
| args.attributes | Array | 是 | 无 | 属性列表 | 1.6.0 |

## 示例代码

```js
let chatroom = {
  id: 'chatroom1001',
  attributes: [
    { key: 'name', value: 'xiaoshan', isForce: true, isAutoDel },
    { key: 'age',  value: 18 }
  ]
};

jim.setChatroomAttributes(chatroom).then((result) => {
  console.log('set chatroom attributes successfully');
  /* 
    result => { success: [{ key: 'name' }], fail:[{ key: 'age', code: 14006 }] }
  */
}, (error) => {
  console.log('error', error);
});
```

## 文档来源

- im-docs 源文件：`chatroom/set_kvs.md`