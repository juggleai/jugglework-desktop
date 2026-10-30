## MODIFIED Requirements

### Requirement: Agent 多格式编辑上下文
系统 SHALL 按真实调用聊天提供当前 Office 文档的路径、类型、状态与模型身份。没有显式引用且没有待重新选择指令的普通请求 SHALL 保留当前文档查询语义；选区轮次由 Server 在接收时确定，相关工具与保存 MUST 解析本轮固定文档，漏传引用 MUST 拒绝而非回退当前活动 tab。DOCX 使用 doc 内容工具，CSV、XLSX 使用 sheet 内容工具，PPTX 使用 slide 内容工具；未就绪或查询失败 MUST 明确报告，不得沿用历史身份。系统 SHALL NOT 提供 Agent 新建文档动作。

#### Scenario: 本轮聊天身份与插件初始化不同
- **WHEN** 系统提示转换接收到本轮 sessionID，插件初始化包含其他聊天身份
- **THEN** 使用本轮聊天及工作区查询文档，每轮重新读取状态，其他聊天的模型与选区不进入提示

#### Scenario: 编辑当前 CSV 第一行
- **WHEN** 用户要求删除已打开 CSV 的第一行
- **THEN** Agent 读取实际工作表身份，用 sheet 内容工具删除索引 0 的一行，页面更新同一模型，由宿主保存原 CSV；若明确保留表头并删除第一条数据，则删除索引 1

#### Scenario: 原生页面选区与模型失效
- **WHEN** Agent 查询当前文档及选区
- **THEN** 宿主按 workspaceId、documentId、pageId 从所属可见存活页面即时读取，页面数据不能替换宿主模型身份；读取期间隐藏、切换或模型失效后不返回旧选区，通道失败或格式未知返回 null，不沿用历史通知

#### Scenario: 普通单元格选中后从聊天编辑
- **WHEN** 用户在 CSV 或 XLSX 页面选中单元格，在所属聊天要求 AI 修改选中内容
- **THEN** 无需 SDK 内部 AI 浮层，当前文档查询返回真实子表和最新行列范围，内容工具使用该模型与范围修改，统一宿主保存后才确认完成

#### Scenario: 暂不支持的复杂选区
- **WHEN** Word 跨单元格选择、表格浮动对象选择，或 PPT 备注、框选区域与组内选择无法提供已适配坐标
- **THEN** 返回 null 并要求明确范围，不回退到旧单元格或用外包字符范围猜测；PPT 页面和形状选区不代表形状内部文字范围

#### Scenario: PPT 单个文本形状内选择文字
- **WHEN** 用户在普通单个 PPT 文本形状内选择文字或放置光标
- **THEN** 当前文档查询额外返回该形状的 textSelection，以 UTF-16 码元和段落分隔符计算 start/count，支持反向和折叠范围；格式修改先读取原文和工具定义，再按该范围设置字符格式，不用整框替换冒充保留其他字符样式的局部编辑；非法坐标返回 null

#### Scenario: PPT 页面本地 AI 编辑入口
- **WHEN** PPT 共享页面桥、选区动作及格式能力已适配，文档处于可编辑状态
- **THEN** 宿主维护的本地入口开放输入浮层，添加进入所属聊天草稿，发送进入既有队列；SDK 在线 AI 仍关闭，未适配或无聊天归属时不开放可执行入口，普通编辑和保存保持可用

#### Scenario: PPT 缩略图单页固定上下文
- **WHEN** 用户在缩略图区选中一页并通过本地「✦」入口提交要求
- **THEN** 页面只返回页序号、空 shapeIds 和 nativeSlideIds，不沿用画布旧 textSelection；nativeSlideIds 取 SDK id 并核对 uniqueID 与引擎 slide_ids/page_id，key 仅用于 DOM 锚点，缺失或冲突的真实身份拒绝采集
- **AND** 入口位于缩略图可见留白，不遮挡预览、页码或点击目标；多页点击仅提示一次支持一页，不调用 capture、不打开浮层，后端同样拒绝多页

