import { describe, expect, test } from "bun:test";
import { juggleworkFeatureContributionSchema } from "@jugglework/types/jugglework-provider";

import { buildJuggleWorkProviderContributions } from "./jugglework-provider-adapters.js";

describe("JuggleWork provider adapters", () => {
  test("normalizes sessions and extensions into semantic contributions", () => {
    const contributions = buildJuggleWorkProviderContributions([]);

    expect(contributions.map((contribution) => contribution.featureId)).toEqual([
      "sessions",
      "extensions",
    ]);
    expect(
      contributions.flatMap((contribution) => contribution.affordances)
        .find((affordance) => affordance.id === "session.read"),
    ).toMatchObject({
      kind: "query",
      effects: { data: "read", ui: "none", external: false },
      executor: { kind: "jugglework" },
    });
    for (const contribution of contributions) {
      expect(juggleworkFeatureContributionSchema.safeParse(contribution).success).toBe(true);
    }
  });

  test("keeps known Connect skills direct and search available for unknown capabilities", () => {
    const contributions = buildJuggleWorkProviderContributions([{
      name: "customer-briefing",
      title: "Customer briefing",
      description: "Prepare a customer briefing from connected sources.",
      capability: "skill:skl_customer_briefing",
    }]);
    const connect = contributions.find((contribution) => contribution.featureId === "connect");

    expect(connect?.guidance).toEqual([{
      ref: "skill:skl_customer_briefing",
      title: "Customer briefing",
      description: "Prepare a customer briefing from connected sources.",
      provider: { id: "jugglework-cloud", kind: "connect" },
      loading: "catalog",
    }]);
    expect(connect?.affordances.map((affordance) => ({
      id: affordance.id,
      executor: affordance.executor,
    }))).toEqual([
      {
        id: "connect.capabilities.search",
        executor: { kind: "tool", tool: "jugglework-cloud_search_capabilities" },
      },
      {
        id: "connect.capability.execute",
        executor: { kind: "tool", tool: "jugglework-cloud_execute_capability" },
      },
    ]);
    expect(
      connect?.affordances.find((affordance) => affordance.id === "connect.capability.execute")
        ?.arguments.map((argument) => argument.name),
    ).toEqual(["name", "schemaDigest", "path", "query", "body"]);
  });

  test("includes only MCP providers observed from the engine", () => {
    const contributions = buildJuggleWorkProviderContributions([], [
      { name: "notion", status: "connected" },
      { name: "jugglework-cloud", status: "connected" },
    ]);

    expect(contributions.map((contribution) => contribution.featureId)).toEqual([
      "sessions",
      "extensions",
      "mcp:notion",
      "connect",
    ]);
    expect(contributions[2]).toMatchObject({
      provider: { id: "notion", kind: "mcp" },
      affordances: [],
    });
    expect(contributions[3]?.affordances.map((affordance) => affordance.id)).toEqual([
      "connect.capabilities.search",
      "connect.capability.execute",
    ]);
  });
});
