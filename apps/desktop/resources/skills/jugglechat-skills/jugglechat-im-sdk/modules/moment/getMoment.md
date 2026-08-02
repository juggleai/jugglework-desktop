---
name: jugglechat-im-sdk.moment.getMoment
module: moment
action: getMoment
title: 获取朋友圈
source: moment/momentget.md
---

# 获取朋友圈

## 方法签名

```js
jim.getMoment(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "moment",
  "action": "getMoment",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 | - | 朋友圈信息 | 1.9.6 |
| args.momentId | String | 是 | - | 朋友圈 ID | 1.9.6 |

## 回调说明

| 属性 | 类型 | 描述 | 版本 |
|---|---|---|---|
| result | Object | 查询结果 | 1.9.6 |
| result.moment | Object | 朋友圈对象，结构请查看 [Moment](/docs/client/sdkintro/moment/moment_model/) | 1.9.6 |

## 示例代码

```js
// 获取单个朋友圈信息
let momentId = '';
jim.getMoment({ momentId }).then((result) => {
  console.log('getMoment successfully', result)
});
```

## 文档来源

- im-docs 源文件：`moment/momentget.md`