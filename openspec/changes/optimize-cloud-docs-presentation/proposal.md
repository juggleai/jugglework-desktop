# Change: 云文档视图稳定性与加载展示

## Why

左侧普通导航提示触发整个云文档的截图换层，后台会话预览保留布局尺寸时也可能请求原生显示。正文初始化的多个阶段展示不同 loading，造成反复加载的观感。

## What Changes

- 导航普通提示不再遮挡原生文档，明确所属页面的原生显示与聚焦条件。
- 真实浮层保留安全截图交接及失败占位，减少重复 native bounds 调用。
- Docs 侧统一正文加载视觉，只合并在途 Office 类型查询，不缓存权限结果。
- 授权、协作、保存及命令就绪协议保持不变。

## Impact

- Affected specs: cloud-docs-presentation
- Affected code: cloud-docs 原生宿主、导航 rail、会话 surface visibility；Docs 前端加载展示与 Office 类型解析。
