---
name: jugglechat-im-sdk.moment.removeComment
module: moment
action: removeComment
title: 删除评论
source: moment/commentremove.md
---

# 删除评论

## 方法签名

```js
jim.removeComment(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "moment",
  "action": "removeComment",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 | - | 删除评论参数 | 1.9.6 |
| args.momentId | String | 是 | - | 朋友圈 Id | 1.9.6 |
| args.commentIds | Array | 是 | - | 评论 Id | 1.9.6 |

## 示例代码

```js
// 删除评论
let params = {
  momentId: 'momentId',
  commentIds: ['commentId1', 'commentId2']
};
jim.removeComment(params).then(() => {
  console.log('removeComment successfully');
});
```

## 文档来源

- im-docs 源文件：`moment/commentremove.md`