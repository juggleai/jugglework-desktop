---
name: jugglechat-busserver.user.updsettings
module: user
action: updsettings
title: 更新用户设置
http_method: POST
http_path: /jim/users/updsettings
path: /jim/users/updsettings
method: POST
source: users/updusersettings.md
---

# 更新用户设置

## 接口信息

| 项 | 值 |
| --- | --- |
| HTTP 方法 | `POST` |
| 接口路径 | `/jim/users/updsettings` |
| Content-Type | `application/json` |
| 限频 | 100次/秒 |

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-busserver",  // 必填：发起请求的 skill 名（router 路由校验用）
  "module": "user",
  "action": "updsettings",
  "args": {
    "method": "POST",       // HTTP 方法（POST/GET）
    "path": "/jim/users/updsettings",     // 后端 jim 接口路径
    "data": {"language": "zh_CN", "friend_verify_type": 1, "grp_verify_type": 1, "undisturb": {"switch": true, "timezone": "", "rules": [{"start": "1100", "end": "1500"}]}}
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
| `language` | string | 是 | 推送语言 |
| `friend_verify_type` | int | 是 | 好友验证。0：不需要验证，可直接被加好友；1：需要同意才能被加好友；2：拒绝任何人加我好友； |
| `grp_verify_type` | int | 是 | 进群验证。0：不需要验证，任何人都可拉我入群；1：需要我同意，才能被拉入群；2：拒绝任何人拉我入群； |
| `undisturb.switch` | bool | 否 | 是否开启全局免打扰，如果开启，rules中设置的时段期间，消息为免打扰状态，如果rules没设置时段，则全天免打扰 |
| `undisturb.timezone` | string | 否 | 时段对应的时区，为空时使用服务器部署所在地的默认时区 |
| `undisturb.rules.start` | string | 否 | 设置免打扰的开始时间，HHmm格式，24小时制 |
| `undisturb.rules.end` | string | 否 | 设置免打扰的结束时间，HHmm格式，24小时制 |

## 完整 router 调用示例

下面是一段可以直接 `curl` 跑的完整请求（参数来自下方 im-docs 请求示例）：

```bash
curl -X POST http://127.0.0.1:17832/router \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "jugglechat-busserver",  // 必填：发起请求的 skill 名
    "module": "user",
    "action": "updsettings",
    "args": {
      "method": "POST",
      "path": "/jim/users/updsettings",
      "data": {"language": "zh_CN", "friend_verify_type": 1, "grp_verify_type": 1, "undisturb": {"switch": true, "timezone": "", "rules": [{"start": "1100", "end": "1500"}]}}
    }
  }'
```

## 请求示例（im-docs 原文）

```http
POST /jim/users/updsettings HTTP/1.1
appkey: appkey
Authorization: xxxxxxxxxxxxxxxxxx
Content-Type: application/json

{
  "language":"zh_CN",
  "friend_verify_type":1,
  "grp_verify_type":1,
  "undisturb":{
    "switch":true,
    "timezone":"",
    "rules":[
      {
        "start":"1100",
        "end":"1500"
      }
    ]
  }
}
```

## 响应示例

```json
{
  "code":0,
  "msg":"sucess"
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

- im-docs 源文件：`busserver/users/updusersettings.md`