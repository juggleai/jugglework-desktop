import type { DenAutomationMirror } from "@/app/lib/den";

export const AUTOMATION_MIRRORS_CHANGED_EVENT = "jugglework:automation-mirrors-changed";
const CACHE_PREFIX = "jugglework.automation.readonly-mirrors.v1:";

export type ReadOnlyAutomationMirror = {
  id: string;
  name: string;
  workspaceName: string;
  lifecycle: string;
  revision: number;
  executorDeviceId: string;
  compatibility: "incompatible-read-only";
};

/** 仅提取服务端最小列表字段；提示词和 opaque envelope 不进入浏览器缓存。 */
export function toReadOnlyAutomationMirror(value: DenAutomationMirror): ReadOnlyAutomationMirror | null {
  const display = record(value.display) ?? record(value.displayProjection) ?? value;
  const id = text(value.automationId) || text(value.id);
  const executorDeviceId = text(value.executorDeviceId);
  if (!id || !executorDeviceId) return null;
  return {
    id,
    name: text(display.name) || "Unsupported automation",
    workspaceName: text(display.workspaceName) || "—",
    lifecycle: text(display.lifecycle) || text(value.state) || "unknown",
    revision: integer(value.revision),
    executorDeviceId,
    compatibility: "incompatible-read-only",
  };
}

/** 原子替换一个组织的跨设备只读镜像最小缓存。 */
export function writeReadOnlyAutomationMirrors(orgId: string, mirrors: ReadOnlyAutomationMirror[]): void {
  localStorage.setItem(`${CACHE_PREFIX}${orgId}`, JSON.stringify(mirrors));
  window.dispatchEvent(new CustomEvent(AUTOMATION_MIRRORS_CHANGED_EVENT, { detail: { orgId } }));
}

/** 读取一个组织的跨设备只读镜像最小缓存。 */
export function readReadOnlyAutomationMirrors(orgId: string): ReadOnlyAutomationMirror[] {
  try {
    const value = JSON.parse(localStorage.getItem(`${CACHE_PREFIX}${orgId}`) ?? "[]");
    return Array.isArray(value) ? value.filter(isMirror) : [];
  } catch {
    return [];
  }
}

function isMirror(value: unknown): value is ReadOnlyAutomationMirror {
  const candidate = record(value);
  return Boolean(candidate && text(candidate.id) && text(candidate.executorDeviceId));
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}
