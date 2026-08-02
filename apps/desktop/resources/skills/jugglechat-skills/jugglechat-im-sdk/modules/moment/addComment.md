---
name: jugglechat-im-sdk.moment.addComment
module: moment
action: addComment
title: 添加评论
source: moment/commentadd.md
---

# 添加评论

## 方法签名

```js
jim.addComment(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "moment",
  "action": "addComment",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 | - | 评论信息 | 1.9.6 |
| args.momentId | String | 是 | - | 朋友圈 ID | 1.9.6 |
| args.parentCommentId | String | 否 | - | 回复的评论 ID，回复根评论时为空字符串 | 1.9.6 |
| args.content | Object | 是 | - | 评论内容 | 1.9.6 |

## 回调说明

| 属性 | 类型 | 描述 | 版本 |
|---|---|---|---|
| result | Object | 查询结果 | 1.9.6 |
| result.comment | Object | 评论对象，结构请查看 [Comment](../moment_model) | 1.9.6 |

## 示例代码

```js
// 回复评论
let comment = {
  momentId: 'momentId',
  parentCommentId: '',
  content: {
    text: '这是一条回复根评论'
  }
};
jim.addComment(comment).then((result) => {
  console.log('addComment successfully', result)
});

// 回复子评论
let content = {
  text: '这是一条回复子评论'
};
jim.addComment({
  momentId: 'momentId',
  parentCommentId: 'parentCommentId',
  content
}).then((result) => {
  console.log('addComment successfully', result)
});
```

## 文档来源

- im-docs 源文件：`moment/commentadd.md`