# Tasks

## 1. Server contract and bounded context

- [x] 1.1 增加可选 `sessions.promptSuggestions` capability、严格请求/响应 DTO 与所属 workspace endpoint 的 client 方法；旧 server 缺失能力或返回 404/501 时不重试。
- [x] 1.2 实现无 bootstrap/repair 的工作区与会话读取，沿用 client/collaborator/readOnly 检查；不进入 session/run 写入路径。
- [x] 1.3 实现真实 turnKey、成功终态、空闲/等待状态与 revert 边界校验；以最多两页/120 条历史提取最多三轮、20,000 UTF-16 单元的完整纯文本上下文。
- [x] 1.4 为 draftToParts 的用户输入/粘贴与 capability/app/attachment 展开添加非敏感来源元数据；验证固定引擎往返及持久化保留，建议读取跳过含 Office/云文档引用或来源不明的当前轮。

## 2. Narrow text inference reuse

- [x] 2.1 从 Toonflow 提取指定文本模型解析及三类协议 transport，复用有效配置、credential resolver 与策略检查，支持上游 alias 和有效 provider/model headers，不枚举媒体、不新建认证存储。
- [x] 2.2 实现专用无工具提示词、覆盖历史/解析/上游响应体/二次校验的单一 8 秒 deadline 与取消传播、最多 512 输出 tokens、非流式正文归一及 240 UTF-16 单元单段建议校验；不支持/空结果/失败不回退其他模型。
- [x] 2.3 在推理前后检查轮次、运行、模型与策略有效性；过期返回无建议，脱敏错误与日志不包含正文或凭据。

## 3. Renderer lifecycle and preference

- [x] 3.1 在 LocalProvider 和全局通用设置接入默认关闭的开关、费用说明与本地化；关闭取消 pending、隐藏 ready，保留已生成建议及已接受草稿，重开不补生成旧轮。
- [x] 3.2 基于共享完成投影为主窗口活动 pane 建立每轮一次的 renderer 内存状态，128 仅为内存上限，不淘汰磁盘建议；以用户创建时间戳高水位识别新轮，包含 revert 隐藏尾部，旧轮重放及缺失/相同/迟到时间戳不重新取得资格；卸载保留尝试记录，淘汰或重启后以旧轮为生成基线、可恢复匹配的持久化建议；初始历史快照、失败/停止/压缩/等待、队列衔接与非活动回合不请求。
- [x] 3.3 初次触发及实际派发前检查 surface 与真实 composer 均 empty；派发后普通编辑保留 pending/ready，非空隐藏且不可接受，清空恢复同一建议。Esc、发送/提交准备、queue、账号/组织/策略、模型、会话/工作区、readiness、可见性、卸载、开关和新轮次取消 pending，迟到结果丢弃，同轮不重试，不持久 pending；ready 的临时门禁只隐藏不删除，StrictMode 不重复请求。
- [x] 3.4 将简短 ready suggestion、turn ID、scope identity 与轮次/保存时间戳保存到 localStorage，按 endpoint/workspace/session 与稳定 account/org identity 隔离，不保存 credential、历史或策略快照；会话切换、重挂载、重启恢复原建议，存储异常内存降级且不承诺重启恢复，无多窗口同步或复杂协调。
- [x] 3.5 仅新真实 user 轮次或 session 删除清理旧内容，新轮开始即替换旧建议；接入工作区 `session.deleted` 与成功删除后的直接清理，清除该 endpoint/workspace/session 的全部 identity，包括磁盘中已被内存淘汰的记录，取消 pending 并阻止迟到结果重建。

## 4. Composer interaction

- [x] 4.1 仅全空输入栏的占位区域显示灰字，无下方独立行、无额外 `Tab 应用`；任何输入、空白字符、附件/引用/chip 均隐藏，清空恢复。保留 Tab 及无障碍说明，隐藏时移除可用说明，不修改 draft/历史、不抢焦点、不激活发送按钮。
- [x] 4.2 仅 ContentEditable 普通非 repeat Tab 在真实编辑器及 composer 全空时写入建议全文，光标位于末尾；非空（含 stale draft prop、selection 或 chips）不接受、不改原稿。接受独立为一次可撤销编辑，undo/清空恢复原建议，redo 后隐藏，不发送、不重新生成；菜单及 IME 优先，Shift+Tab/控件 Tab 保留导航。
- [x] 4.3 ready 接受及 Esc 仅隐藏视图、不删除内容；接受后的 undo/清空和 Esc 后重开/清空可恢复原建议，不重新生成。pending 的 Esc 取消无重试；不扩展文件窗口/review/IM/自动化入口。

## 5. Verification and documentation

- [x] 5.0 优化后台独立读取并行与按需分页，保留生成前后校验，并添加纯数字阶段耗时诊断和回归测试。

- [x] 5.1 添加 Server 路由行为测试：只读历史、真实成功轮次、revert/过期、预算边界、Office/云文档/能力展开及来源不明历史、无 session/run/工具写入、模型配置不可用、readOnly 和旧 server 降级。
- [x] 5.2 添加三协议推理与 Toonflow 回归：固定无工具 payload、慢历史与慢响应体仍共享超时、取消、无额外重试、格式/长度/截断响应、身份解析、alias/header 与错误脱敏。
- [x] 5.3 添加 renderer 行为测试：初次及派发前非空跳过且清空不补生成，pending/ready 普通编辑保留请求/内容但非空隐藏，只有全空占位且无下方行；Tab 全空接受，非空及 stale draft prop、selection/chips/附件不接受，一次 undo/清空恢复原建议、redo 隐藏，Esc 后重开恢复；IME/菜单/焦点导航、pending 取消与迟到结果丢弃、每轮一次、StrictMode、时间戳高水位与 revert/重放、策略未知/拒绝不派发。
- [x] 5.3.1 添加 store/hook 持久化与接线测试：新 store 恢复不请求、scope/account/org 隔离、切回恢复、off/readiness/policy/model/queue 临时隐藏不删、新真实轮清旧内容、128 内存淘汰不删磁盘、存储异常降级、session 删除清全部 identity 与 `session.deleted` 后台事件清理、删除后迟到结果不重建。
- 5.4 分层验证：
  - [x] 5.4.1 自动验证：App/Server 聚焦测试、类型检查与 OpenSpec strict validation。
  - [x] 5.4.2 真实引擎验证：固定 OpenCode `v1.19.3`、隔离 synthetic provider，确认来源 metadata 往返及持久化与取消；不等同真实模型或完整 Desktop 验收。
  - [ ] 5.4.3 真实 Desktop 手动验收：三协议可用真实模型、一个不支持模型、旧远端；初次/派发前 empty 门禁，全空占位、任何输入/附件隐藏且清空恢复、无下方行、Tab 仅全空、undo/清空恢复原建议、Esc 视图隐藏后重开/清空恢复；会话切换及应用重启恢复、account/org 隔离、off/readiness/policy/model 临时变化只隐藏、真实新轮替换旧内容、删除清全部 identity、pending 取消无重试、存储异常降级、每轮一次，以及系统 IME 与原生焦点导航。
- [x] 5.5 产品文档明确默认关闭、额外费用、初次/派发前 empty、全空占位与非空隐藏/清空恢复、Tab 全空接受及 undo 恢复、Esc 视图隐藏、会话切换/重启持久化与 identity 隔离、临时门禁不删、仅新真实轮/session 删除清理、存储异常内存降级、128 仅内存上限、pending 不持久且取消不重试，以及模型/8 秒调用边界；该能力不自动续跑或授权。
