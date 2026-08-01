---
name: jugglechat-im-sdk.moment.removeMoment
module: moment
action: removeMoment
title: 删除朋友圈
source: moment/momentremove.md
---

# 删除朋友圈

## 方法签名

```js
jim.removeMoment(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "moment",
  "action": "removeMoment",
  "args": { /* 见下方参数表 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| params | Object | 是 | - | 朋友圈信息 | 1.9.6 |
| params.momentIds | Array | 是 | - | 要删除的朋友圈 ID 数组 | 1.9.6 |

## 示例代码

```js
let params = {
  momentIds: ['momentId'],
};
jim.removeMoment(params).then(() => {
  console.log('removeMoment successfully')
});
```

## 文档来源

- im-docs 源文件：`moment/momentremove.md`