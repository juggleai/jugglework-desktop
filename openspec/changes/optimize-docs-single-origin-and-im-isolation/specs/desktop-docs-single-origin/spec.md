## ADDED Requirements

### Requirement: Existing Docs views use the configured fixed Origin
Desktop SHALL 从既有 Work runtime-config 读取固定地址，精确校验现有 bootstrapUrl，替换 t- 前缀判断；现有分区增加组织，页面绑定遵守共享契约。

#### Scenario: An arbitrary bootstrap address is provided
- **WHEN** 地址与当前来源配置不一致，或路径／协议不合法
- **THEN** 不发送 grant，不把现有受管视图带到任意站点

### Requirement: Existing links and retained pages adapt without rebuilding their lifecycle
链接 SHALL 复用结构化定位，跨组织复用原切换确认。现有保留页与后台池 SHALL 继续复用，外观、上传及 AI 保持既有交互。

#### Scenario: A document tab is reactivated
- **WHEN** 同组织已就绪且未关闭的标签重新激活
- **THEN** 恢复原实例，不重复申请交接；取消跨组织打开不读取目标正文
