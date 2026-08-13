import { describe, expect, test } from "bun:test";
import { CLAUDE_ADVANCED_FEATURES } from "@jugglework/types/agent-runtime";

import {
  ClaudeAdvancedRollout,
  claudeAdvancedFeatureEnvironment,
  type ClaudeAdvancedRolloutOutcome,
} from "./claude-advanced-rollout.js";

describe("Claude advanced rollout gates", () => {
  test.each(CLAUDE_ADVANCED_FEATURES)("keeps %s behind an independent flag, policy gate, and kill switch", (feature) => {
    const names = claudeAdvancedFeatureEnvironment(feature);
    const outcomes: ClaudeAdvancedRolloutOutcome[] = [];
    const configured: boolean[] = [];
    const create = (env: NodeJS.ProcessEnv) => new ClaudeAdvancedRollout({
      env,
      onConfigured: (candidate, enabled) => { if (candidate === feature) configured.push(enabled); },
      onMetric: (candidate, outcome) => { if (candidate === feature) outcomes.push(outcome); },
    });

    expect(create({}).use(feature)).toBe(false);
    expect(outcomes.pop()).toBe("flagDisabled");
    expect(create({ [names.flag]: "1" }).use(feature)).toBe(false);
    expect(outcomes.pop()).toBe("policyDenied");
    expect(create({ [names.flag]: "1", [names.policy]: "1", [names.killSwitch]: "1" }).use(feature)).toBe(false);
    expect(outcomes.pop()).toBe("killed");
    expect(create({ [names.flag]: "1", [names.policy]: "1" }).use(feature, false)).toBe(false);
    expect(outcomes.pop()).toBe("capabilityMissing");
    expect(create({ [names.flag]: "1", [names.policy]: "1" }).use(feature)).toBe(true);
    expect(outcomes.pop()).toBe("used");
    const fallback = create({});
    fallback.fallback(feature);
    expect(outcomes.pop()).toBe("fallbacks");
    expect(configured).toEqual([false, false, false, true, true, false]);
  });

  test("all advanced kill switches restore baseline Claude execution", () => {
    const env: NodeJS.ProcessEnv = {};
    for (const feature of CLAUDE_ADVANCED_FEATURES) {
      const names = claudeAdvancedFeatureEnvironment(feature);
      env[names.flag] = "1";
      env[names.policy] = "1";
      env[names.killSwitch] = "1";
    }
    const outcomes: Array<[string, ClaudeAdvancedRolloutOutcome]> = [];
    const rollout = new ClaudeAdvancedRollout({
      env,
      onMetric: (feature, outcome) => outcomes.push([feature, outcome]),
    });

    for (const feature of CLAUDE_ADVANCED_FEATURES) {
      expect(rollout.enabled(feature)).toBe(false);
      expect(rollout.use(feature)).toBe(false);
    }
    expect(outcomes).toEqual(CLAUDE_ADVANCED_FEATURES.map((feature) => [feature, "killed"]));
  });
});
