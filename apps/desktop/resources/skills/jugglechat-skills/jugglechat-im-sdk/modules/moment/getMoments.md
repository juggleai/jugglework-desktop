---
name: jugglechat-im-sdk.moment.getMoments
module: moment
action: getMoments
title: 朋友圈列表
source: moment/moments.md
---

# 朋友圈列表

## 方法签名

```js
jim.getMoments(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "moment",
  "action": "getMoments",
  "args": { /* 见下方参数表 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| option | Object | 否 |  |  | 1.9.6 |
| option.count | Number | 否 | 50 | 获取指定数量的朋友圈，单次最多获取 20 条记录 | 1.9.6 |
| option.order | Number | 否 | [获取方向](../../enum/web#moment_order) | 获取方向，支持按 `time` 获取更早的朋友圈或者更（四声）新的朋友圈 | 1.9.6 |
| option.time | Number | 否 | 0 | 从指定时间点开始获取朋友圈，可以配合 `order` 使用 | 1.9.6 |
| option.userId | String | 否 | - | 获取指定用户发布的朋友圈列表，为空表示获取所有好友的朋友圈列表。 | 1.9.8 |

## 回调说明

| 属性 | 类型 | 描述 | 版本 |
|---|---|---|---|
| result | Object | 查询结果 | 1.9.6 |
| result.moments | Array | 朋友圈数组，单个朋友圈对象结构请查看 [Moment](/docs/client/sdkintro/moment/moment_model/) | 1.9.6 |
| result.isFinished | Boolean | 标志会话是否获取完成 | 1.9.6 |

## 示例代码

```js
/* 
  假设当前用户有 79 个朋友圈，每页获取 20 条，朋友圈列表按时间倒序排列，实现朋友圈列表分页逻辑如下：
  1、加载第 1 页获取参数： { count: 20, time: 0 }
  2、加载第 2 页获取参数： { count: 20, time: '获取第 1 页朋友圈数组中最小的 momentTime' }
  3、加载第 3 页获取参数： { count: 20, time: '获取第 2 页朋友圈数组中最小的 momentTime' }  
  4、加载第 4 页获取参数： { count: 20, time: '获取第 3 页朋友圈数组中最小的 momentTime' }
  5、结束：isFinished 返回 true，停止加载
*/
jim.getMoments().then((result) => {
  let { moments, isFinished } = result;
  console.log(isFinished, moments); 
})
```

## 文档来源

- im-docs 源文件：`moment/moments.md`