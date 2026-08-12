import type { AutomationStableEnvelope } from "@jugglework/types/automation";
import type { DenAutomationCapabilities } from "@/app/lib/den";

export type AutomationSyncCapabilityDecision = {
  storageSupported: boolean;
  displayProjectionSupported: boolean;
  connectorPolicySupported: boolean;
  errorCode?: "automation_projection_unsupported";
};

/**
 * 独立判断稳定存储格式与可选投影语义，未知文档 schema 不参与兼容性判断。
 * @param capabilities 服务端声明的自动化能力
 * @param envelope 待上传的稳定 envelope
 */
export function negotiateAutomationSync(
  capabilities: DenAutomationCapabilities,
  envelope: AutomationStableEnvelope,
): AutomationSyncCapabilityDecision {
  const storageSupported = capabilities.envelopeVersions.includes(envelope.envelopeVersion)
    && capabilities.documentMediaTypes.includes(envelope.documentMediaType);
  const supported = (kind: string, version: number) => capabilities.projections[kind]?.includes(version) ?? false;
  const hasProjection = (kind: string, version: number) => envelope.projections.some(
    (projection) => projection.kind === kind && projection.version === version,
  );

  return {
    storageSupported,
    displayProjectionSupported: hasProjection("automation-display", 1) && supported("automation-display", 1),
    connectorPolicySupported: hasProjection("automation-connector-policy", 1)
      && supported("automation-connector-policy", 1),
    ...(!storageSupported ? { errorCode: "automation_projection_unsupported" as const } : {}),
  };
}
