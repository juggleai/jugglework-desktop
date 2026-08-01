# 模块：conversation

router 调用时 `module` 字段固定为 `conversation`。

## Action 清单

### `addConversationsToTag` — 向标签里添加会话

- 模块：`conversation`
- 文档：[`addConversationsToTag.md`](./addConversationsToTag.md)
- 源文件：im-docs `sdkintro/conversation/tag/add_convers.md`

### `clearTotalUnreadcount` — 清空会话未读总数

- 模块：`conversation`
- 文档：[`clearTotalUnreadcount.md`](./clearTotalUnreadcount.md)
- 源文件：im-docs `sdkintro/conversation/unread/clear_total_unread.md`

### `clearUnreadcount` — 清空单个会话未读数

- 模块：`conversation`
- 文档：[`clearUnreadcount.md`](./clearUnreadcount.md)
- 源文件：im-docs `sdkintro/conversation/unread/clear_unread.md`

### `createConversationTag` — 创建标签

- 模块：`conversation`
- 文档：[`createConversationTag.md`](./createConversationTag.md)
- 源文件：im-docs `sdkintro/conversation/tag/add.md`

### `destroyConversationTag` — 销毁标签

- 模块：`conversation`
- 文档：[`destroyConversationTag.md`](./destroyConversationTag.md)
- 源文件：im-docs `sdkintro/conversation/tag/destroy.md`

### `disturbConversation` — 设置单个会话免打扰

- 模块：`conversation`
- 文档：[`disturbConversation.md`](./disturbConversation.md)
- 源文件：im-docs `sdkintro/conversation/operator/disturb.md`

### `getAllDisturb` — 获取全局免打扰

- 模块：`conversation`
- 文档：[`getAllDisturb.md`](./getAllDisturb.md)
- 源文件：im-docs `sdkintro/conversation/operator/get_disturb_all.md`

### `getConversation` — 获取单个会话

- 模块：`conversation`
- 文档：[`getConversation.md`](./getConversation.md)
- 源文件：im-docs `sdkintro/conversation/get_one.md`

### `getConversationTags` — 获取标签列表

- 模块：`conversation`
- 文档：[`getConversationTags.md`](./getConversationTags.md)
- 源文件：im-docs `sdkintro/conversation/tag/get.md`

### `getConversations` — 获取会话列表

- 模块：`conversation`
- 文档：[`getConversations.md`](./getConversations.md)
- 源文件：im-docs `sdkintro/conversation/get_all.md`

### `getDraft` — 获取会话草稿

- 模块：`conversation`
- 文档：[`getDraft.md`](./getDraft.md)
- 源文件：im-docs `sdkintro/conversation/draft/draft_get.md`

### `getTopConversations` — 获取置顶会话

- 模块：`conversation`
- 文档：[`getTopConversations.md`](./getTopConversations.md)
- 源文件：im-docs `sdkintro/conversation/operator/get_top_all.md`

### `getTotalUnreadcount` — 获取会话未读总数

- 模块：`conversation`
- 文档：[`getTotalUnreadcount.md`](./getTotalUnreadcount.md)
- 源文件：im-docs `sdkintro/conversation/unread/get_total_unread.md`

### `insertConversation` — 插入指定会话

- 模块：`conversation`
- 文档：[`insertConversation.md`](./insertConversation.md)
- 源文件：im-docs `sdkintro/conversation/operator/insert.md`

### `markUnread` — 标记会话状态

- 模块：`conversation`
- 文档：[`markUnread.md`](./markUnread.md)
- 源文件：im-docs `sdkintro/conversation/operator/mark_unread.md`

### `removeConversation` — 删除指定会话

- 模块：`conversation`
- 文档：[`removeConversation.md`](./removeConversation.md)
- 源文件：im-docs `sdkintro/conversation/operator/remove.md`

### `removeConversationsFromTag` — 从标签里删除会话

- 模块：`conversation`
- 文档：[`removeConversationsFromTag.md`](./removeConversationsFromTag.md)
- 源文件：im-docs `sdkintro/conversation/tag/remove_convers.md`

### `removeDraft` — 删除会话草稿

- 模块：`conversation`
- 文档：[`removeDraft.md`](./removeDraft.md)
- 源文件：im-docs `sdkintro/conversation/draft/draft_remove.md`

### `setAllDisturb` — 设置全局免打扰

- 模块：`conversation`
- 文档：[`setAllDisturb.md`](./setAllDisturb.md)
- 源文件：im-docs `sdkintro/conversation/operator/set_disturb_all.md`

### `setDraft` — 设置会话草稿

- 模块：`conversation`
- 文档：[`setDraft.md`](./setDraft.md)
- 源文件：im-docs `sdkintro/conversation/draft/draft_set.md`

### `setTopConversation` — 设置会话置顶

- 模块：`conversation`
- 文档：[`setTopConversation.md`](./setTopConversation.md)
- 源文件：im-docs `sdkintro/conversation/operator/settop.md`

## 数据模型（不是 router action）

- [`_conversation_tag_unread_count.md`](./_conversation_tag_unread_count.md) — 获取标签未读消息数
- [`_conversation.md`](./_conversation.md) — 会话结构