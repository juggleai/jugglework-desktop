---
name: jugglechat-im-sdk.conversation.getAllDisturb
module: conversation
action: getAllDisturb
title: 获取全局免打扰
source: conversation/operator/get_disturb_all.md
---

# 获取全局免打扰

## 方法签名

```js
jim.getAllDisturb(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "conversation",
  "action": "getAllDisturb",
  "args": { /* 见下方参数表 */ }
}
```

## 示例代码

```js
jim.getAllDisturb().then((disturbInfo) => {
  console.log('get disturb successfully', disturbInfo);
});
```

## 文档来源

- im-docs 源文件：`conversation/operator/get_disturb_all.md`