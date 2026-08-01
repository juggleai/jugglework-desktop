---
name: jugglechat-im-sdk.message.getFavoriteMessages
module: message
action: getFavoriteMessages
title: 查询收藏
source: message/favorite/query.md
---

# 查询收藏

## 方法签名

```js
jim.getFavoriteMessages(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "message",
  "action": "getFavoriteMessages",
  "args": { /* 见下方参数表 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| params | Object | 是 |  | 参数对象 | 1.0.0 |
| message.limit | Number | 否 | 20 | 每次查询的条数 | 1.0.0 |
| message.offset | String | 否 | 空 | 默认为空，查询成功后会返回 `offset`，再次获取需传入返回的 `offset` | 1.0.0 |

## 成功回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| result | Object |  | 1.0.0 |
| result.offset | String | 获取更多标识，再次获取收藏消息时需要传入 `offset` | 1.0.0 |
| result.list | Array | 收藏列表，`list.lenght` 小于等于 `limit` 时表示数据已取完，`offset` 会返回空 `字符串` | 1.0.0 |
| result.list[0] | Array | 收藏的 [Message](/docs/client/sdkintro/msg/message/) 对象 | 1.0.0 |

## 失败回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| error | Object | 发送失败后会有对应的状态码，可以直接查看 `error.msg`，或者查看 [状态码](../../../../sdkintro/status_code/web) | 1.0.0 |

## 示例代码

```js
let params = {
  offset: '',
  limit: 20
};

jim.getFavoriteMessages(params).then((result) => {

  let { offset, list } = result;

  // offset => 分页标识
  
  // list => 收藏消息列表

}, (error) => {
  console.log(error)
});
```

## 文档来源

- im-docs 源文件：`message/favorite/query.md`