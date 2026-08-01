# 模块：assistant — AI 助手（智能回复 / prompt 管理）

router 调用时 `module` 字段固定为 `assistant`。

## Action 清单（6）

### `add` — 新增提示词

- 模块：`assistant`
- HTTP：`POST /jim/assistants/prompts/add`
- 文档：[`add.md`](./add.md)
- 源文件：im-docs `busserver/assistants/promptadd.md`

### `answer` — 智能回复

- 模块：`assistant`
- HTTP：`POST /jim/assistants/answer`
- 文档：[`answer.md`](./answer.md)
- 源文件：im-docs `busserver/assistants/aianswer.md`

### `batchdel` — 批量删除提示词

- 模块：`assistant`
- HTTP：`POST /jim/assistants/prompts/batchdel`
- 文档：[`batchdel.md`](./batchdel.md)
- 源文件：im-docs `busserver/assistants/promptbatchdel.md`

### `del` — 删除提示词

- 模块：`assistant`
- HTTP：`POST /jim/assistants/prompts/del`
- 文档：[`del.md`](./del.md)
- 源文件：im-docs `busserver/assistants/promptdel.md`

### `list` — 查询提示词

- 模块：`assistant`
- HTTP：`POST /jim/assistants/prompts/list`
- 文档：[`list.md`](./list.md)
- 源文件：im-docs `busserver/assistants/promptlist.md`

### `update` — 更新提示词

- 模块：`assistant`
- HTTP：`POST /jim/assistants/prompts/update`
- 文档：[`update.md`](./update.md)
- 源文件：im-docs `busserver/assistants/promptupdate.md`
