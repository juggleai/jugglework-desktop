---
name: jugglechat-im-sdk.moment.addMoment
module: moment
action: addMoment
title: 添加朋友圈
source: moment/momentadd.md
---

# 添加朋友圈

## 方法签名

```js
jim.addMoment(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "moment",
  "action": "addMoment",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 | - | 朋友圈信息 | 1.9.6 |
| args.text | String | `medias` 和 `text` 至少二选一 | - | 朋友圈文本内容，文本字数 500 字以内 | 1.9.6 |
| args.medias | Array | `medias` 和 `text` 至少二选一 | [] | 朋友圈媒体内容，每个元素为 [Media](../moment_model) 结构 | 1.9.6 |

## 回调说明

| 属性 | 类型 | 描述 | 版本 |
|---|---|---|---|
| result | Object | 查询结果 | 1.9.6 |
| result.moment | Array | 朋友圈数组，单个朋友圈对象结构请查看 [Moment](/docs/client/sdkintro/moment/moment_model/) | 1.9.6 |

## 示例代码

```js
// 发布文本朋友圈
let content = {
  text: '这是一条文本朋友圈'
};
jim.addMoment(content).then((result) => {
  console.log('addMoment successfully', result)
});

// 发布图文组合朋友圈
let content = {
  text: '这是一条图文组合朋友圈',
  medias: [
    {
      type: 'image',
      url: 'https://example.com/image.jpg',
    },
  ],
};
jim.addMoment(content).then((result) => {
  console.log('addMoment successfully', result)
});
```

## 文档来源

- im-docs 源文件：`moment/momentadd.md`