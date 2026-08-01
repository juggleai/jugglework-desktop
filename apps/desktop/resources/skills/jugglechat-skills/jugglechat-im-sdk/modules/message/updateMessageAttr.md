---
name: jugglechat-im-sdk.message.updateMessageAttr
module: message
action: updateMessageAttr
title: 修改本地消息扩展
source: message/operator/update_lc_attr.md
---

# 修改本地消息扩展

## 方法签名

```js
jim.updateMessageAttr(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "message",
  "action": "updateMessageAttr",
  "args": { /* 见下方参数表 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 描述 | 版本 |
|---|---|---|---|---|
| message | Object | 是 | 消息搜索参数 | 1.0.0 |
| message.tid | String | 是 | 消息的唯一标识，可在 [Message](../../../msg/message) 中获取 | 1.0.0 |
| message.attribute | String | 是 | 可以设置 JSON 字符串用来扩展，长度 `1000` 个字符 | 1.0.0 |

## 失败回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| error | Object | 发送失败后会有对应的状态码，可以直接查看 `error.msg`，或者查看 [状态码](../../../../sdkintro/status_code/web) | 1.0.0 |

## 示例代码

```js
let message = { 
  tid: 'nrde5kxxaacg7sb5', 
  attribute: '{"fileUrl": "/Users/xxx/avatar.jpg"}' 
};

jim.updateMessageAttr(message).then(() => {
  console.log('Update Local Message successfully')
}, (error) => {
  console.log(error)
});
```

## 文档来源

- im-docs 源文件：`message/operator/update_lc_attr.md`