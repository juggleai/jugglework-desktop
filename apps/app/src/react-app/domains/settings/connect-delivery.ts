import type { PluginDeliveryComposition } from "./connect-cloud-readiness";

/**
 * 市场插件的投递表述。
 *
 * TIPS: 承载方式是每个 MCP 组件的属性，插件层只做"最弱环节"聚合——只要有一个组件
 * 必须由桌面端拉起，插件就不是纯云端可用的，不能笼统显示成「在云端运行」。
 */
export type MarketplaceDeliveryActionKind =
  | "cloud_active"
  | "cloud_active_local_copy"
  | "desktop_install_required"
  | "mixed_partial_desktop";

export function shouldShowExtensionsMarketplacePane() {
  return true;
}

/**
 * 判定插件卡片与详情该用哪种投递表述。
 *
 * @param input.importedLocally 是否已在本工作区安装了副本
 * @param input.composition MCP 组件的投递构成；无 MCP 组件时为 null
 */
export function resolveMarketplaceDeliveryAction(input: {
  importedLocally: boolean;
  composition?: PluginDeliveryComposition | null;
}): MarketplaceDeliveryActionKind {
  const composition = input.composition ?? null;
  if (composition?.kind === "desktop") return "desktop_install_required";
  if (composition?.kind === "mixed") return "mixed_partial_desktop";
  return input.importedLocally ? "cloud_active_local_copy" : "cloud_active";
}
