# Tasks

## 1. Bundle construction

- [x] 1.1 将全部发布 OpenCode plugin 入口改为单一 Bun 多入口 build graph，启用 package bundling 与共享 chunk splitting。
- [x] 1.2 保持输出目录清理和确定入口清单，避免旧 chunk 或非发布源码混入结果。

## 2. Integrity verifier

- [x] 2.1 新增可导入和 CLI 调用的 verifier，递归检查预期入口、相对 import graph、根目录约束、文件存在性和内建模块 allowlist。
- [x] 2.2 拒绝 source map、绝对/越界路径、缺失 chunk、workspace/第三方裸 package import 和无法静态判定的发布依赖。
- [x] 2.3 添加通过与失败 fixtures，覆盖 bundled shared chunk、stale tsc output、路径穿越和缺失入口。

## 3. Delivery gates

- [x] 3.1 在 Server build 完成后执行 verifier。
- [x] 3.2 在 Desktop 复制 Server dist 到 Electron staging 后、electron-builder 启动前执行 verifier。
- [x] 3.3 在最终 macOS `.app` package verifier 中验证发布 resources，并把结果写入非敏感验证输出。

## 4. Verification

- [x] 4.1 运行 verifier 聚焦测试、Server typecheck/build、Electron typecheck 和 diff whitespace 检查。
- [ ] 4.2 在下一次真实签名 packaged candidate 中保留 final package verifier 通过证据；源码级通过不得冒充已完成原生发布验收。
