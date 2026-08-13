export const CLAUDE_AGENT_RUNTIME_FEATURE_FLAG = "JUGGLEWORK_CLAUDE_AGENT_ENABLED" as const;
export const CLAUDE_AGENT_RUNTIME_KILL_SWITCH = "JUGGLEWORK_CLAUDE_AGENT_KILL_SWITCH" as const;
export const CLAUDE_AGENT_ROLLOUT_STAGE_ENV = "JUGGLEWORK_CLAUDE_ROLLOUT_STAGE" as const;
export const CLAUDE_AGENT_INTERNAL_COHORT_ENV = "JUGGLEWORK_CLAUDE_INTERNAL_COHORT" as const;
export const CLAUDE_AGENT_USER_OPT_IN_ENV = "JUGGLEWORK_CLAUDE_USER_OPT_IN" as const;

export const CLAUDE_AGENT_ROLLOUT_STAGES = ["internal", "opt-in", "ga"] as const;
export type ClaudeAgentRolloutStage = (typeof CLAUDE_AGENT_ROLLOUT_STAGES)[number];
export type ClaudeAgentRolloutReason =
  | "enabled"
  | "feature_disabled"
  | "kill_switch"
  | "invalid_stage"
  | "cohort_ineligible";

export type ClaudeAgentRolloutResolution = {
  enabled: boolean;
  stage: ClaudeAgentRolloutStage | null;
  reason: ClaudeAgentRolloutReason;
  internalCohort: boolean;
  userOptIn: boolean;
};

function explicitTrue(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

export function resolveClaudeAgentRollout(env: NodeJS.ProcessEnv = process.env): ClaudeAgentRolloutResolution {
  const internalCohort = explicitTrue(env[CLAUDE_AGENT_INTERNAL_COHORT_ENV]);
  const userOptIn = explicitTrue(env[CLAUDE_AGENT_USER_OPT_IN_ENV]);
  const rawStage = env[CLAUDE_AGENT_ROLLOUT_STAGE_ENV]?.trim().toLowerCase() || "internal";
  const stage = CLAUDE_AGENT_ROLLOUT_STAGES.find((candidate) => candidate === rawStage) ?? null;

  if (!explicitTrue(env[CLAUDE_AGENT_RUNTIME_FEATURE_FLAG])) {
    return { enabled: false, stage, reason: "feature_disabled", internalCohort, userOptIn };
  }
  if (explicitTrue(env[CLAUDE_AGENT_RUNTIME_KILL_SWITCH])) {
    return { enabled: false, stage, reason: "kill_switch", internalCohort, userOptIn };
  }
  if (!stage) return { enabled: false, stage: null, reason: "invalid_stage", internalCohort, userOptIn };

  const eligible = stage === "ga" || internalCohort || (stage === "opt-in" && userOptIn);
  return {
    enabled: eligible,
    stage,
    reason: eligible ? "enabled" : "cohort_ineligible",
    internalCohort,
    userOptIn,
  };
}
