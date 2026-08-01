#!/usr/bin/env python3
"""Build the jugglechat-busserver skill from extracted busserver_docs.json."""
from __future__ import annotations

import json
import re
from pathlib import Path
from collections import defaultdict

SRC = Path("/Applications/work/ai-skills-research/_sdk_extract/busserver_docs.json")
DEST = Path("/Applications/work/ai-skills-research/jugglechat-busserver")
DEST.mkdir(parents=True, exist_ok=True)

CATEGORY_MODULE = {
    "users": "user",
    "users/blockusers": "userBlock",
    "friends": "friend",
    "groups/groupmanage": "group",
    "groups/groupadmins": "groupAdmin",
    "groups/membermanage": "groupMember",
    "groups/groupsetting": "groupSetting",
    "msgopt": "message",
    "login": "auth",
    "assistants": "assistant",
    "bots": "bot",
    "telebots": "telebot",
    "applications": "application",
    "feedbacks": "feedback",
    "files": "file",
    "translates": "translate",
}

PATH_ACTION_OVERRIDE = {
    "users/qryuserinfo.md": "info",
    "users/search.md": "search",
    "users/onlinestatus.md": "onlinestatus",
    "users/upduserinfo.md": "update",
    "users/updpass.md": "updpass",
    "users/updusersettings.md": "updsettings",
    "users/bindemail.md": "bindemail",
    "users/bindemail_send.md": "bindemailSend",
    "users/bindphone.md": "bindphone",
    "users/bindphone_send.md": "bindphoneSend",
    "users/blockusers/addblockusers.md": "add",
    "users/blockusers/delblockusers.md": "del",
    "users/blockusers/qryblockusers.md": "list",
    "friends/applyfriend.md": "apply",
    "friends/delfriend.md": "del",
    "friends/friendlist.md": "list",
    "friends/friendapplications.md": "applications",
    "friends/friendsearch.md": "search",
    "friends/ confirmfriend.md": "confirm",
    "friends/setdisplayname.md": "setdisplayname",
    "groups/groupmanage/creategroup.md": "create",
    "groups/groupmanage/dissolvegroup.md": "dissolve",
    "groups/groupmanage/qrygroupinfo.md": "info",
    "groups/groupmanage/qrymygroups.md": "list",
    "groups/groupmanage/searchmygroups.md": "search",
    "groups/groupmanage/updategroup.md": "update",
    "groups/groupadmins/addadmin.md": "add",
    "groups/groupadmins/deladmin.md": "del",
    "groups/groupadmins/qrygroupmembers.md": "list",
    "groups/membermanage/memberapply.md": "apply",
    "groups/membermanage/membercheck.md": "check",
    "groups/membermanage/membersearch.md": "search",
    "groups/membermanage/invitemember.md": "invite",
    "groups/membermanage/delmember.md": "del",
    "groups/membermanage/qrygroupmembers.md": "list",
    "groups/membermanage/grpapplications.md": "applications",
    "groups/membermanage/confirmapplications.md": "confirm",
    "groups/membermanage/quitgroup.md": "quit",
    "groups/groupsetting/chgowner.md": "chgowner",
    "groups/groupsetting/grpmute.md": "setmute",
    "groups/groupsetting/getgrpannouncement.md": "getannouncement",
    "groups/groupsetting/setgrpannouncement.md": "setannouncement",
    "groups/groupsetting/setgrpdisplayname.md": "setdisplayname",
    "groups/groupsetting/setgrpmanageconf.md": "setmanageconf",
    "groups/groupsetting/setgrpmembersmute.md": "setmembersmute",
    "groups/groupsetting/setgrpverifytype.md": "setverifytype",
    "groups/groupsetting/sethismsgvisible.md": "sethismsgvisible",
    "msgopt/delmsgs.md": "del",
    "msgopt/recallmsg.md": "recall",
    "login/login.md": "login",
    "login/passlogin.md": "passlogin",
    "login/register.md": "register",
    "login/getloginqr.md": "getqr",
    "login/checkqr.md": "checkqr",
    "login/confirmqr.md": "confirmqr",
    "login/emaillogin.md": "emaillogin",
    "login/emailsend.md": "emailsend",
    "login/smslogin.md": "smslogin",
    "login/smssend.md": "smssend",
    "assistants/aianswer.md": "answer",
    "assistants/promptadd.md": "add",
    "assistants/promptdel.md": "del",
    "assistants/promptlist.md": "list",
    "assistants/promptupdate.md": "update",
    "assistants/promptbatchdel.md": "batchdel",
    "bots/botlist.md": "list",
    "telebots/botadd.md": "add",
    "telebots/botdel.md": "del",
    "telebots/botlist.md": "list",
    "applications/applist.md": "list",
    "feedbacks/addfeedback.md": "add",
    "files/filetoken.md": "token",
    "translates/translate.md": "translate",
}

