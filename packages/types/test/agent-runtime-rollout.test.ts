import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CLAUDE_AGENT_INTERNAL_COHORT_ENV,
  CLAUDE_AGENT_ROLLOUT_STAGE_ENV,
  CLAUDE_AGENT_RUNTIME_FEATURE_FLAG,
  CLAUDE_AGENT_RUNTIME_KILL_SWITCH,
  CLAUDE_AGENT_USER_OPT_IN_ENV,
  resolveClaudeAgentRollout,
} from "../src/agent-runtime/rollout.ts";

const enabled = { [CLAUDE_AGENT_RUNTIME_FEATURE_FLAG]: "1" };

describe("Claude Agent staged rollout", () => {
  test("defaults to OpenCode-only and fails closed outside the internal cohort", () => {
    assert.deepEqual(resolveClaudeAgentRollout({}), {
      enabled: false,
      stage: "internal",
      reason: "feature_disabled",
      internalCohort: false,
      userOptIn: false,
    });
    assert.equal(resolveClaudeAgentRollout(enabled).reason, "cohort_ineligible");
  });

  test("admits internal, explicit opt-in, and GA stages only for their intended audience", () => {
    assert.equal(resolveClaudeAgentRollout({
      ...enabled,
      [CLAUDE_AGENT_ROLLOUT_STAGE_ENV]: "internal",
      [CLAUDE_AGENT_INTERNAL_COHORT_ENV]: "1",
    }).enabled, true);
    assert.equal(resolveClaudeAgentRollout({
      ...enabled,
      [CLAUDE_AGENT_ROLLOUT_STAGE_ENV]: "opt-in",
    }).enabled, false);
    assert.equal(resolveClaudeAgentRollout({
      ...enabled,
      [CLAUDE_AGENT_ROLLOUT_STAGE_ENV]: "opt-in",
      [CLAUDE_AGENT_USER_OPT_IN_ENV]: "yes",
    }).enabled, true);
    assert.equal(resolveClaudeAgentRollout({
      ...enabled,
      [CLAUDE_AGENT_ROLLOUT_STAGE_ENV]: "ga",
    }).enabled, true);
  });

  test("global kill switch and invalid stages fail closed", () => {
    assert.deepEqual(resolveClaudeAgentRollout({
      ...enabled,
      [CLAUDE_AGENT_ROLLOUT_STAGE_ENV]: "ga",
      [CLAUDE_AGENT_RUNTIME_KILL_SWITCH]: "1",
    }), {
      enabled: false,
      stage: "ga",
      reason: "kill_switch",
      internalCohort: false,
      userOptIn: false,
    });
    assert.equal(resolveClaudeAgentRollout({
      ...enabled,
      [CLAUDE_AGENT_ROLLOUT_STAGE_ENV]: "unexpected",
    }).reason, "invalid_stage");
  });
});
