import type {
  AgentRuntimeCatalog,
  AgentRuntimeDescriptor,
  AgentRuntimeDiagnosticCategory,
  AgentRuntimeSessionConfiguration,
} from "@jugglework/types/agent-runtime";
import { classifyAgentRuntimeDiagnostic } from "@jugglework/types/agent-runtime";

import { captureAnalyticsEvent } from "@/app/lib/analytics";
import type { SidebarSessionItem } from "@/app/types";

const DEFAULT_RUNTIME_KEY = "jugglework.agentRuntime.default";

function storageKey(workspaceId: string): string {
  return `${DEFAULT_RUNTIME_KEY}.${workspaceId.trim()}`;
}

export function readPermittedAgentRuntimeDefault(
  workspaceId: string,
  catalog: AgentRuntimeCatalog,
): string {
  let stored = "";
  try {
    stored = window.localStorage.getItem(storageKey(workspaceId))?.trim() ?? "";
  } catch {}
  if (stored && catalog.runtimes.some((runtime) => runtime.id === stored)) return stored;
  return catalog.runtimes.find((runtime) => runtime.isDefault)?.id ?? catalog.runtimes[0]?.id ?? "";
}

export function writePermittedAgentRuntimeDefault(
  workspaceId: string,
  runtimeId: string,
  catalog: AgentRuntimeCatalog,
): boolean {
  if (!catalog.runtimes.some((runtime) => runtime.id === runtimeId)) return false;
  try {
    window.localStorage.setItem(storageKey(workspaceId), runtimeId);
  } catch {}
  return true;
}

export function isAgentRuntimeSelectable(runtime: AgentRuntimeDescriptor): boolean {
  return runtime.health.status === "healthy" || runtime.health.status === "degraded";
}

export function describeAgentRuntimeUnavailable(runtime: AgentRuntimeDescriptor): string | null {
  if (isAgentRuntimeSelectable(runtime)) return null;
  if (runtime.health.message?.trim()) return runtime.health.message.trim();
  const reason = runtime.health.reasonCode?.replaceAll("_", " ") ?? runtime.health.status;
  return `${runtime.label} is ${runtime.health.status}: ${reason}. Check Agent Runtime diagnostics and retry.`;
}

export function runtimeSessionConfiguration(input: {
  agentProfile?: string | null;
  model?: { providerID: string; modelID: string } | null;
  effort?: string | null;
}): AgentRuntimeSessionConfiguration {
  return {
    ...(input.agentProfile?.trim() ? { agentProfile: input.agentProfile.trim() } : {}),
    ...(input.model ? { model: { providerId: input.model.providerID, modelId: input.model.modelID } } : {}),
    ...(input.effort?.trim() ? { execution: { effort: input.effort.trim() } } : {}),
  };
}

export function sessionRuntimeIdentity(session: SidebarSessionItem | null | undefined): {
  runtime: string;
  profile: string | null;
  model: string | null;
  execution: string | null;
} | null {
  if (!session?.runtimeId) return null;
  const budget = session.runtimeExecution?.budget;
  const budgetParts = [
    budget?.maxTurns ? `${budget.maxTurns} turns` : null,
    budget?.maxCostUsd ? `$${budget.maxCostUsd}` : null,
    budget?.maxDurationMs ? `${Math.round(budget.maxDurationMs / 1000)}s` : null,
  ].filter(Boolean);
  return {
    runtime: session.runtimeId === "jugglework" ? "JuggleWork" : session.runtimeId === "claude-agent" ? "Claude Agent" : session.runtimeId,
    profile: session.agentProfile ?? null,
    model: session.runtimeModel ? `${session.runtimeModel.providerId}/${session.runtimeModel.modelId}` : null,
    execution: [session.runtimeExecution?.effort, ...budgetParts].filter(Boolean).join(" · ") || null,
  };
}

export function recordAgentRuntimeDiagnostic(input: {
  event: "selected" | "creation_failed" | "unavailable";
  runtimeId: string;
  reasonCode?: string | null;
  workspaceRemote: boolean;
}): AgentRuntimeDiagnosticCategory {
  const category = classifyAgentRuntimeDiagnostic(input.reasonCode);
  const reasonCode = input.reasonCode?.trim() ?? "";
  captureAnalyticsEvent(`agent_runtime_${input.event}`, {
    runtime_id: input.runtimeId,
    category,
    reason_code: /^[a-z0-9_.-]{1,128}$/i.test(reasonCode) ? reasonCode : null,
    workspace_remote: input.workspaceRemote,
  });
  return category;
}