MODULE_DESC = {
    "user":         "用户域（资料、设置、密码、登录状态）",
    "userBlock":    "用户黑名单（拉黑/移除/列表）",
    "friend":       "好友域（申请/确认/删除/列表/搜索/备注）",
    "group":        "群组管理（建群/解散/查我的群/更新群）",
    "groupAdmin":   "群管理员（增删查）",
    "groupMember":  "群成员（拉人/踢人/退群/列表/搜索/申请/审批）",
    "groupSetting": "群设置（群主/禁言/公告/昵称/加群验证/历史消息可见）",
    "message":      "消息管理（管理员删除/撤回）",
    "auth":         "登录鉴权（账号/邮箱/短信/二维码登录）",
    "assistant":    "AI 助手（智能回复 / prompt 管理）",
    "bot":          "Bot 列表",
    "telebot":      "Telegram Bot（增删查）",
    "application":  "应用列表",
    "feedback":     "用户反馈上报",
    "file":         "文件上传 token",
    "translate":    "翻译",
}


def extract_jim_path(d: dict) -> str:
    addr = d["request"].get("请求地址", "").replace("//", "/")
    m = re.search(r"(/jim/[^\s?#]+)", addr)
    if m:
        return m.group(1).rstrip("/")
    return ""


def extract_jim_path_from_example(d: dict) -> str:
    """Fallback: extract from request example."""
    ex = d.get("request_example") or ""
    m = re.search(r"((?:POST|GET|PUT|DELETE))\s+(/jim/\S+)", ex)
    if m:
        return m.group(2).rstrip("/")
    return ""


