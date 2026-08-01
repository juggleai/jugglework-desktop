---
name: jugglechat-im-sdk.message.searchMessages
module: message
action: searchMessages
title: 本地消息搜索
source: message/operator/his_lc_search.md
---

# 本地消息搜索

## 方法签名

```js
jim.searchMessages(args)
```

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-im-sdk",  // 必填：发起请求的 skill 名
  "module": "message",
  "action": "searchMessages",
  "args": { /* 见下方参数表 */ }
}
```

## 参数说明

| 名称 | 类型 | 必填 | 描述 | 版本 |
|---|---|---|---|---|
| params | Object | 是 | 消息搜索参数 | 1.0.0 |
| params.conversationType | Number | 否 | [会话类型](../../../enum/web#conversation) | 1.0.0 |
| params.conversationId | String | 否 | 会话 Id，传值表示搜索 “单个会话消息”，传空表示搜索 “全部会话消息” | 1.0.0 |
| params.keywords | Array | 是 | 消息搜索关键字，最多支持 5 个，多个关键字之间是 “或” 的关系 | 1.0.0 |
| params.senderIds | Number | 否 | 过滤指定消息发送者的消息 | 1.0.0 |
| params.messageNames | Number | 否 | 过滤指定消息类型的消息 | 1.0.0 |
| params.startTime | Number | 否 | 过滤指定时间段的开始时间，时间戳，单位：ms | 1.0.0 |
| params.endTime | Number | 否 | 过滤指定时间段的结束时间，时间戳，单位：ms | 1.0.0 |
| params.page | Number | 否 | 默认值 1，支持分页的页码，默认第一页 | 1.0.0 |
| params.pageSize | Number | 否 | 默认值 10，每页的数据条数 | 1.0.0 |

## 成功回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| result | Object |  | 1.0.0 |
| result.isFinished | Boolean | 是否还有更多的搜索结果 | 1.0.0 |
| result.total | Number | 全部会话搜索：表示全部会话中命中关键词的总条数 <br/> 单个会话搜索：表示该会话内命中关键词的条数 | 1.0.0 |
| result.list | Array | 全部会话搜索：表示全部会话中命中关键词的消息列表，支持分页获取 <br/> 单个会话搜索：表示该会话内命中关键词的消息列表，支持分页获取 | 1.0.0 |

## 失败回调

| 名称 | 类型 | 描述 | 版本 |
|---|---|---|---|
| error | Object | 发送失败后会有对应的状态码，可以直接查看 `error.msg`，或者查看 [状态码](../../../../sdkintro/status_code/web) | 1.0.0 |

## 示例代码

```js
let params = {
  keywords: ['HelloChat'],
};
jim.searchMessages(params).then(({ isFinished, total, list }) => {
  console.log(isFinished, total, list)
});
```

## 文档来源

- im-docs 源文件：`message/operator/his_lc_search.md`