#### Scenario: PPT 单页目录与受限编辑工具
- **WHEN** Agent 查询本轮整页上下文和工具
- **THEN** 返回固定页身份、尺寸与已核对的 editable/preserved 目录；只开放 slide_get_page_info、slide_get_shape_info、slide_get_text、slide_set_text、slide_set_text_property 和 slide_set_shape_properties，写入指定目录内单个 editable shape_id，宿主绑定 file_id/page_index，冲突、跨页、批量或未知字段拒绝
- **AND** editable 只含普通顶层非旋转、非 placeholder、非 spAutoFit，且无翻转、竖排、文字旋转、艺术字或预设文字变形的可编辑文本框；图片、每表最多 256 格的简单未合并表格、group 及其递归子项与其他已适配只读对象保留，chart、SmartArt 等未知未适配对象拒绝整页采集

#### Scenario: PPT 空无 text body 形状及对象拒绝分码
- **WHEN** 单页包含无 text body 的装饰 shape 或未适配对象
- **THEN** 装饰 shape 仅在 get_text 成功返回 text=""、length=0 及空 runs/paragraphs/hyperlinks 时只读保留，不伪造 CR，不允许改写或移动；缺漏读取拒绝证明
- **AND** 未适配对象、合并表格或没有文字读取适配的对象的文字请求使用 office_selection_slide_objects_unsupported，多页使用 office_selection_slide_pages_unsupported，证明缺漏及超预算使用 office_selection_proof_unavailable

#### Scenario: PPT 单页文字样式与布局边界
- **WHEN** Agent 使用单页引用修改 editable 文本框
- **THEN** 支持非空多段整框改写，规范化 LF/CRLF 为 CR 后最多 4096 UTF-16，SDK 另追加尾 CR，输入尾 CR 保留为空段；整框改写允许该框字符样式重置，局部保真文字替换仍不支持
- **AND** 样式仅支持 bold、italic、六位 RGB color 和 (0,400] pt 且最多两位小数的 font_size；index/count 按最新文字核对，省略时取含尾 CR 的整框，不接受 count=-1
- **AND** 布局仅支持安全整数 pt 的 x/y/w/h，x/y ≥ 0、w/h > 0 且框完整位于页内，非整数 pt 即使可换算为整数 EMU 也拒绝；背景、主题、增删对象或页面、旋转、段落对齐和清空文本框不支持

#### Scenario: PPT EMU 页面尺寸与对象整数 pt 精度
- **WHEN** 读取页尺寸及对象几何并核对布局
- **THEN** 页面以正整数 w_emu/h_emu 为真值，除以 12700 得到允许非整数 pt 的实际页边界，w_pt/h_pt 仅为四舍五入摘要；前后 EMU 尺寸必须一致
- **AND** 对象 getter 仅返回整数 pt，proof 仅核对该精度的摘要与详情，无法检测落在同一取整值内的跨对象亚 pt 偏移，不宣称亚 pt 保真，页尺寸真值不补全对象未公开精度

#### Scenario: PPT mixed runs 缺省与显式严格比较
- **WHEN** 整页样式修改回读 mixed runs
- **THEN** 逐 UTF-16 位置比较公开 run 字段，严格区分缺省和显式，不用首字符或对象摘要补默认值；未授权的缺省转显式拒绝，等价 run 切分及 paragraphs 格式分组变化可接受
- **AND** 尾 CR 仅接受完整末段选择的本次属性继承，以及原缺省 font_name/font_size 严格等于修改前相邻字符显式值的展开

#### Scenario: PPT 单页证明与预算
- **WHEN** 宿主采集或回读整页编辑
- **THEN** 核对完整页顺序、页与对象公开详情、连续完整 runs/paragraphs/hyperlinks、图片资源身份、简单表格网格及文字、group 递归子项；包括子项在内最多 128 个 shapes，文字累计最多 16384 UTF-16（含尾 CR），证明最多 4 MiB，新文字与最坏 run 分裂预算在写入前检查
- **AND** 所有 baseline facts 限 SDK 公开可读属性，不证明包内未公开属性、图片字节或文件级无损；未知对象、缺漏及超预算均拒绝

#### Scenario: 常驻执行基线增长写前预检
- **WHEN** admission 保留基线或整页写入将增加常驻证明大小
- **THEN** 共用 64 MiB 总预算，整页写前按最坏证明上界替换旧基线计算总量，超限零原生写入；写后实际 proof 在基线推进前再检查，异常超限保留未知结果而不纳入常驻基线

