---
name: jugglechat-busserver.assistant.answer
module: assistant
action: answer
title: 智能回复
http_method: POST
http_path: /jim/assistants/answer
path: /jim/assistants/answer
method: POST
source: assistants/aianswer.md
---

# 智能回复

## 接口信息

| 项 | 值 |
| --- | --- |
| HTTP 方法 | `POST` |
| 接口路径 | `/jim/assistants/answer` |
| Content-Type | `application/json` |
| 限频 | 100次/秒 |

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-busserver",  // 必填：发起请求的 skill 名（router 路由校验用）
  "module": "assistant",
  "action": "answer",
  "args": {
    "method": "POST",       // HTTP 方法（POST/GET）
    "path": "/jim/assistants/answer",     // 后端 jim 接口路径
    "data": {"conver_id": "xx", "channel_type": 1, "prompt_id": "xxx", "msgs": [{"sender_id": "xx", "content": "xxxxx", "msg_time": 1741234567893}]}
  },
  "meta": { /* 可选附加元数据 */ }
}
```

## 鉴权

> 接口需要增加验证 Header，请查看 鉴权说明

所有请求需要带两个 header：

- `appkey`: 应用唯一标识（环境变量 `JUGGLECHAT_APPKEY`）
- `Authorization`: 登录成功下发的 token（`session.json` 中缓存）

## 请求参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `conver_id` | string | 是 | 会话id |
| `channel_type` | int | 是 | 会话类型，1：单聊；2：群聊 |
| `prompt_id` | string | 否 | 提示词id |
| `msgs` | array | 否 | 会话中最新的n条消息 |

## 完整 router 调用示例

下面是一段可以直接 `curl` 跑的完整请求（参数来自下方 im-docs 请求示例）：

```bash
curl -X POST http://127.0.0.1:17832/router \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "jugglechat-busserver",  // 必填：发起请求的 skill 名
    "module": "assistant",
    "action": "answer",
    "args": {
      "method": "POST",
      "path": "/jim/assistants/answer",
      "data": {"conver_id": "xx", "channel_type": 1, "prompt_id": "xxx", "msgs": [{"sender_id": "xx", "content": "xxxxx", "msg_time": 1741234567893}]}
    }
  }'
```

## 请求示例（im-docs 原文）

```http
POST /jim/assistants/answer HTTP/1.1
appkey: appkey
Authorization: xxxxxxxxxxxxxxxxxx
Content-Type: application/json

{
  "conver_id":"xx",
  "channel_type":1,
  "prompt_id":"xxx",
  "msgs":[
    {
      "sender_id":"xx",
      "content":"xxxxx",
      "msg_time":1741234567893
    }
  ]
}
```

## 响应示例

```json
{
  "code":0,
  "msg":"sucess",
  "data":{
    "answer":"xxxxxxxxx"
  }
}
```

## 通用响应格式

所有接口统一返回：

```json
{
  "code": 0,           // 0=成功，其它见 响应码 章节或全局错误码
  "msg": "success",    // 人类可读信息
  "data": { /* 业务数据；可能为 null 或对象 */ }
}
```

## 文档来源

- im-docs 源文件：`busserver/assistants/aianswer.md`