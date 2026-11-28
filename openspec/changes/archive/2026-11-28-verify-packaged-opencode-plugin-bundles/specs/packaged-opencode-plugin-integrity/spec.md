# Spec Delta

## Purpose

定义 Desktop 发布的 OpenCode plugins 必须满足的自包含构建和安装包完整性边界。

## ADDED Requirements

### Requirement: Packaged plugins are self-contained

每个发布的 OpenCode plugin 入口 SHALL 只加载同一受验证资源根目录中的 bundle 文件或明确允许的 Node/Bun 内建模块。发布输出 MUST NOT 依赖仓库 workspace package、用户机器 `node_modules`、绝对源码路径或用户 PATH。

#### Scenario: Plugin imports a bundled shared chunk

- **WHEN** 一个入口引用 Bun 在同一输出根目录生成的共享 chunk
- **THEN** 构建和最终安装包校验均接受该依赖并验证目标文件存在

#### Scenario: Stale TypeScript output keeps a package import

- **WHEN** 发布入口仍包含第三方或 workspace 裸 package specifier
- **THEN** 校验在发布前失败并指出入口与被拒绝的 specifier

### Requirement: Every delivery boundary verifies the same graph

Server build、Desktop staging 和最终 package verification SHALL 调用同一完整性规则。复制或打包后缺失入口/chunk、出现路径越界或新增未允许依赖时，后续交付 MUST 停止。

#### Scenario: Staging copy omits a chunk

- **WHEN** Server build 通过但 Desktop staging 未复制某个被入口引用的共享 chunk
- **THEN** Electron build 在启动打包前失败

#### Scenario: Final package differs from staging

- **WHEN** 最终 `.app` resources 中的 plugin graph 与已验证 staging 不一致
- **THEN** final package verifier 失败且该候选不得进入签名发布结论

### Requirement: Verification is content-minimal and reproducible

Verifier SHALL 只读取发布代码、相对路径和固定入口清单，输出稳定的文件/依赖诊断。它 MUST NOT 读取、复制或记录认证 token、用户配置、workspace 内容或私有日志。

#### Scenario: Verifier reports an invalid import

- **WHEN** 校验发现不允许的依赖
- **THEN** 诊断包含相对文件名和 import specifier，但不包含环境变量值或用户路径内容
