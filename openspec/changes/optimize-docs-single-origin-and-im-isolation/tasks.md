## 设计
- [x] 确认源码复用点；以共享增量契约为唯一跨端定义，三仓严格校验通过。

## 实际开发
- [x] 删除聊天分类状态／调用／整群过滤和无引用类型；卡片改用已有接收 scope，保留点击验证。
- [x] 复用 runtime-config 获取固定入口，替换 t- 检查；现有 Electron 分区增加 tenantId，并对接 Docs 页面绑定及规范链接；现有宿主按 reason 处理错误，禁止全 Origin 清理待同步数据。
- [x] 扩展 FileWindowApp 云文档标签，复用现有 cloudDocsPanel／受限 IPC／AI 会话，关闭前确认原生本地持久化／同步状态。
- [x] File Browser 构建成功后清理旧 Documents helper；本机重建与签名校验通过。

## 验证

- [x] 本机模拟 A1～A3：不同 AppKey 切换、SDK 分页、旧历史／事件、卡片接收及点击验证，普通聊天无 Docs 分类或 launch 依赖。
- [x] A8／A9 相关原生宿主归属、后台池、保留标签／浮窗、上传分享、会话冻结与关闭落盘回执自动化回归。
- [x] 真实 Electron 验证受限 File Browser 的开发／asar preload、独立分区、权限白名单与 IPC 清理；Desk 类型检查与源码构建。
- [x] 本机开发启动器重启保活及固定 Origin 上传／AI 工具链／重启持久化验证；真实模型调用按本轮决定跳过。
- [ ] A4／A5／A8／A9 与 Docs 的真实多账号、多组织和原生多窗口协作联合验收。
- [ ] 配合 A10～A12 测试环境、管理台、真实模型提供方及双成员上传／AI／重启保存验收。

结果与边界见 [实现与验证](../../../../jugglework-server/openspec/changes/optimize-docs-single-origin-and-im-isolation/implementation.md)。
