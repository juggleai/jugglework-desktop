---
name: jugglechat-im-sdk.conversation.destroyConversationTag
module: conversation
action: destroyConversationTag
title: 销毁标签
source: conversation/tag/destroy.md
---

# 销毁标签

## 方法签名

```js
jim.destroyConversationTag(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "conversation",
  "action": "destroyConversationTag",
  "args": { /* 见下方参数表 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| tag | Object | 是 |  | Tag 对象 | 1.7.5 |
| tag.id | String | 是 |  | 标签 ID，开发者可自定义，最大长度 64 个字符 | 1.7.5 |

## 失败回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| error | Object | 发送失败后会有对应的状态码，可以直接查看 `error.msg`，或者查看 [状态码](../../../../sdkintro/status_code/web) | 1.0.0 |

## 示例代码

```js
let tag = {
  id: 'tag_01'
};

jim.destroyConversationTag(tag).then(() => {
  console.log('destroyConversationTag successfully')
}, (error) => {
  console.log(error)
});
```

## 文档来源

- im-docs 源文件：`conversation/tag/destroy.md`