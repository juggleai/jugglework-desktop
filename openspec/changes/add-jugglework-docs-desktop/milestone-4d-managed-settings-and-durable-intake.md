# M4-D Desk 设置权威与持久 Word 接入

## 已交付范围

- 云文档视图在就绪和 Desk 外观变化时发送当前主题、语言、字体和固定语义色；账号或组织变化释放旧视图。
- Word 顶栏接入请求保存稳定 requestId、本地工作区和相对路径，不保存正文或登录令牌；同一文件的有效失败请求继续复用 requestId。
- Word 基础对象创建、后台 AFFiNE 编辑器、逐对象映射和正式双向控制器接线完成；保存前等待当前对象窗口，paused／unknown 阻止保存。
- 关联成功后由主进程原子写入 `cloud-doc-bindings.json` schemaVersion=2；同一文件只保留一条关联，退出／失效暂停，显式解除／替换取消关联。
- 重启时没有共同检查点的 active 记录转 paused，避免把旧文件或旧原生缓存误认为已同步。
- Office Server 对真实落盘 DOCX 计算 SHA-256；Desktop 仅在 Word revision、AFFiNE 状态向量和映射保存前后均稳定时提交不可变共同检查点，保留当前和上一份。
- 首次关联必须生成首个检查点；重启后先暂停，再按当前账号、组织、本地摘要、原生 Workspace、快照状态向量和 Yjs 字符映射恢复基础文本云端变化，成功保存新检查点后重新 active。

## 验收结果

Desktop 关联仓库、共同检查点、Word 页面桥、双向控制器、基础 blocks／marks、普通段落拆并和云文档卡片相关测试通过；Office Server 类型检查及保存测试通过。服务端稳定 requestId 和受管 AFFiNE 设置／许可证结果见 Docs 同名里程碑。

## 后续发布门槛

本里程碑本身没有上传原始 DOCX；该能力已由后续 [M4-E](milestone-4e-docx-intake.md) 实现。文件重定位、页面内附件块、完整对象恢复及真实 Electron＋远端 Provider 重开矩阵仍未验收。
