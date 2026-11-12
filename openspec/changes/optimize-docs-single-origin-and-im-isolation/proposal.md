## Why

组织 IM 已由现有不同 AppKey 隔离，Desk 的 Docs 分类前置造成额外依赖。云文档固定使用 https://docs.juggle.im，需要适配地址与共域名会话；独立打开复用 File Browser。

## What Changes

- 删除普通聊天的 Docs 分类等待和整群过滤；复用已有 scope、epoch 与加载去重。
- 替换 t- 地址识别，现有分区增加组织，接入页面 contextId；复用页面保留与后台池。
- 在现有 File Browser 增加云文档标签，复用原生编辑、AI 桥和窗口管理。
- 服务端 AppKey、聊天生命周期、卡片协议、上传与同步模型保持；已有功能仅回归。

## Capabilities

### New Capabilities

- desktop-im-app-isolation：已有 AppKey 连接下移除 Docs 分类依赖。
- desktop-docs-single-origin：现有视图适配固定 Origin 与页面绑定。
- unified-file-browser-cloud-docs：现有 File Browser 增加云文档类型。

## Impact

改动集中于 jugglechat/store.ts、docs-message.ts、Docs 地址识别、Electron cloud-docs-panel／文件窗口和 FileWindowApp；runtime.ts／后台池仅在发现实际缺口时修补。跨端差量只维护在 [共享契约](../../../../jugglework-server/openspec/changes/optimize-docs-single-origin-and-im-isolation/integration-contract.md)。除已完成的旧 helper 清理，源码实现已完成，环境联合验收按统一清单执行。
