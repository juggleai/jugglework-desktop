// Den wire types shared across module boundaries (den.ts, den-session-events,
// jugglework-server, desktop cloud sync). Extracted from den.ts so that modules
// needing only the shapes do not import the 2k-line client implementation —
// den.ts re-exports everything here, so existing imports keep working.
import type {
  JuggleWorkExtensionManifest,
  JuggleWorkExtensionSourceFormat,
} from "../extensions";

export type DenSettings = {
  baseUrl: string;
  apiBaseUrl?: string;
  authToken?: string | null;
  activeOrgId?: string | null;
  activeOrgSlug?: string | null;
  activeOrgName?: string | null;
};

export type DenUser = {
  id: string;
  email: string;
  name: string | null;
  account?: string | null;
  avatar?: string | null;
  imUserId?: string | null;
};

export type DenIMLoginBootstrap = {
  provider: string;
  websocketUrl: string;
  appKey: string;
  imUserId: string;
  token: string;
};

export type DenPluginConfigObjectType =
  | "skill"
  | "agent"
  | "command"
  | "tool"
  | "mcp"
  | "hook"
  | "context"
  | "custom";

export type DenPluginConfigObjectVersion = {
  id: string;
  rawSourceText: string | null;
  normalizedPayloadJson: Record<string, unknown> | null;
  sourceRevisionRef: string | null;
  createdAt: string | null;
};

export type DenPluginConfigObject = {
  id: string;
  objectType: DenPluginConfigObjectType;
  title: string;
  description: string | null;
  currentFileName: string | null;
  currentFileExtension: string | null;
  currentRelativePath: string | null;
  status: string;
  updatedAt: string | null;
  latestVersion: DenPluginConfigObjectVersion | null;
};

export type DenPluginMembership = {
  id: string;
  pluginId: string;
  configObjectId: string;
  configObject?: DenPluginConfigObject;
};

export type DenOrgExtensionProjection = {
  id: string;
  name: string;
  description: string | null;
  sourceFormat: JuggleWorkExtensionSourceFormat;
  manifest: JuggleWorkExtensionManifest | null;
};

export type DenPluginCloudReadinessState = "ready" | "needs_signin" | "needs_admin_setup" | "desktop_only" | "not_synced";

export type DenPluginCloudReadinessConnection = {
  id: string | null;
  name: string;
  url: string;
  configObjectId?: string;
  serverName?: string;
  credentialMode?: "shared" | "per_member";
  connectedForMe?: boolean;
};

/** MCP server 的承载方式：cloud 走远程端点，desktop 需装到工作区由本地进程运行。 */
export type DenPluginMcpDelivery = "cloud" | "desktop";

/**
 * 插件里单个 MCP server 的承载明细。
 * @param configObjectId 所属配置对象
 * @param serverName MCP server 名，扁平 payload 下可能为空串
 * @param delivery 承载方式
 * @param url 远程端点（delivery 为 cloud）
 * @param command 启动命令（delivery 为 desktop）
 * @param connectionId 已绑定的组织外部连接
 * @param credentialMode 凭据模式
 * @param connectedForMe 当前成员是否已授权
 */
export type DenPluginMcpComponent = {
  configObjectId: string;
  serverName: string;
  delivery: DenPluginMcpDelivery;
  url?: string;
  command?: string[];
  connectionId?: string | null;
  credentialMode?: "shared" | "per_member";
  connectedForMe?: boolean;
};

export type DenPluginCloudReadiness = {
  state: DenPluginCloudReadinessState;
  hasInstructional: boolean;
  connections: DenPluginCloudReadinessConnection[];
  /** 逐个 MCP server 的承载明细；旧服务端不下发该字段，读取方按缺失处理。 */
  components?: DenPluginMcpComponent[];
};

export type DenOrgPlugin = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  memberCount: number;
  updatedAt: string | null;
  componentCounts: Record<string, number>;
  /** Preferred Den surface: plugins are normalized into JuggleWork extensions. */
  extension?: DenOrgExtensionProjection | null;
  cloudReadiness?: DenPluginCloudReadiness;
};

export type DenOrgMarketplace = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  pluginCount: number;
  updatedAt: string | null;
};

export type DenOrgPluginResolved = {
  plugin: DenOrgPlugin;
  memberships: DenPluginMembership[];
  /** Future Den extension manifest; absent while Claude plugin imports are resource-only. */
  extension?: DenOrgExtensionProjection | null;
};

export type DenResourceSnapshotConfigItem = {
  configItemId: string;
  lastUpdatedAt: string;
};

export type DenResourceSnapshotPlugin = {
  pluginId: string;
  lastUpdatedAt: string;
  configItems: DenResourceSnapshotConfigItem[];
};

export type DenResourceSnapshotMarketplace = {
  lastUpdatedAt: string;
  plugins: DenResourceSnapshotPlugin[];
};

export type DenResourceSnapshot = {
  organizationId: string;
  orgMemberId: string;
  teamIds: string[];
  resources: {
    llmProviders: Record<string, string>;
    marketplaces: Record<string, DenResourceSnapshotMarketplace>;
  };
};
