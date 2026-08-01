---
name: jugglechat-busserver.friend.applications
module: friend
action: applications
title: 好友申请列表
http_method: GET
http_path: /jim/friends/applications
path: /jim/friends/applications
method: GET
source: friends/friendapplications.md
---

# 好友申请列表

## 接口信息

| 项 | 值 |
| --- | --- |
| HTTP 方法 | `GET` |
| 接口路径 | `/jim/friends/applications` |
| Content-Type | `application/json` |
| 限频 | 100次/秒 |

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-busserver",  // 必填：发起请求的 skill 名（router 路由校验用）
  "module": "friend",
  "action": "applications",
  "args": {
    "method": "GET",       // HTTP 方法（POST/GET）
    "path": "/jim/friends/applications",     // 后端 jim 接口路径
    "query": {"start": "1734407505753", "count": "50"}
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
| `start` | int | 否 | 查询列表的开始时间戳，倒序查询时，默认从当前时间开始；正序查询时，默认从0开始 |
| `count` | int | 否 | 单页数量，默认20，最大不超过50 |
| `order` | int | 否 | 查询顺序。0：倒序；1：正序；默认0 |

## 完整 router 调用示例

下面是一段可以直接 `curl` 跑的完整请求（参数来自下方 im-docs 请求示例）：

```bash
curl -X POST http://127.0.0.1:17832/router \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "jugglechat-busserver",  // 必填：发起请求的 skill 名
    "module": "friend",
    "action": "applications",
    "args": {
      "method": "GET",
      "path": "/jim/friends/applications",
      "query": {"start": "1734407505753", "count": "50"}
    }
  }'
```

## 请求示例（im-docs 原文）

```http
GET /jim/friends/applications?start=1734407505753&count=50 HTTP/1.1
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
            "target_user":{ //申请发起方用户信息
                "user_id":"userid1",
                "nickname":"user1",
                "avatar":"https://file.juggle.im/abcdfafsdaf.png"
            },
            "is_sponsor":true, //是否发起者
            "status":1,    // 0：申请中；1：已同意；2：已拒绝；3：申请已过期
            "apply_time":1734407505000   //申请发起时间
        }
    ]
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

- im-docs 源文件：`busserver/friends/friendapplications.md`