#### Scenario: PPT 单页连续编辑与引用隔离
- **WHEN** 本轮只提交一个整页引用并连续改写、设样式和布局
- **THEN** 每次核对 revision 恰好增加 1、目标效果及其余公开事实后更新共同基线并保持 ready，同一 selectionRef 可连续编辑多个框及保存；其他待发或排队引用不自动刷新
- **AND** 整页引用与文字、形状或另一整页引用混用在 admission 拒绝；页重排或基线变化使旧引用 stale，不按旧页序号定位新页

#### Scenario: 自动与手动保存服从选区执行状态
- **WHEN** 同一 workspaceId、documentId 及 pageId:engineFileId 模型代次的任一已接收选区执行处于 running 或 needs-verification
- **THEN** 通用文档保存检查阻止自动、Agent、手动及选区保存并返回 office_selection_save_blocked；未知写入不得自动重试，已确认的 ready 中间态可保存，选区保存仍须核对当前内容与基线

#### Scenario: 保存等待期间模型退役
- **WHEN** 保存等待页面提交、已有保存或内容查询期间，原模型退役或被新模型替换
- **THEN** 保存保持入口固定的 pageId 和 engineFileId 并重新核对；旧引用不能因基线释放而跳过确认，不能按 documentId 改绑并保存新模型，也不能返回旧引用保存成功

#### Scenario: 人工核对及新引用接管未知修改
- **WHEN** 普通 capture 遇到同代次 needs-verification
- **THEN** 返回 office_selection_review_required，由宿主要求原生人工核对，普通重选、admission 或后续调用不能绕过 blocker；running 即使确认也不允许接管
- **AND** 只有用户明确确认保留当前内容后，宿主通过 host-token 的 selection-references/review-confirmed 路由携带 expectedGeneration，并通过当前代次核对、新 capture 的两次同状态 proof、内容/容量及最终 live 检查，才将旧 unknown 设为 superseded 并清理旧基线；旧任务不可再写入或保存
- **AND** 普通 client 拒绝 reviewedUnconfirmed/expectedGeneration 自报，确认路由也拒绝 reviewedUnconfirmed；取消或任一检查失败不解除旧 blocker，模型退役按代次 supersede，新模型不受旧代次 blocker 影响

#### Scenario: 原生页面失焦与 DOCX 中间分页限制
- **WHEN** 未提交浮层所在编辑页窗口失焦，或 DOCX 正文证明遇到公开只读接口无法证明的中间分页
- **THEN** 普通失焦收起浮层并取消候选，不清理已添加草稿或已接收任务；同一次 pending capture 的人工核对 dialog 仅暂缓 modal blur，切到其他应用或窗口仍取消，现有失焦问题未解决；无法证明的中间分页拒绝采集，不以无预览 Paragraph 冒充分页

#### Scenario: PPT 单页已验证范围
- **WHEN** 记录 macOS ARM64、SDK 0.0.0.499 的编辑能力状态
- **THEN** 单页整页引用已通过真实 SDK 的连续多段改写、四种样式、布局、图片/简单表格公开事实保留、保存重开与未知结果阻断，以及原生页面缩略图入口、SDK 页身份、中文提交、同引用多框修改与保存端到端验证；多页本地零 capture 已验证
- **AND** 真实原生核对 dialog 手工点击与恢复、Word/PPT 在两个宿主中的完整桌面 Agent 对话、物理中文输入法和其他平台实机仍待验收；失焦问题未解决，路由或自动回归通过不等于真实 dialog 和完整对话验收

#### Scenario: 本轮固定选区与活动 tab 不同
- **WHEN** 已接收消息的选区指向 Word 文档，而用户随后切换查看表格
- **THEN** 该标签的修改和保存仍绑定原 Word 模型，表格不能替代其目标

#### Scenario: 无标签当前文档编辑
- **WHEN** 用户直接要求修改当前打开文档，且没有因清理选区而待重新绑定的指令
- **THEN** 沿用原有按聊天查询当前模型及实时选区的行为，不复用历史标签作为本轮选区