def render_action_file(d: dict, module: str, action: str) -> str:
    title = d["title"]
    req = d["request"]
    params = d["params"]
    req_example = d.get("request_example") or ""
    res_example = d.get("response_example") or ""
    res_codes = d.get("response_codes") or []
    file_rel = d["file"]

    # Derive the jim URL path
    jim_path = extract_jim_path(d) or extract_jim_path_from_example(d)
    if not jim_path:
        jim_path = "(未在文档中找到 — 见 im-docs 源文件)"

    method = req.get("请求类型", "POST")
    content_type = req.get("Content-Type", "application/json")
    rate = req.get("请求限频", "")
    auth_note = req.get("请求鉴权", "")

    # Pre-parse query string for GET requests so the "## 触发 router"
    # example block can show a concrete `args.query` shape.
    parsed_query_obj = None
    if method == "GET" and req_example:
        qm = re.search(r"GET\s+/jim/[^?\s]*\?([^\s]+)", req_example)
        if qm:
            try:
                from urllib.parse import parse_qs
                qs = parse_qs(qm.group(1))
                parsed_query_obj = {k: v[0] for k, v in qs.items()}
            except Exception:
                pass
    # Pre-parse JSON body for POST/PUT/DELETE requests so the "## 触发 router"
    # example block can show a concrete `args.data` shape.
    parsed_body_obj = None
    if method != "GET" and req_example:
        bm = re.search(r"\n(\{[\s\S]*?\})\s*$", req_example)
        if bm:
            try:
                parsed_body_obj = json.loads(bm.group(1))
            except Exception:
                pass

    body = []
    body.append("---")
    body.append(f"name: jugglechat-busserver.{module}.{action}")
    body.append(f"module: {module}")
    body.append(f"action: {action}")
    body.append(f"title: {title}")
    body.append(f"http_method: {method}")
    body.append(f"http_path: {jim_path}")
    body.append(f"path: {jim_path}")
    body.append(f"method: {method}")
    body.append(f"source: {file_rel}")
    body.append(f"---")
    body.append("")
    body.append(f"# {title}")
    body.append("")
    body.append("## 接口信息")
    body.append("")
    body.append("| 项 | 值 |")
    body.append("| --- | --- |")
    body.append(f"| HTTP 方法 | `{method}` |")
    body.append(f"| 接口路径 | `{jim_path}` |")
    body.append(f"| Content-Type | `{content_type}` |")
    if rate:
        body.append(f"| 限频 | {rate} |")
    body.append("")
    body.append("## 触发 router")
    body.append("")
    body.append("```http")
    body.append("POST http://127.0.0.1:17832/router")
    body.append("Content-Type: application/json")
    body.append("")
    body.append("{")
    body.append('  "source": "jugglechat-busserver",  // 必填：发起请求的 skill 名（router 路由校验用）')
    body.append(f'  "module": "{module}",')
    body.append(f'  "action": "{action}",')
    body.append('  "args": {')
    body.append(f'    "method": "{method}",       // HTTP 方法（POST/GET）')
    body.append(f'    "path": "{jim_path}",     // 后端 jim 接口路径')
    if method == "GET":
        # GET 请求：业务参数放在 args.query 里
        if parsed_query_obj:
            query_line = "    " + json.dumps({"query": parsed_query_obj}, ensure_ascii=False)[1:-1].strip()
            body.append(query_line)
        else:
            body.append('    "query": { /* 业务参数放这里（GET 请求通过 query string 传参） */ }')
    else:
        # POST/PUT/DELETE 请求：业务参数放在 args.data 里
        if parsed_body_obj:
            data_line = "    " + json.dumps({"data": parsed_body_obj}, ensure_ascii=False)[1:-1].strip()
            body.append(data_line)
        else:
            body.append('    "data": { /* 业务参数放这里（POST 请求 body 字段） */ }')
    body.append('  },')
    body.append('  "meta": { /* 可选附加元数据 */ }')
    body.append("}")
    body.append("```")
    body.append("")
    if auth_note:
        body.append("## 鉴权")
        body.append("")
        body.append(f"> {auth_note}")
        body.append("")
        body.append("所有请求需要带两个 header：")
        body.append("")
        body.append("- `appkey`: 应用唯一标识（环境变量 `JUGGLECHAT_APPKEY`）")
        body.append("- `Authorization`: 登录成功下发的 token（`session.json` 中缓存）")
        body.append("")
    # Fallback: if no params table but request example has a JSON body,
    # synthesize a parameter list from the body keys.
    if not params and req_example:
        m = re.search(r"\n(\{[\s\S]*?\})\s*$", req_example)
        if m:
            try:
                obj = json.loads(m.group(1))
                params = [{"name": k, "type": "—", "required": "—", "desc": "（im-docs 源文档未提供说明，下方请求示例可参考）"} for k in obj.keys()]
            except Exception:
                pass

    if params:
        body.append("## 请求参数")
        body.append("")
        body.append("| 参数 | 类型 | 必填 | 说明 |")
        body.append("| --- | --- | --- | --- |")
        for p in params:
            required = "是" if p["required"].strip() == "是" else ("否" if p["required"].strip() == "否" else p["required"])
            desc = p["desc"].replace("|", "\\|")
            body.append(f"| `{p['name']}` | {p['type']} | {required} | {desc} |")
        body.append("")
    else:
        body.append("## 请求参数")
        body.append("")
        body.append("无（GET 请求通过 query string 传参，POST 请求 body 为空）。")
        body.append("")
    # Build a concrete router example with real example values parsed from
    # the request_example (a JSON body) or query string (for GET).
    if req_example:
        # Try to extract JSON body OR query string from the request example
        body_obj = None
        query_obj = None
        m = re.search(r"\n(\{[\s\S]*?\})\s*$", req_example)
        if m:
            try:
                body_obj = json.loads(m.group(1))
            except Exception:
                pass
        # Look for "GET /jim/path?key=value&..." and parse query string
        qm = re.search(r"GET\s+/jim/[^?\s]*\?([^\s]+)", req_example)
        if qm:
            try:
                from urllib.parse import parse_qs
                qs = parse_qs(qm.group(1))
                query_obj = {k: v[0] for k, v in qs.items()}
            except Exception:
                pass
        # Render
        body.append("## 完整 router 调用示例")
        body.append("")
        body.append("下面是一段可以直接 `curl` 跑的完整请求（参数来自下方 im-docs 请求示例）：")
        body.append("")
        body.append("```bash")
        body.append("curl -X POST http://127.0.0.1:17832/router \\")
        body.append("  -H 'Content-Type: application/json' \\")
        body.append("  -d '{")
        body.append('    "source": "jugglechat-busserver",  // 必填：发起请求的 skill 名')
        body.append(f'    "module": "{module}",')
        body.append(f'    "action": "{action}",')
        body.append('    "args": {')
        body.append(f'      "method": "{method}",')
        body.append(f'      "path": "{jim_path}",')
        if body_obj:
            # POST/PUT body — render wrapped in "data": {...}
            line = "      " + json.dumps({"data": body_obj}, ensure_ascii=False)[1:-1].strip()
            body.append(line)
        elif query_obj:
            # GET with query string — render as "query": {...}
            line = "      " + json.dumps({"query": query_obj}, ensure_ascii=False)[1:-1].strip()
            body.append(line)
        else:
            # No body/query — empty data wrapper for POST, empty query for GET
            if method == "GET":
                body.append('      "query": {}')
            else:
                body.append('      "data": {}')
        body.append("    }")
        body.append("  }'")
        body.append("```")
        body.append("")
    if req_example:
        body.append("## 请求示例（im-docs 原文）")
        body.append("")
        body.append("```http")
        body.append(req_example)
        body.append("```")
        body.append("")
    if res_example:
        body.append("## 响应示例")
        body.append("")
        body.append("```json")
        body.append(res_example)
        body.append("```")
        body.append("")
    if res_codes:
        body.append("## 响应码")
        body.append("")
        body.append("| 响应码 | 说明 |")
        body.append("| --- | --- |")
        for rc in res_codes:
            body.append(f"| `{rc['code']}` | {rc['desc']} |")
        body.append("")
    body.append("## 通用响应格式")
    body.append("")
    body.append("所有接口统一返回：")
    body.append("")
    body.append("```json")
    body.append("{")
    body.append('  "code": 0,           // 0=成功，其它见 响应码 章节或全局错误码')
    body.append('  "msg": "success",    // 人类可读信息')
    body.append('  "data": { /* 业务数据；可能为 null 或对象 */ }')
    body.append("}")
    body.append("```")
    body.append("")
    body.append("## 文档来源")
    body.append("")
    body.append(f"- im-docs 源文件：`busserver/{file_rel}`")
    return "\n".join(body)


