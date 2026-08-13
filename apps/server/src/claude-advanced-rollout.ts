import {
  CLAUDE_ADVANCED_FEATURES,
  type ClaudeAdvancedFeature,
} from "@jugglework/types/agent-runtime";

export type ClaudeAdvancedRolloutOutcome =
  | "used"
  | "fallbacks"
  | "flagDisabled"
  | "policyDenied"
  | "killed"
  | "capabilityMissing";

type FeatureState = {
  enabled: boolean;
  flagEnabled: boolean;
  policyAllowed: boolean;
  killed: boolean;
};

const ENV_STEMS: Record<ClaudeAdvancedFeature, string> = {
  prewarm: "PREWARM",
  resident: "RESIDENT_SESSIONS",
  interrupt: "PROTOCOL_INTERRUPT",
  "queued-input": "QUEUED_INPUT",
  steer: "STEER",
  "dynamic-model": "DYNAMIC_MODEL",
  "dynamic-effort": "DYNAMIC_EFFORT",
  "dynamic-permission": "DYNAMIC_PERMISSION_MODE",
  subagents: "SUBAGENTS",
  plan: "PLAN_MODE",
  checkpoint: "FILE_CHECKPOINTING",
  rewind: "REWIND",
  fork: "NATIVE_FORK",
  "provider-gateway": "PROVIDER_GATEWAY",
  "provider-bedrock": "PROVIDER_BEDROCK",
  "provider-vertex": "PROVIDER_VERTEX",
  "provider-foundry": "PROVIDER_FOUNDRY",
};

function explicitTrue(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

export function claudeAdvancedFeatureEnvironment(feature: ClaudeAdvancedFeature) {
  const stem = ENV_STEMS[feature];
  return {
    flag: `JUGGLEWORK_CLAUDE_${stem}_ENABLED`,
    policy: `JUGGLEWORK_CLAUDE_${stem}_POLICY_ALLOWED`,
    killSwitch: `JUGGLEWORK_CLAUDE_${stem}_KILL_SWITCH`,
  } as const;
}

export class ClaudeAdvancedRollout {
  readonly #states = new Map<ClaudeAdvancedFeature, FeatureState>();

  constructor(options: {
    env?: NodeJS.ProcessEnv;
    onConfigured?: (feature: ClaudeAdvancedFeature, enabled: boolean) => void;
    onMetric?: (feature: ClaudeAdvancedFeature, outcome: ClaudeAdvancedRolloutOutcome) => void;
  } = {}) {
    const env = options.env ?? process.env;
    this.onMetric = options.onMetric;
    for (const feature of CLAUDE_ADVANCED_FEATURES) {
      const names = claudeAdvancedFeatureEnvironment(feature);
      const state = {
        flagEnabled: explicitTrue(env[names.flag]),
        policyAllowed: explicitTrue(env[names.policy]),
        killed: explicitTrue(env[names.killSwitch]),
        enabled: false,
      };
      state.enabled = state.flagEnabled && state.policyAllowed && !state.killed;
      this.#states.set(feature, state);
      options.onConfigured?.(feature, state.enabled);
    }
  }

  private readonly onMetric?: (feature: ClaudeAdvancedFeature, outcome: ClaudeAdvancedRolloutOutcome) => void;

  enabled(feature: ClaudeAdvancedFeature, capabilitySupported = true): boolean {
    return this.#states.get(feature)!.enabled && capabilitySupported;
  }

  use(feature: ClaudeAdvancedFeature, capabilitySupported = true): boolean {
    const state = this.#states.get(feature)!;
    const outcome: ClaudeAdvancedRolloutOutcome = state.killed
      ? "killed"
      : !state.flagEnabled
        ? "flagDisabled"
        : !state.policyAllowed
          ? "policyDenied"
          : !capabilitySupported
            ? "capabilityMissing"
            : "used";
    this.onMetric?.(feature, outcome);
    return outcome === "used";
  }

  fallback(feature: ClaudeAdvancedFeature): void {
    this.onMetric?.(feature, "fallbacks");
  }
}
