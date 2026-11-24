# Change: 云文档刷新恢复与重启加速

## Why

Desktop 渲染界面刷新后会生成新实例并重新申请启动授权；存活原生页缺少重新接管合同。完全退出后原生实例消失，重新进入仍需工作区、正文与编辑器初始化。静态压缩和统一 loading 不会消除重复初始化。

## What Changes

- Main 管理可恢复的产品页生命周期，区分暂时解绑、明确关闭和窗口／进程退出。
- 渲染界面刷新后，经当前授权重新确认，接管同窗口、同来源、同账号与组织的存活实例，不重新 bootstrap。
- 完全重启保留现有分区缓存与文档存储，只保存有限的非敏感恢复定位；首屏稳定后最多预热一个最近目标。
- 增加请求关联的正文可展示状态与分阶段耗时，不改变 `docs.ready` 或保存 ACK 语义。
- Docs 新增消费正常一次性 launch grant 的只读恢复校验路径；不新建共享权限缓存，不修改 Go launch 授权合同。

## Impact

- Affected specs: cloud-docs-startup
- Affected code: Desktop Main／preload／云文档宿主；Docs session controller／受限宿主桥／三类编辑器可展示信号。
- Related changes: optimize-cloud-docs-presentation；Docs 仓库 add-jugglework-docs-adaptation、add-docs-spreadsheet、add-docs-presentation。
- 不涉及数据库迁移、协作算法、正文存储协议或 Go Server 新接口。实施需同时更新 Desktop 与 Docs，旧服务回落原打开流程。

## Status

P0 已接入正文观测和匿名启动样本。P1 全页刷新恢复及 P2 单目标重启预热已实现并通过隔离 Electron 测试，两项能力默认关闭。真实环境的性能基线、授权／协作联调和资源门禁待完成。