def render_module_index(module: str, actions: list, doc_map: dict) -> str:
    desc = MODULE_DESC.get(module, "")
    body = []
    body.append(f"# 模块：{module} — {desc}")
    body.append("")
    body.append(f"router 调用时 `module` 字段固定为 `{module}`。")
    body.append("")
    body.append(f"## Action 清单（{len(actions)}）")
    body.append("")
    for action, f in sorted(actions):
        title = doc_map[(module, action)]["title"]
        jim_path = extract_jim_path(doc_map[(module, action)]) or extract_jim_path_from_example(doc_map[(module, action)])
        method = doc_map[(module, action)]["request"].get("请求类型", "POST")
        body.append(f"### `{action}` — {title}")
        body.append("")
        body.append(f"- 模块：`{module}`")
        body.append(f"- HTTP：`{method} {jim_path}`")
        body.append(f"- 文档：[`{action}.md`](./{action}.md)")
        body.append(f"- 源文件：im-docs `busserver/{f}`")
        body.append("")
    return "\n".join(body)


def main():
    data = json.loads(SRC.read_text(encoding="utf-8"))
    by_module = defaultdict(list)
    doc_map = {}
    for d in data:
        f = d["file"]
        action = PATH_ACTION_OVERRIDE.get(f, Path(f).stem)
        cat = d["category"]
        mod = CATEGORY_MODULE.get(cat)
        if not mod: continue
        by_module[mod].append((action, f))
        doc_map[(mod, action)] = d

    # Write action files
    written = []
    for mod, entries in by_module.items():
        mod_dir = DEST / "modules" / mod
        mod_dir.mkdir(parents=True, exist_ok=True)
        for action, f in entries:
            d = doc_map[(mod, action)]
            file_path = mod_dir / f"{action}.md"
            file_path.write_text(render_action_file(d, mod, action), encoding="utf-8")
            jp = extract_jim_path(d) or extract_jim_path_from_example(d)
            written.append({
                "module": mod,
                "action": action,
                "title": d["title"],
                "http_method": d["request"].get("请求类型", "POST"),
                "method": d["request"].get("请求类型", "POST"),
                "http_path": jp,
                "path": jp,
                "source": f,
            })

    # Module indexes
    for mod, entries in by_module.items():
        mod_dir = DEST / "modules" / mod
        idx = mod_dir / "_index.md"
        idx.write_text(render_module_index(mod, entries, doc_map), encoding="utf-8")

    # _meta/actions.json
    meta_dir = DEST / "_meta"
    meta_dir.mkdir(parents=True, exist_ok=True)
    (meta_dir / "actions.json").write_text(
        json.dumps(
            {
                "router": {
                    "method": "POST",
                    "url": "http://127.0.0.1:17832/router",
                    "body_schema": {
                        "source": "string — 必填，发起请求的 skill 名（jugglechat-busserver / jugglechat-im-sdk），router 用于路由校验",
                        "module": "string — 业务模块名（user / group / friend / ...）",
                        "action": "string — 操作名（驼峰，与 im-docs 接口路径末段对应）",
                        "args": "object — 包含 method、path 必填字段；POST/PUT/DELETE 业务参数放 args.data，GET 参数放 args.query",
                        "meta": "object?",
                        "timeoutMs": "number?",
                    },
                },
                "backing_api": {
                    "type": "App Server HTTP API",
                    "url_pattern": "https://$api/$version/$command",
                    "headers": {
                        "appkey": "应用唯一标识",
                        "Authorization": "登录成功后下发的 token（除登录/注册/扫码外所有接口必带）",
                    },
                    "body_format": "application/json（GET 请求通过 query string）",
                },
                "actions": written,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    # SKILL.md
    module_list_lines = []
    for mod in sorted(by_module.keys()):
        desc = MODULE_DESC.get(mod, "")
        n = len(by_module[mod])
        module_list_lines.append(f"| `{mod}` | {desc} | {n} |")
    module_list = "\n".join(module_list_lines)

    skill_md = f"""---
name: jugglechat-busserver
description: JuggleChat App Server 业务接口 skill（服务端 HTTP API）。覆盖用户/好友/群组（管理/管理员/成员/设置）/消息（管理员删除/撤回）/登录鉴权（账号/邮箱/短信/二维码）/AI 助手/Bot/Telegram Bot/应用/反馈/文件/翻译等 16 个模块共 73 个接口。所有调用统一通过本地 router HTTP 端点（127.0.0.1:17832/router）派发。
---

# JuggleChat Busserver

这个 skill 把 JuggleChat **App Server** 的 73 个业务 HTTP 接口（`/jim/users/*`、`/jim/groups/*`、`/jim/friends/*` 等）整理成结构化文档。**所有调用统一通过本地 loopback router 触发**，由 renderer/main 进程在内部转发到 `https://$api/$version/$command` App Server。

## 触发场景

- "登录" / "注册" / "扫码登录" / "短信验证码"
- "查我的资料" / "改昵称" / "改头像" / "改密码" / "搜索用户"
- "加好友" / "删除好友" / "好友列表" / "好友申请列表"
- "建群" / "解散群" / "拉人进群" / "踢人" / "退群" / "查群成员" / "群申请"
- "设置群公告" / "群禁言" / "全员禁言" / "成员禁言" / "转让群主"
- "管理员撤回消息" / "管理员删除消息"
- "调用 AI 助手" / "管理 prompt" / "反馈" / "上传文件" / "翻译"

## 触发 router

每个接口都通过本地 loopback router 触发：

```http
POST http://127.0.0.1:17832/router
Content-Type: application/json

POST 例子（创建群）：

```json
{{
  "source": "jugglechat-busserver",   // 必填：发起请求的 skill 名（router 路由校验用）
  "module": "group",        // 业务模块
  "action": "create",       // 操作名（驼峰）
  "args": {{
    "method": "POST",       // HTTP 方法（POST/GET），必填，**必须从 action 文档读取**
    "path": "/jim/groups/create",  // 后端 jim 接口路径，必填
    "data": {{              // POST 请求：业务参数放这里（对应后端 HTTP body）
      "group_name": "项目组",
      "member_ids": ["userid1", "userid2"]
    }}
  }},
  "meta": {{ /* 可选附加元数据 */ }}
}}
```

GET 例子（好友列表）：

```json
{{
  "source": "jugglechat-busserver",   // 必填：发起请求的 skill 名（router 路由校验用）
  "module": "friend",
  "action": "list",
  "args": {{
    "method": "GET",        // GET 请求：method 必须是 GET（从 action 文档读）
    "path": "/jim/friends/list",
    "query": {{             // GET 请求参数放这里
      "size": "50",
      "page": "1",
      "order_tag": "a"
    }}
  }}
}}
```

响应：

```json
{{ "ok": true,  "data": {{ "code": 0, "msg": "success", "data": {{ ... }} }} }}
{{ "ok": false, "error": {{ "code": "...", "message": "..." }} }}
```

**实现说明**：router 收到的 `module`/`action`/`args` 由 renderer 端注册的 `setSkillEvent` cb 映射到具体的 App Server HTTP 调用，自动附加 `appkey` / `Authorization` header。详细文件见 `modules/<module>/<action>.md`，机器可读索引见 `_meta/actions.json`。

## 模块清单

| module | 含义 | 数量 |
| --- | --- | --- |
{module_list}

## 使用流程

1. **确认 module / action**：根据用户意图从 `modules/<module>/` 下选对应文件。
2. **读 action 文档的 front-matter**：从 `method` 字段读取 HTTP 方法（POST / GET），从 `path` 字段读取 jim 接口路径。**绝对不能默认 POST** — 像 `jim/friends/list`、`jim/users/info` 这些都是 GET。
3. **构造 args**：严格按文件里的「请求参数」表填字段。
   - POST/PUT/DELETE 接口：业务字段直接平铺到 `args` 里
   - GET 接口：参数走 `args.query = {{...}}`
   - 必填项 `args.method` 和 `args.path` 不能漏
4. **POST /router**：`module`/`action`/`args` 三件套。renderer/main 端会负责加 `appkey` / `Authorization` header 并转发到 App Server。
5. **处理响应**：`ok=true` 取 `data`（即 App Server 返回的 `{{code, msg, data}}` 三段）；`ok=false` 把 `error.message` 反馈给用户。

## 关键约定

- **绝大部分业务接口都需要 `Authorization` header**。少部分明确标记「免登录」/`passlogin` 这种的接口不需要（如 `passlogin`/`register`/扫码类）。登录成功响应里 `data.authorization` 即为 token，agent 端应缓存并在后续请求自动带上。
- 具体哪些接口免登录，每个 action 文档「鉴权」章节会明确说明。
- **`GET` 请求**通过 query string 传参（`?user_id=xxx`），没有 body；`POST` 请求 body 为 `application/json`。
- **响应统一三段式**：`{{code, msg, data}}` — `code=0` 表示成功。
- 错误码（`code != 0`）的含义在每个接口的「响应码」章节或全局 `busserver/api.md#error_code` 列出。常见 `code`：
  - `-8` 未登录 / token 无效
  - `-7` 密码错误
  - `-5` 用户不存在
  - `-4` 应用不存在
  - 业务码 `17xxx`（好友/群申请）、`17300`（telebot/prompt 添加失败）等。

## 与 jugglechat-im-sdk 的区别

| skill | 协议层 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| `jugglechat-im-sdk` | 客户端 jim.* SDK（Web/JS） | 无（已登录客户端） | 消息收发/会话/聊天/朋友圈/在线状态 |
| `jugglechat-busserver` | App Server HTTP API | `appkey` + `Authorization` | 用户/好友/群组管理/AI 助手/Bot 等管理类操作 |
"""
    (DEST / "SKILL.md").write_text(skill_md, encoding="utf-8")

    # _raw/
    raw_dir = DEST / "_raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    import shutil
    for name in ("extract_busserver.py", "busserver_docs.json", "build_busserver_skill.py"):
        src = Path("/Applications/work/ai-skills-research/_sdk_extract") / name
        if src.exists():
            shutil.copy2(src, raw_dir / name)

    print(f"wrote skill to {DEST}")
    print(f"  actions: {len(written)}")
    for mod in sorted(by_module.keys()):
        print(f"    {mod}: {len(by_module[mod])}")


if __name__ == "__main__":
    main()
