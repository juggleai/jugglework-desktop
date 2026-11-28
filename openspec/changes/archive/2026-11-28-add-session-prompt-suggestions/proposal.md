# Proposal

## Why

工作区会话结束一轮后，用户需要重新组织后续指令。结合本轮结果提供一条可忽略、可编辑的灰字建议，可以减少重复输入，同时保留用户对下一步工作与发送行为的控制。

## What Changes

- 当前活动可见会话新观察到的一轮成功结束后，初次触发及实际派发前均要求输入栏完全空白且无排队 follow-up，最多尝试一次简短的下一轮用户输入建议；不补生成历史轮次，不保证每轮都有建议，完成后不自动重新生成。
- 建议只作为完全空白输入栏的灰字占位，不在编辑区下方另起一行，不额外显示 Tab 提示。任何文字（包括空格）、粘贴对象、附件、mention、chip 或 Office 引用均隐藏建议；清空全部输入后恢复同一条建议，不覆盖草稿、不重新生成。普通编辑不取消已派发请求，结果仅在恢复全空且其他展示条件满足时显示。
- 普通 `Tab` 仅在真实编辑器及 composer 内容全部为空时接受建议为可编辑草稿，不发送、不排队。接受是一次独立的可撤销编辑；一次 undo 或清空草稿恢复原建议，redo 后因草稿非空再次隐藏。
- `Esc` 在没有活动菜单或输入法组合时仅隐藏当前视图的建议，不删除已生成内容；重开会话或清空输入后可恢复。发送/提交准备、queue、上下文或可见性变化、卸载及关闭功能取消 pending 请求、丢弃迟到响应且同轮不重试；pending 不持久化。
- 已生成建议按 server endpoint、workspace、session 与稳定 account/org identity 隔离保存在 localStorage，会话切换、重挂载和应用重启后可恢复。关闭开关、readiness/policy/model 临时变化仅隐藏，不删除；切回原账号/组织可恢复其建议。仅保存简短 suggestion、turn、标识与时间戳，不保存 credential、历史正文或策略快照；存储异常降级为内存，不承诺重启恢复。
- 仅删除 session 或出现更新的真实用户轮次清理旧建议；新轮开始即替换旧内容，不等待新建议成功。session 删除同时接入 `session.deleted` 与成功删除后的直接清理，清除该 endpoint/workspace/session 的全部 identity。128 仅为内存记录上限，不淘汰磁盘建议，无需多窗口同步或复杂协调。
- 建议与真实草稿分离，不抢焦点，不修改聊天历史、队列或运行状态；输入法、加号菜单、slash/mention 菜单及焦点导航保留原有优先级。
- 通过所属工作区服务端的专用接口，以当前会话模型进行一次无工具、非流式文本生成；只使用有界的当前会话正文，不创建临时 session/run。
- 发送 parts 已包含非敏感文本来源标记，建议仅提取明确用户正文；已完成的当前轮用户消息含 Office/云文档引用或来源不明时直接跳过。这是生成上下文限制，不使派发后新增引用的草稿取消建议。
- 沿用现有模型配置、凭据解析和策略边界。首版支持可直接解析身份的 OpenAI-compatible Chat Completions、OpenAI Responses、Anthropic Messages 文本模型，保留上游模型 alias 与有效 provider/model headers；OAuth-only、reasoning budget 或其他不支持的配置跳过，不隐式换模型或供应商。
- 在全局「通用」设置增加默认关闭的「下一轮输入建议」开关，说明额外模型调用及费用；关闭立即隐藏建议并取消请求。
- 老版本或不支持该能力的远端服务静默降级为普通输入栏，不回退本机调用。

## Capabilities

### New Capabilities

- `session-prompt-suggestions`: 成功回合后的建议生成、输入栏灰字、Tab 接受、会话隔离、失效规则、偏好与费用边界。

### Modified Capabilities

无。保留 `composer-action-menus`、`session-composer-focus`、`session-task-progress`、`session-view-reuse` 和 `settings-scope-grouping` 的现有合同，通过新增 capability 约束接入行为。

## Impact

- `apps/app`：会话建议状态、完成投影接线、Lexical 输入栏、键盘处理、Server client/capability、全局偏好与本地化文案。
- `apps/server`：专用建议路由、有界历史读取、单模型文本推理复用及响应正文校验；不修改会话执行入口。
- 不新增数据库表、持久任务、事件协议、凭据存储或建议专用模型配置；不要求修改 OpenCode 引擎。
- 自动化测试已覆盖占位与全空接受、隐藏与恢复、持久化及 identity 隔离、删除清理、pending 取消与一次请求边界。固定 OpenCode `v1.19.3` 的隔离 synthetic provider 真实引擎验证已完成；完整真实 Desktop 三协议及真实模型、系统 IME 验收尚未完成，不代表已发布。
