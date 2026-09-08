## Purpose

Define a consistent default server origin for fresh desktop installations while preserving deployments explicitly configured by users or installers.

## ADDED Requirements

### Requirement: Default desktop server origin

An unconfigured desktop installation SHALL use https://work.jugglechat.cn as its default server origin in both the renderer fallback and main-process bootstrap.

#### Scenario: Fresh installation
- **WHEN** a desktop starts without an explicit bootstrap deployment or build override
- **THEN** its default server origin is https://work.jugglechat.cn
- **AND** the control-plane API resolves under /jwork/api on that origin

#### Scenario: Explicit deployment configuration
- **WHEN** a desktop has an explicit deployment configuration
- **THEN** the default-origin change does not forcibly replace that configuration
