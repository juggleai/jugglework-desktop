## ADDED Requirements

### Requirement: Cloud writeback preserves original model authority
云文档适配 SHALL 服从现有 Office 活跃模型、pageId／engineFileId 代次、AI admission、IME 提交、选区证明及保存规则。远端变化 MUST 先进入正确模型，再保存文件，不能直接改磁盘后被旧模型覆盖。

#### Scenario: Remote update arrives during AI selection edit
- **WHEN** 当前模型有运行中或 needs-verification 的选区执行
- **THEN** 适配遵守既有执行与保存边界，不刷新陈旧引用、伪造新轮次或向另一模型回写

#### Scenario: Model retires before writeback
- **WHEN** 云端事件到达时原模型已关闭或被重建
- **THEN** 重新解析稳定文件关联并验证新模型，不能沿用旧 engineFileId 写入或返回保存成功
