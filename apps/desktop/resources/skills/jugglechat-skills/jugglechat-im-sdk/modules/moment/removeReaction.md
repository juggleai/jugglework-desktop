---
name: jugglechat-im-sdk.moment.removeReaction
module: moment
action: removeReaction
title: 删除点赞
source: moment/reactionremove.md
---

# 删除点赞

## 方法签名

```js
jim.removeReaction(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "moment",
  "action": "removeReaction",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 | - | 删除点赞参数 | 1.9.6 |
| args.momentId | String | 是 | - | 朋友圈 Id | 1.9.6 |
| args.reaction | Object | 是 | - | 互动类型 | 1.9.6 |
| args.reaction.key | String | 是 | - | 互动类型 key, 详见代码示例 | 1.9.6 |

## 示例代码

```js
jim.removeReaction({
  momentId: 'momentId',
  reaction: {
    key: 'like',
  },
}).then(() => {
  console.log('removeReaction successfully');
})
```

## 文档来源

- im-docs 源文件：`moment/reactionremove.md`