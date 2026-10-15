import { describe, expect, test } from "bun:test";
import { connectorReadiness } from "../src/react-app/domains/connections/connector-readiness";

describe("connector installation versus readiness", () => {
  const oauth = { type: "remote" as const, url: "https://example.com/mcp" };
  const token = { ...oauth, oauth: false as const, headers: { Authorization: "Bearer {env:GITHUB_TOKEN}" } };
  test("missing state never claims connected or enabled", () => {
    expect(connectorReadiness(oauth).state).toBe("pending");
    expect(connectorReadiness(oauth).canAuthorize).toBe(false);
  });
  test("disabled config wins over stale connected runtime", () => {
    expect(connectorReadiness({ ...oauth, enabled: false }, { status: "connected" }).state).toBe("disabled");
  });
  test("only OAuth authentication offers browser sign-in", () => {
    expect(connectorReadiness(oauth, { status: "needs_auth" }).canAuthorize).toBe(true);
    expect(connectorReadiness(token, { status: "needs_auth" }).canAuthorize).toBe(false);
    expect(connectorReadiness({ ...oauth, headers: { Authorization: "Bearer sentinel" } }, { status: "needs_auth" }).canAuthorize).toBe(false);
  });
  test("does not echo provider errors or credentials and does not diagnose token failure without evidence", () => {
    const result = connectorReadiness(token, { status: "failed", error: "private-provider-payload" });
    expect(result.state).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("private-provider-payload");
    expect(result.hint).toBeNull();
    expect(connectorReadiness(token, { status: "connected" }).hint).toBeNull();
  });
  test("registration is not a ready connection", () => {
    expect(connectorReadiness(oauth, { status: "needs_client_registration", error: "private" }).canAuthorize).toBe(false);
  });
});
