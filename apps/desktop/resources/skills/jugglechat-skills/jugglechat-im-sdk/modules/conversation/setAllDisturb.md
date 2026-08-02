---
name: jugglechat-im-sdk.conversation.setAllDisturb
module: conversation
action: setAllDisturb
title: 设置全局免打扰
source: conversation/operator/set_disturb_all.md
---

# 设置全局免打扰

## 方法签名

```js
jim.setAllDisturb(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "conversation",
  "action": "setAllDisturb",
  "args": { /* args 字段见下方参数表（平铺，不含 params/message 等形参前缀层）；具体形状以「示例代码」中 jim.<action>(...) 的实参对象为准 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 默认值 | 描述 | 版本 |
|---|---|---|---|---|---|
| args | Object | 是 | 无 |  | 1.0.0 |
| args.type | Number | 是 | 无 | [免打扰类型](../../../enum/web#disturb) | 1.0.0 |
| args.timezone | String | [UndisturbType.DISTURB](../../../enum/web#disturb) 时必传 | 无 | 时区字符串，例如：`Asia/Shanghai` | 1.3.0 |
| args.times | Array | [UndisturbType.DISTURB](../../../enum/web#disturb) 时必传 | 无 | 免打扰时间段，支持设置多个，请参考示例 | 1.3.0 |

## 示例代码

```js
let { UndisturbType } = JIM;

 let params = {
  type: 1,
  timezone: 'Asia/Shanghai',
  times: [
    // 上午 8 点 至上午 12 点免打扰
    { start: '08:00', end: '12:00' },
    
    // 下午 19 点 至下午 20 点免打扰
    { start: '19:00', end: '20:00' },
    
    // 晚上 23 点 至次日早 6 点免打扰
    { start: '23:00', end: '06:00' },
  ]
};

jim.setAllDisturb(params).then(() => {
  console.log('set all disturb successfully');
});
```

## 文档来源

- im-docs 源文件：`conversation/operator/set_disturb_all.md`