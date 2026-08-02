---
name: jugglechat-im-sdk.chatroom.getChatRoomAttributes
module: chatroom
action: getChatRoomAttributes
title: 获取指定属性
source: chatroom/get_kvs.md
---

# 获取指定属性

## 方法签名

```js
jim.getChatRoomAttributes(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "chatroom",
  "action": "getChatRoomAttributes",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 | 无 | 聊天室对象 | 1.6.0 |
| args.id | String | 是 | 无 | 聊天室 ID | 1.6.0 |
| args.attributes | Array | 是 | 无 | 聊天室属性列表，数据结构请参考示例代码 | 1.6.0 |

## 回调说明

| 属性 | 类型 | 描述 | 版本 |
|---|---|---|---|
| chatroom | Object | 会话对象 | 1.6.0 |
| chatroom.id | String | 聊天室 ID | 1.6.0 |
| chatroom.attributes | Array | 聊天室全部属性，数据结构请参考示例代码 | 1.6.0 |

## 示例代码

```js
let chatroom = {
  id: 'chatroom1001',
  attributes: [ { key: 'name' }, { key: 'age' }]
};

jim.getChatRoomAttributes(chatroom).then((chatroom) => {
  let { id, attributes } = chatroom;
  /* 
    attributes => 
      [
        { key: 'name', value: 'xiaoshan' },
        { key: 'age', value: 18 },
      ]
  */
}, (error) => {
  console.log('error', error)
});
```

## 文档来源

- im-docs 源文件：`chatroom/get_kvs.md`