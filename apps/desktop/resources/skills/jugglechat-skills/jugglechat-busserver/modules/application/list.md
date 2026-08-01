---
name: jugglechat-busserver.application.list
module: application
action: list
title: 应用列表
http_method: GET
http_path: /jim/applications/list
path: /jim/applications/list
method: GET
source: applications/applist.md
---

# 应用列表

## 接口信息

| 项 | 值 |
| --- | --- |
| HTTP 方法 | `GET` |
| 接口路径 | `/jim/applications/list` |
| Content-Type | `application/json` |
| 限频 | 100次/秒 |

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-busserver",  // 必填：发起请求的 skill 名（router 路由校验用）
  "module": "application",
  "action": "list",
  "args": {
    "method": "GET",       // HTTP 方法（POST/GET）
    "path": "/jim/applications/list",     // 后端 jim 接口路径
    "query": {"page": "1", "size": "20", "order": "0"}
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

无（GET 请求通过 query string 传参，POST 请求 body 为空）。

## 完整 router 调用示例

下面是一段可以直接 `curl` 跑的完整请求（参数来自下方 im-docs 请求示例）：

```bash
curl -X POST http://127.0.0.1:17832/router \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "jugglechat-busserver",  // 必填：发起请求的 skill 名
    "module": "application",
    "action": "list",
    "args": {
      "method": "GET",
      "path": "/jim/applications/list",
      "query": {"page": "1", "size": "20", "order": "0"}
    }
  }'
```

## 请求示例（im-docs 原文）

```http
GET /jim/applications/list?page=1&size=20&order=0 HTTP/1.1
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
        "app_id":"xxx",
        "app_name":"xxx",
        "app_icon":"xxxx",
        "app_desc":"xxxx",
        "app_url":"https://abc.aab.com",
        "app_order":1,
        "created_time":1721234567890,
        "updated_time":1721234567890
      }
    ],
    "page":1,
    "size":20
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

- im-docs 源文件：`busserver/applications/applist.md`