import type {
  AgentRuntimeCapability,
  AgentRuntimeDescriptor,
} from "@jugglework/types/agent-runtime";

export const agentRuntimeControlCapability = {
  model: "models",
  variant: "variants",
  reasoning: "reasoning-stream",
  command: "commands",
  shell: "shell",
  compact: "compact",
  resume: "resume",
  fork: "fork",
  steer: "steer",
  enqueue: "enqueue",
  permission: "permissions",
  question: "questions",
  todo: "todos",
  mcp: "mcp",
  subagent: "subagents",
  checkpoint: "file-checkpointing",
  usage: "usage-and-cost",
  prewarm: "prewarm",
  residentSession: "resident-session",
  plan: "plan-mode",
  rewind: "rewind",
  currentTurnModel: "dynamic-model",
  currentTurnEffort: "dynamic-effort",
  currentTurnPermission: "dynamic-permission-mode",
} as const satisfies Record<string, AgentRuntimeCapability>;

export type AgentRuntimeControl = keyof typeof agentRuntimeControlCapability;
export type AgentRuntimeControlPolicy = Partial<Record<AgentRuntimeControl, boolean>>;

export type AgentRuntimeControlState = {
  supported: boolean;
  enabled: boolean;
  reason: "unsupported" | "runtime-unavailable" | "policy-disabled" | null;
};

export function isAgentRuntimeAvailable(descriptor: AgentRuntimeDescriptor): boolean {
  return descriptor.health.status === "healthy" || descriptor.health.status === "degraded";
}

export function getAgentRuntimeControlState(
  descriptor: AgentRuntimeDescriptor,
  control: AgentRuntimeControl,
  policy: { allowed?: boolean } = {},
): AgentRuntimeControlState {
  const supported = descriptor.capabilities[agentRuntimeControlCapability[control]];
  if (!supported) return { supported: false, enabled: false, reason: "unsupported" };
  if (!isAgentRuntimeAvailable(descriptor)) {
    return { supported: true, enabled: false, reason: "runtime-unavailable" };
  }
  if (policy.allowed === false) return { supported: true, enabled: false, reason: "policy-disabled" };
  return { supported: true, enabled: true, reason: null };
}

export function canUseAgentRuntimeControl(
  descriptor: AgentRuntimeDescriptor,
  control: AgentRuntimeControl,
  policy?: { allowed?: boolean },
): boolean {
  return getAgentRuntimeControlState(descriptor, control, policy).enabled;
}

export function getAgentRuntimeControlStates(
  descriptor: AgentRuntimeDescriptor,
  policy: AgentRuntimeControlPolicy = {},
): Record<AgentRuntimeControl, AgentRuntimeControlState> {
  return Object.fromEntries(
    (Object.keys(agentRuntimeControlCapability) as AgentRuntimeControl[]).map((control) => [
      control,
      getAgentRuntimeControlState(descriptor, control, { allowed: policy[control] }),
    ]),
  ) as Record<AgentRuntimeControl, AgentRuntimeControlState>;
}
