---
name: jugglechat-im-sdk.conversation.getConversationTags
module: conversation
action: getConversationTags
title: 获取标签列表
source: conversation/tag/get.md
---

# 获取标签列表

## 方法签名

```js
jim.getConversationTags(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "conversation",
  "action": "getConversationTags",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 失败回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| error | Object | 发送失败后会有对应的状态码，可以直接查看 `error.msg`，或者查看 [状态码](../../../../sdkintro/status_code/web) | 1.0.0 |

## 示例代码

```js
jim.getConversationTags().then(({ tags }) => {
  /* tags =>  [{ id: 'tag_01', name: '我的关注' }, ... ] */
}, (error) => {
  console.log(error)
});
```

## 文档来源

- im-docs 源文件：`conversation/tag/get.md`