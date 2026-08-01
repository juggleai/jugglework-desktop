---
name: jugglechat-im-sdk.moment.getComments
module: moment
action: getComments
title: 评论列表
source: moment/comments.md
---

# 评论列表

## 方法签名

```js
jim.getComments(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "moment",
  "action": "getComments",
  "args": { /* 见下方参数表 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| option | Object | 否 |  |  | 1.9.6 |
| option.count | Number | 否 | 50 | 获取指定数量的评论，单次最多获取 20 条记录 | 1.9.6 |
| option.order | Number | 否 | [获取方向](../../enum/web#comment_order) | 获取方向，支持按 `time` 获取更早的评论或者更（四声）新的评论 | 1.9.6 |
| option.time | Number | 否 | 0 | 从指定时间点开始获取评论，可以配合 `order` 使用 | 1.9.6 |

## 回调说明

| 属性 | 类型 | 描述 | 版本 |
|---|---|---|---|
| result | Object | 查询结果 | 1.9.6 |
| result.comments | Array | 评论数组，单个评论对象结构请查看 [Comment](../moment_model) | 1.9.6 |
| result.isFinished | Boolean | 标志会话是否获取完成 | 1.9.6 |

## 示例代码

```js
/* 
  假设当前用户有 79 个评论，每页获取 20 条，评论列表按时间倒序排列，实现评论列表分页逻辑如下：  
  1、加载第 1 页获取参数： { count: 20, time: 0 }
  2、加载第 2 页获取参数： { count: 20, time: '获取第 1 页评论数组中最小的 commentTime' }
  3、加载第 3 页获取参数： { count: 20, time: '获取第 2 页评论数组中最小的 commentTime' }  
  4、加载第 4 页获取参数： { count: 20, time: '获取第 3 页评论数组中最小的 commentTime' }
  5、结束：isFinished 返回 true，停止加载
*/
jim.getComments().then((result) => {
  let { comments, isFinished } = result;
  console.log(isFinished, comments);
})
```

## 文档来源

- im-docs 源文件：`moment/comments.md`