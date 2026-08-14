import type * as React from "react";

import type { McpDirectoryInfo } from "@/app/constants";
import type { SkillItem } from "../mcp-view";

/**
 * 连接器(MCP) 选择弹窗中的一行，聚合自「组织下发 / 快速连接目录 / 已装 MCP」。
 * @param key 去重后的唯一标识
 * @param name 展示名称
 * @param description 描述
 * @param connected 是否已连接
 * @param busy 是否正在连接/断开中
 * @param source 来源类别
 * @param iconSlug Simple Icons 品牌图标 slug
 * @param iconSrc 直接指定的图标地址，优先级高于 iconSlug
 * @param url 服务地址，图标缺省时用于取 favicon，并在详情中展示
 * @param command 本地命令型 MCP 的启动命令
 * @param preview 是否为预览版扩展
 * @param entry 对应的目录项（含 extensionManifest），详情弹窗据此展示能力/资源/安装说明
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
  iconSlug?: string;
  iconSrc?: string;
  url?: string;
  command?: string[];
  preview?: boolean;
  entry?: McpDirectoryInfo;
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
  /** 连接/断开失败的提示文案。 */
  connectorError?: string | null;
  /** 添加自定义 MCP（复用扩展页「添加自定义应用」的连接链路）。 */
  onAddCustomMcp?: (entry: McpDirectoryInfo) => void | Promise<void>;
  /** 连接器详情里的扩展专属配置区块，与扩展页 MCP 详情同源。 */
  configSlotForConnector?: (entry: McpDirectoryInfo) => React.ReactNode | null;
  /** 已安装技能（含项目级与全局，带 scope）。 */
  installedSkills: SkillItem[];
  /** 插件弹窗内容，由宿主注入云端市场视图；入参为标题栏的搜索词。 */
  pluginsSlot?: (controls: { search: string }) => React.ReactNode;
  /** 刷新插件（云端市场）列表。 */
  onRefreshPlugins?: () => void | Promise<void>;
  /** 卸载项目级技能。 */
  onUninstallSkill: (name: string) => void;
  /** 从本地上传技能到项目。 */
  onUploadSkill: () => void | Promise<void>;
  /** 安装/卸载后刷新技能列表。 */
  onRefreshSkills: () => void | Promise<void>;
};
