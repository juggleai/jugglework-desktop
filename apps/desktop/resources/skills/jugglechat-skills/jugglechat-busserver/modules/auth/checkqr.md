---
name: jugglechat-busserver.auth.checkqr
module: auth
action: checkqr
title: 检查扫码状态
http_method: POST
http_path: /jim/qrcode/check
path: /jim/qrcode/check
method: POST
source: login/checkqr.md
---

# 检查扫码状态

## 接口信息

| 项 | 值 |
| --- | --- |
| HTTP 方法 | `POST` |
| 接口路径 | `/jim/qrcode/check` |
| Content-Type | `application/json` |
| 限频 | 100次/秒 |

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-busserver",  // 必填：发起请求的 skill 名（router 路由校验用）
  "module": "auth",
  "action": "checkqr",
  "args": {
    "method": "POST",       // HTTP 方法（POST/GET）
    "path": "/jim/qrcode/check",     // 后端 jim 接口路径
    "data": {"id": "xxxxxxx"}
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
| `id` | string | 是 | 要检查的二维码id， 建议每3秒检查一次，扫码成功即可返回登录信息 |

## 完整 router 调用示例

下面是一段可以直接 `curl` 跑的完整请求（参数来自下方 im-docs 请求示例）：

```bash
curl -X POST http://127.0.0.1:17832/router \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "jugglechat-busserver",  // 必填：发起请求的 skill 名
    "module": "auth",
    "action": "checkqr",
    "args": {
      "method": "POST",
      "path": "/jim/qrcode/check",
      "data": {"id": "xxxxxxx"}
    }
  }'
```

## 请求示例（im-docs 原文）

```http
POST /jim/qrcode/check HTTP/1.1
appkey: appkey
Authorization: xxxxxxxxxxxxxxxxxx
Content-Type: application/json

{
  "id":"xxxxxxx"
}
```

## 响应示例

```json
{
  "code":0,
  "msg":"sucess",
  "data":{
    "user_id":"userid1",
    "authorization":"xxxxxxxxx",
    "nickname":"user1",
    "avatar":"xxxxxxxx",
    "status":0,
    "im_token":"xxxxxxxxx"
  }
}
```

## 响应码

| 响应码 | 说明 |
| --- | --- |
| `17006` | 还未被扫码，继续检查 |
| `17007` | 二维码已过期 |

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

- im-docs 源文件：`busserver/login/checkqr.md`