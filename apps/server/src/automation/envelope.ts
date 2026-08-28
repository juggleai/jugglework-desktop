import { createHash } from "node:crypto";
import type { AutomationStableEnvelope } from "@jugglework/types/automation";

/**
 * 将任务定义或运行详情序列化为服务端无需理解的稳定 envelope。
 * @param entityType 同步实体类型
 * @param source 已通过本地校验的完整文档
 */
export function createAutomationEnvelope(
  entityType: "definition" | "run",
  source: unknown,
): AutomationStableEnvelope {
  const document = portableDocument(entityType, source);
  const documentBytes = deterministicJsonBytes(document);
  const documentDigest = digest(documentBytes);
  const projections = entityType === "definition"
    ? definitionProjections(document, documentDigest)
    : [projection("automation-display/v1", runDisplayProjection(document))];
  return {
    envelopeVersion: 1,
    documentSchema: entityType === "definition" ? "automation-definition/v1" : "automation-run/v1",
    documentMediaType: "application/json",
    documentBase64: documentBytes.toString("base64"),
    documentDigest,
    projections,
  };
}

/** 返回稳定键序 JSON 字节，确保失败重试仍使用相同摘要。 */
export function deterministicJsonBytes(value: unknown): Buffer {
  return Buffer.from(stableStringify(value), "utf8");
}

function portableDocument(entityType: "definition" | "run", source: unknown): unknown {
  const cloned = structuredClone(source);
  if (entityType === "definition" && isRecord(cloned) && isRecord(cloned.workspace)) {
    // TIPS: 本机绝对路径只用于执行定位，云镜像仅保留工作空间不透明 id 与显示快照。
    const { path: _path, ...portableWorkspace } = cloned.workspace;
    cloned.workspace = portableWorkspace;
  }
  rejectSensitiveData(cloned);
  return cloned;
}

function definitionProjections(document: unknown, documentDigest: string) {
  if (!isRecord(document)) return [];
  const connectors = Array.isArray(document.connectors)
    ? document.connectors.flatMap((connector) => isRecord(connector) && typeof connector.id === "string" ? [connector.id] : [])
    : [];
  const permissionProfile = isRecord(document.permission) && typeof document.permission.profile === "string"
    ? document.permission.profile
    : "";
  return [
    projection("automation-display/v1", {
      name: typeof document.name === "string" ? document.name : "",
      workspaceName: isRecord(document.workspace) && typeof document.workspace.name === "string" ? document.workspace.name : "",
      schedule: document.schedule,
      lifecycle: document.lifecycle,
      nextRunAt: document.nextRunAt,
      revision: document.revision,
    }),
    projection("automation-connector-policy/v1", {
      definitionRevision: document.revision,
      documentDigest,
      selectedConnectionIds: [...new Set(connectors)].sort(),
      permissionProfile,
    }),
  ];
}

function runDisplayProjection(document: unknown) {
  if (!isRecord(document)) return {};
  return {
    automationName: document.automationName,
    state: document.state,
    triggerSource: document.triggerSource,
    scheduledFor: document.scheduledFor,
    startedAt: document.startedAt,
    endedAt: document.endedAt,
    revision: document.revision,
  };
}

function projection(kind: string, value: unknown) {
  const bytes = deterministicJsonBytes(value);
  const [name, versionText] = kind.split("/v");
  return {
    kind: name,
    version: Number(versionText),
    mediaType: "application/json",
    payloadBase64: bytes.toString("base64"),
    digest: digest(bytes),
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function rejectSensitiveData(value: unknown, key = ""): void {
  if (/(authorization|credential|password|secret|access.?token|refresh.?token|api.?key|transcript|tool.?outputs?|session.?messages?)/i.test(key)) {
    throw new Error("Automation sync document contains credential-shaped data");
  }
  if (typeof value === "string" && (
    /^(blob|data):/i.test(value)
    || isAbsolutePath(value)
  )) {
    throw new Error("Automation sync document contains non-portable data");
  }
  if (Array.isArray(value)) {
    value.forEach((item) => rejectSensitiveData(item));
    return;
  }
  if (!isRecord(value)) return;
  for (const [childKey, child] of Object.entries(value)) rejectSensitiveData(child, childKey);
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
