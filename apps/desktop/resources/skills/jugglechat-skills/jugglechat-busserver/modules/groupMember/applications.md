---
name: jugglechat-busserver.groupMember.applications
module: groupMember
action: applications
title: 入群申请列表
http_method: GET
http_path: /jim/groups/grpapplications
path: /jim/groups/grpapplications
method: GET
source: groups/membermanage/grpapplications.md
---

# 入群申请列表

## 接口信息

| 项 | 值 |
| --- | --- |
| HTTP 方法 | `GET` |
| 接口路径 | `/jim/groups/grpapplications` |
| Content-Type | `application/json` |
| 限频 | 100次/秒 |

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-busserver",  // 必填：发起请求的 skill 名（router 路由校验用）
  "module": "groupMember",
  "action": "applications",
  "args": {
    "method": "GET",       // HTTP 方法（POST/GET）
    "path": "/jim/groups/grpapplications",     // 后端 jim 接口路径
    "query": {"group_id": "group1", "start": "1734407505753", "count": "50"}
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
| `group_id` | 是 | 群组id |  |
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
    "module": "groupMember",
    "action": "applications",
    "args": {
      "method": "GET",
      "path": "/jim/groups/grpapplications",
      "query": {"group_id": "group1", "start": "1734407505753", "count": "50"}
    }
  }'
```

## 请求示例（im-docs 原文）

```http
GET /jim/groups/grpapplications?group_id=group1&start=1734407505753&count=50 HTTP/1.1
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
            "apply_type":1,   //0:邀请；1:主动申请；
            "sponsor":{  //主动申请入群时，申请人信息
              "user_id":"userid1"
            },
            "inviter":{  //邀请入群时，邀请人信息
              "user_id":"userid2"
            },
            "recipient":{  //邀请入群时，被邀请人信息
              "user_id":"userid3"
            },
            "operator":{   //处理请求的管理员信息
              "user_id":"userid4"
            },
            "status":1,    // 0：申请中；1：同意申请；2：拒绝申请；3：申请已过期; 10：邀请中；11：同意邀请；12：拒绝邀请；13：邀请已过期；
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

- im-docs 源文件：`busserver/groups/membermanage/grpapplications.md`