import { describe, expect, test } from "bun:test";

import { JuggleWorkServerError } from "../src/app/lib/jugglework-server";
import { shouldFallbackToDirectEngineDispose } from "../src/react-app/domains/connections/provider-auth/store";

describe("provider engine reload fence", () => {
  test("does not bypass an active-session reload fence with direct instance disposal", () => {
    expect(shouldFallbackToDirectEngineDispose(new JuggleWorkServerError(
      409,
      "engine_reload_blocked_active_runs",
      "Configuration reload is deferred until all active tasks finish",
    ))).toBe(false);
  });

  test("keeps the direct fallback for engine transport failures", () => {
    expect(shouldFallbackToDirectEngineDispose(new JuggleWorkServerError(
      503,
      "opencode_engine_unreachable",
      "OpenCode engine is not reachable",
    ))).toBe(true);
    expect(shouldFallbackToDirectEngineDispose(new Error("network failed"))).toBe(true);
  });
});
