# Design

## Context

OpenCode plugins 从 `apps/server/dist/opencode-plugins` 复制到 Desktop resources，并由打包后的 OpenCode runtime 直接加载。它们不在 `app.asar` 的依赖解析环境内，因此“TypeScript 可编译”不等于“安装包可加载”。

## Goals / Non-Goals

**Goals:**

- 让发布 plugin 只依赖 bundle 内文件和明确允许的 Node/Bun 内建模块。
- 在最早可行动的 Server build 阶段失败，并在 Desktop staging/final package 再次验证复制结果。
- 让 verifier 可独立测试，错误指出文件和被拒绝的 specifier。

**Non-Goals:**

- 不执行 plugin 业务逻辑或连接真实 MCP/Cloud 服务。
- 不把 secrets、配置或 workspace 数据嵌入 bundle。
- 不以 verifier 替代真实 packaged OpenCode 启动兼容测试。

## Decisions

### 1. 单一多入口 build graph

Server 使用一个 Bun 多入口 build，并启用 package bundling 与 splitting。这样第三方运行时依赖进入输出，共享依赖可以形成确定性 chunk，而不是为每个入口复制或保留 workspace import。

### 2. 静态 import graph 的默认拒绝校验

Verifier 从预期入口递归读取相对静态 import/export 和 literal dynamic import。相对目标必须留在 plugin 输出根目录且真实存在；裸 specifier 只允许 Node/Bun 内建模块。源码映射、绝对路径、目录穿越和第三方裸包均失败。

### 3. 同一校验复用三个交付边界

Server build 验证生成物；Electron build 在复制到 staging 后验证；最终 macOS verifier 验证 `.app/Contents/Resources/opencode-plugins`。三个入口调用同一实现，避免 stage-specific 规则漂移。

## Risks / Trade-offs

- Bun 输出格式变化可能触发校验误报；通过 fixture tests 固定允许的 import 形状，并让错误可诊断。
- 静态分析不能证明运行时业务兼容；保留现有真实 sidecar/package smoke 作为更高层验收。
- splitting 增加共享 chunk；递归 graph 校验确保 chunk 不缺失或越界。

## Migration Plan

1. 先加入 verifier fixtures，并证明其拒绝未 bundle 的第三方 import、缺失 chunk 和路径越界。
2. 更新 Server build，验证现有全部 plugin 入口通过。
3. 接入 Desktop staging 和 final macOS package verifier。
4. 回滚时可恢复旧 build command，但不得发布未通过最终 package verifier 的候选。
