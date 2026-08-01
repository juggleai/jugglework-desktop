---
name: jugglechat-busserver.groupAdmin.list
module: groupAdmin
action: list
title: 查询群管理员列表
http_method: GET
http_path: /jim/groups/management/administrators/list
path: /jim/groups/management/administrators/list
method: GET
source: groups/groupadmins/qrygroupmembers.md
---

# 查询群管理员列表

## 接口信息

| 项 | 值 |
| --- | --- |
| HTTP 方法 | `GET` |
| 接口路径 | `/jim/groups/management/administrators/list` |
| Content-Type | `application/json` |
| 限频 | 100次/秒 |

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-busserver",  // 必填：发起请求的 skill 名（router 路由校验用）
  "module": "groupAdmin",
  "action": "list",
  "args": {
    "method": "GET",       // HTTP 方法（POST/GET）
    "path": "/jim/groups/management/administrators/list",     // 后端 jim 接口路径
    "query": {"group_id": "groupid1"}
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
| `group_id` | string | 是 | 群组id |

## 完整 router 调用示例

下面是一段可以直接 `curl` 跑的完整请求（参数来自下方 im-docs 请求示例）：

```bash
curl -X POST http://127.0.0.1:17832/router \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "jugglechat-busserver",  // 必填：发起请求的 skill 名
    "module": "groupAdmin",
    "action": "list",
    "args": {
      "method": "GET",
      "path": "/jim/groups/management/administrators/list",
      "query": {"group_id": "groupid1"}
    }
  }'
```

## 请求示例（im-docs 原文）

```http
GET /jim/groups/management/administrators/list?group_id=groupid1 HTTP/1.1
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
    "group_id":"group1",
    "items":[
      {
        "user_id":"userid1",
        "nickname":"user1",
        "avatar":"https://aaabbcc.png",
        "member_type":0,// 0:普通用户；1：机器人；
        "role":2  //0:群成员；1：群主；2：群管理员
      },{
        "user_id":"userid2",
        "nickname":"user2",
        "avatar":"https://aaabbcc.png",
        "member_type":0,// 0:普通用户；1：机器人；
        "role":2  //0:群成员；1：群主；2：群管理员
      }
    ],
    "offset":"xxx"
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

- im-docs 源文件：`busserver/groups/groupadmins/qrygroupmembers.md`