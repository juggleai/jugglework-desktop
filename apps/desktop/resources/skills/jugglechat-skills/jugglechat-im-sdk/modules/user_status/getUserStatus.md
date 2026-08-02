---
name: jugglechat-im-sdk.user_status.getUserStatus
module: user_status
action: getUserStatus
title: 查询状态
source: user_status/get.md
---

# 查询状态

## 方法签名

```js
jim.getUserStatus(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "user_status",
  "action": "getUserStatus",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 |  | 查询参数 | 1.0.0 |
| args.userIds | Array | 是 |  | 用户 ID 列表 | 1.0.0 |

## 回调说明

| 属性 | 类型 | 描述 | 版本 |
|---|---|---|---|
| result | Object | 查询结果 | 1.0.0 |
| result.users | Array | 用户状态列表 | 1.0.0 |
| result.users[].userId | String | 用户 ID | 1.0.0 |
| result.users[].status | Number | 状态值，`1` 表示在线，`2` 表示离线 | 1.0.0 |

## 失败回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| error | Object | 发送失败后会有对应的状态码，可以直接查看 `error.msg`，或者查看 [状态码](../../status_code/web) | 1.0.0 |

## 示例代码

```js
let params = {
  userIds: ['6UXQ4u8q57G']
};

juggle.getUserStatus(params).then((result) => {
  console.log('getUserStatus', result);
  // result.users => [{ userId: '6UXQ4u8q57G', status: 1 }]
}, (error) => {
  console.log(error);
});
```

## 文档来源

- im-docs 源文件：`user_status/get.md`