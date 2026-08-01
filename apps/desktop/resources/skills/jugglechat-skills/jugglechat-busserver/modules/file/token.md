---
name: jugglechat-busserver.file.token
module: file
action: token
title: 上传token
http_method: POST
http_path: /jim/file_cred
path: /jim/file_cred
method: POST
source: files/filetoken.md
---

# 上传token

## 接口信息

| 项 | 值 |
| --- | --- |
| HTTP 方法 | `POST` |
| 接口路径 | `/jim/file_cred` |
| Content-Type | `application/json` |
| 限频 | 100次/秒 |

## 触发 router

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

{
  "source": "jugglechat-busserver",  // 必填：发起请求的 skill 名（router 路由校验用）
  "module": "file",
  "action": "token",
  "args": {
    "method": "POST",       // HTTP 方法（POST/GET）
    "path": "/jim/file_cred",     // 后端 jim 接口路径
    "data": {"file_type": 0, "ext": "jpg"}
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
| `file_type` | int | 0:默认；1:图片；2: 语音；3: 视频；4: 文件；5: 日志； |  |
| `ext` | string | 文件扩展名 |  |

## 完整 router 调用示例

下面是一段可以直接 `curl` 跑的完整请求（参数来自下方 im-docs 请求示例）：

```bash
curl -X POST http://127.0.0.1:17832/router \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "jugglechat-busserver",  // 必填：发起请求的 skill 名
    "module": "file",
    "action": "token",
    "args": {
      "method": "POST",
      "path": "/jim/file_cred",
      "data": {"file_type": 0, "ext": "jpg"}
    }
  }'
```

## 请求示例（im-docs 原文）

```http
POST /jim/file_cred HTTP/1.1
appkey: appkey
Authorization: xxxxxxxxxxxxxxxxxx
Content-Type: application/json

{
  "file_type":0,
  "ext":"jpg"
}
```

## 响应示例

```json
{
  "code":0,
  "msg":"sucess",
  "data":{
    "oss_type":0,
    "qiniu_resp":{
      "domain":"xxxxx",
      "token":"xxxxxxx"
    },
    "pre_sign_resp":{
      "url":"xxxxxx",
      "obj_key":"xxx",
      "policy":"policy",
      "sign_version":"xxx",
      "credential":"xxxx",
      "date":"xxx",
      "signature":"xxxx"
    }
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

- im-docs 源文件：`busserver/files/filetoken.md`