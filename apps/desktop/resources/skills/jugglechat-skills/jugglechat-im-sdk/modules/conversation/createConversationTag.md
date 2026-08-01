---
name: jugglechat-im-sdk.conversation.createConversationTag
module: conversation
action: createConversationTag
title: 创建标签
source: conversation/tag/add.md
---

# 创建标签

## 方法签名

```js
jim.createConversationTag(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "conversation",
  "action": "createConversationTag",
  "args": { /* 见下方参数表 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| tag | Object | 是 |  | Tag 对象 | 1.7.5 |
| tag.id | String | 是 |  | 标签 ID，开发者可自定义，最大长度 64 个字符 | 1.7.5 |
| tag.name | String | 是 |  | 标签名称，开发者自定义，最大长度 64 个字符 | 1.7.5 |
| tag.order | Number | 否 | 0 | 标签排序，开发者自定义，按照指定数字正序排序 | 1.9.13 |

## 失败回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| error | Object | 发送失败后会有对应的状态码，可以直接查看 `error.msg`，或者查看 [状态码](../../../../sdkintro/status_code/web) | 1.0.0 |

## 示例代码

```js
let tag = {
  id: 'tag_01',
  name: '我的关注',
  order: 1
};

jim.createConversationTag(tag).then(() => {
  console.log('createConversationTag successfully')
}, (error) => {
  console.log(error)
});
```

## 文档来源

- im-docs 源文件：`conversation/tag/add.md`