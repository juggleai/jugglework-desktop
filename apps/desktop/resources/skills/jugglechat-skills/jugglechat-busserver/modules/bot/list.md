---
name: jugglechat-busserver.bot.list
module: bot
action: list
title: Bot列表
http_method: GET
http_path: /jim/bots/list
path: /jim/bots/list
method: GET
source: bots/botlist.md
---

# Bot列表

## 接口信息

| 项 | 值 |
| --- | --- |
| HTTP 方法 | `GET` |
| 接口路径 | `/jim/bots/list` |
| Content-Type | `application/json` |
| 限频 | 100次/秒 |

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-busserver",  // 必填：发起请求的 skill 名（router 路由校验用）
  "module": "bot",
  "action": "list",
  "args": {
    "method": "GET",       // HTTP 方法（POST/GET）
    "path": "/jim/bots/list",     // 后端 jim 接口路径
    "query": {"count": "50"}
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
| `offset` | string | 否 | 用于分页，查询Bot列表的起始位置 |
| `count` | int | 否 | 单页数量，默认20，最大不超过50 |

## 完整 router 调用示例

下面是一段可以直接 `curl` 跑的完整请求（参数来自下方 im-docs 请求示例）：

```bash
curl -X POST http://127.0.0.1:17832/router \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "jugglechat-busserver",  // 必填：发起请求的 skill 名
    "module": "bot",
    "action": "list",
    "args": {
      "method": "GET",
      "path": "/jim/bots/list",
      "query": {"count": "50"}
    }
  }'
```

## 请求示例（im-docs 原文）

```http
GET /jim/bots/list?count=50 HTTP/1.1
appkey: appkey
Authorization: xxxxxxxxxxxxxxxxxx
Content-Type: application/json
```

## 响应示例

```json
{
  "code":0,
  "msg":"sucess",
  "data":{
    "items":[
        {
            "bot_id":"botid1",
            "nickname":"bot1",
            "avatar":"https://file.juggle.im/abcdfafsdaf.png"
        },{
            "user_id":"botid2",
            "nickname":"bot2",
            "avatar":"https://file.juggle.im/abcdfafsdaf.png"
        }
    ],
    "offset":"xxxx"
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

- im-docs 源文件：`busserver/bots/botlist.md`