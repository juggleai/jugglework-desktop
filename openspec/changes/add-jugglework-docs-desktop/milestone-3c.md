# M3-C：普通段落拆并与原生并发文本实验

普通无格式段落的源码和真实往返验证完成，单次拆分／合并已接入正式受限桥。既有加粗／斜体随普通段落拆并保持已有 Desktop／Docs 双向源码回归；带格式拆并真实 SDK、结构并发和跨重开恢复仍未完成。

## 源码与原生依赖

| 模块 | 当前能力 |
| --- | --- |
| `apps/desktop/electron/office-word-blocks-adapter.mjs` | 增加可选 onStructure、applyRemoteStructure；按活跃模型捕获结束符变更并核实实际新身份，定点调用 Range.insertParagraph／delete |
| Docs `packages/frontend/core/src/utils/jugglework-word-structure-probe.ts` | 独立结构实验组件；观察 spaceDoc.afterTransaction，调用原生 Text.split/join、Store.addBlock/deleteBlock，事务后确认并重建关联 |
| `scripts/verify-word-affine-structure.mjs` | 临时 Word、两个真实源成员、段首／中／尾拆并、原生断连并发文本和保存重开验收 |

正文继续使用原生 Y.Doc、nbstore、Socket.IO 和存储，没有新增正文合并算法、传输协议、正文表、离线队列或完整文件互换。Go 复用原有 launch／源会话／组织成员授权，无 API 和数据表变更。

## 身份与结构约束

固定 SDK 拆段时，新 ID 属于左段，原 ID 留在右段；合并时也保留右段 ID。BlockSuite 的原生拆并保留左侧 block。因此关联必须按双方实际结果更新，不能认为同一侧的 ID 都保持不变。

Word 侧仅识别一次 CR 插入或一次段落结束符删除，以及已捕获的附属空属性命令。受影响段落必须为普通正文，结果须严格等于原文及既有加粗／斜体的拆分／拼接，其他对象和内容保持。段首／尾允许空段；不能切开 UTF-16 surrogate。既有固定模式不提供结构回调时，仍拒绝拆并。

原生结构组件只处理同一父节点的平级普通段落及既有加粗／斜体，不能与固定文本 probe 同时运行。云端结构事件后进入 awaiting-word，收到 Word 当前实际对象、内容及 marks 校验后才更新关联并恢复 active；核对前再次变更、只读、格式／类型超范围或基线分叉时暂停。写后无法确认返回 unknown，不自动重放。

关联只存在于当前实验实例中，不是正式绑定或检查点。SDK 工具说明不保证保存重开后 paragraph_id 保持不变；本样例重开相同仅是该样例事实，不能用来跳过重开握手。

## 真实验收

固定版本仍为 editor_sdk `0.0.0.499`／wrapper `0.2.196-office.1`、macOS ARM64，AFFiNE 基线不变。结果见 [evidence/m3c.json](evidence/m3c.json)。

- Word 实际人工 Enter／Backspace → 两个原生客户端：拆并后内容一致，身份按上述规则更新。
- 另一成员原生 Text.split/join → 同一 Word 模型：段首 0、段中、段尾及空段均通过，cloud 回写不变成人工结构事件；测试段中位置按码点换算为 UTF-16 边界。
- 结构实验后重新挂载固定文本组件：断开另一成员 nbstore SharedWorker 的现有原生连接，并阻止该测试 Worker 重连；确认 Owner 看不到其离线修改后，Word 人工修改进入 Owner 原生 Y.Doc。恢复连接后由原生 Yjs 合并，增量回写 Word；双方中文／emoji 内容保留，不回环。
- Word 原路径保存、关闭重开，两个原生页面重载后内容一致；样例对象身份及最终原生 block ID 保持。

网络故障仅注入独占测试成员的 Worker，不停止共享 Server／Docs 服务；故障注入不是产品代码或自研离线机制。仅页面断网不能证明 nbstore 已断开，验收必须检查实际隔离结果。

新增 7 项回归，连同原有 16 项共 23 项通过；覆盖右段身份、来源恢复、非法范围／格式／末段零写入、默认模式拒绝、夹带改动暂停、unknown 不重放及空段附属命令。Docs 新模块独立类型检查通过。

## 并发边界与剩余门槛

本次只证明：**Word 修改先进入 Owner 原生 Y.Doc，再接收另一成员的原生并发更新**时可以收敛并回写。桥上尚未转发的 Word 修改与远端更新撞车、同位置插删完整矩阵、原生相对位置持久关联、结构与文本并发仍未通过，不标记 W-04 完成。基线不一致时仍暂停，不按旧绝对偏移猜测合并。

结构与固定文本已由正式组合会话接入，既有加粗／斜体随普通段落拆并保持已有双向源码回归；DOCX 原件 page 接入、共同检查点和基础文本重开恢复源码已完成。AI 拆并、带格式拆并真实 SDK、标题／列表拆并、评论锚点、undo／redo 全矩阵、表格／图片、真实 IME／AI admission 和完整离线／崩溃恢复仍未完成。

## 复测

回归：`node --test apps/desktop/electron/office-word-blocks-adapter.test.mjs apps/desktop/electron/office-word-paragraph-adapter.test.mjs`。

真实实验沿用 [M3-A 环境变量](milestone-3a.md#复测)，运行 `node scripts/verify-word-affine-structure.mjs`。需要独占的本机 CDP 浏览器、两个源用户、可丢弃组织，以及系统临时目录中已打开的单普通无格式段落 DOCX。脚本创建自己的云测试页并修改／保存临时文件，不得连接用户编辑窗口。Playwright 需支持 CDP 会话；测试 Worker 断连只用于该隔离浏览器。
