---
name: jugglechat-im-sdk.moment.getReactions
module: moment
action: getReactions
title: 点赞列表
source: moment/reactions.md
---

# 点赞列表

## 方法签名

```js
jim.getReactions(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "moment",
  "action": "getReactions",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 | - | 获取点赞列表参数 | 1.9.6 |
| args.momentId | String | 是 | - | 朋友圈 Id | 1.9.6 |

## 回调说明

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| result | Object | 获取点赞列表结果 | 1.9.6 |
| result.reactions | Array | 互动类型列表，对象结构请查看 [Reaction](../moment_model) | 1.9.6 |

## 示例代码

```js
jim.getReactions({
  momentId: 'momentId',
}).then((result) => {
  console.log('getReactions', result)
})
```

## 文档来源

- im-docs 源文件：`moment/reactions.md`