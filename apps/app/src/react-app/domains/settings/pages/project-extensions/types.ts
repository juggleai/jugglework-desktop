import type { SkillItem } from "../mcp-view";

/**
 * 连接器(MCP) 选择弹窗中的一行，聚合自「组织下发 / 快速连接目录 / 已装 MCP」。
 * @param key 去重后的唯一标识
 * @param name 展示名称
 * @param description 描述
 * @param connected 是否已连接
 * @param busy 是否正在连接/断开中
 * @param source 来源类别
 * @param onConnect 未连接时触发连接
 * @param onDisconnect 已连接时触发断开（可选）
 */
export type ConnectorRow = {
  key: string;
  name: string;
  description?: string | null;
  connected: boolean;
  busy?: boolean;
  source: "org" | "directory" | "installed";
  onConnect?: () => void;
  onDisconnect?: () => void;
};

/** 分组卡片面板对外的数据与回调。 */
export type ProjectExtensionsPanelProps = {
  /** 项目根目录，作为技能安装与指令文件的落点。 */
  projectDir: string;
  isRemoteWorkspace: boolean;
  busy?: boolean;
  /** 聚合后的连接器列表。 */
  connectors: ConnectorRow[];
  /** 已安装技能（含项目级与全局，带 scope）。 */
  installedSkills: SkillItem[];
  /** 卸载项目级技能。 */
  onUninstallSkill: (name: string) => void;
  /** 从本地上传技能到项目。 */
  onUploadSkill: () => void | Promise<void>;
  /** 安装/卸载后刷新技能列表。 */
  onRefreshSkills: () => void | Promise<void>;
};
