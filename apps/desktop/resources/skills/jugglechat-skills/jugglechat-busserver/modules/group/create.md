---
name: jugglechat-busserver.group.create
module: group
action: create
title: 创建群组
http_method: POST
http_path: /jim/groups/create
path: /jim/groups/create
method: POST
source: groups/groupmanage/creategroup.md
---

# 创建群组

## 接口信息

| 项 | 值 |
| --- | --- |
| HTTP 方法 | `POST` |
| 接口路径 | `/jim/groups/create` |
| Content-Type | `application/json` |
| 限频 | 100次/秒 |

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-busserver",  // 必填：发起请求的 skill 名（router 路由校验用）
  "module": "group",
  "action": "create",
  "args": {
    "method": "POST",       // HTTP 方法（POST/GET）
    "path": "/jim/groups/create",     // 后端 jim 接口路径
    "data": {"group_name": "group1", "group_portrait": "https://aaaa.png", "member_ids": ["userid1", "userid2"]}
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
| `group_name` | string | 是 | 群组昵称 |
| `group_portrait` | string | 否 | 群组头像 |
| `members.user_id` | string | 是 | 入群成员用户id |

## 完整 router 调用示例

下面是一段可以直接 `curl` 跑的完整请求（参数来自下方 im-docs 请求示例）：

```bash
curl -X POST http://127.0.0.1:17832/router \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "jugglechat-busserver",  // 必填：发起请求的 skill 名
    "module": "group",
    "action": "create",
    "args": {
      "method": "POST",
      "path": "/jim/groups/create",
      "data": {"group_name": "group1", "group_portrait": "https://aaaa.png", "member_ids": ["userid1", "userid2"]}
    }
  }'
```

## 请求示例（im-docs 原文）

```http
POST /jim/groups/create HTTP/1.1
appkey: appkey
Authorization: xxxxxxxxxxxxxxxxxx
Content-Type: application/json

{
  "group_name":"group1",
  "group_portrait":"https://aaaa.png",
  "member_ids":["userid1","userid2"]
}
```

## 响应示例

```json
{
  "code":0,
  "msg":"sucess",
  "data":{
    "group_id":"groupid1",
    "group_name":"group1",
    "group_portrait":"https://aaaa.png"
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

- im-docs 源文件：`busserver/groups/groupmanage/creategroup.md`