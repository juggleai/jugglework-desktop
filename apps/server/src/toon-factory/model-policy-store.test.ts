import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { automationSqliteAdapter } from "../automation/sqlite.js";
import { ToonModelPolicyStore } from "./model-policy-store.js";
import { ToonWorkspaceRuntimeStore } from "./workspace-runtime-store.js";

const model = { kind: "text" as const, providerID: "anthropic", modelID: "claude" };
const fresh = "2026-01-01T00:00:00.000Z";
const now = Date.parse(fresh);
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}` : JSON.stringify(value);
const snapshot = (revision: number, allowedModels: string[], extra: Record<string, unknown> = {}) => {
  const content = { workspaceId: "ws-1", signedIn: true, policyFresh: true, organizationId: "org-1", userId: "user-1", allowedModels, validatedAt: fresh, ...extra };
  return { ...content, revision, digest: createHash("sha256").update(canonical(content)).digest("hex") };
};

describe("Toon model policy snapshot", () => {
  test("allows signed-out execution and exact organization catalog matches", () => {
    const store = new ToonModelPolicyStore();
    expect(() => store.assertAllowed("ws-1", model, "api", now)).toThrow("not synchronized");
    store.update(snapshot(1, [], { signedIn: false, organizationId: null, userId: null, validatedAt: null }));
    expect(() => store.assertAllowed("ws-1", model, "api", now)).not.toThrow();
    store.update(snapshot(2, ["anthropic/claude"]));
    expect(() => store.assertAllowed("ws-1", model, "api", now)).not.toThrow();
    expect(() => store.assertAllowed("ws-1", { ...model, modelID: "other" }, "api", now)).toThrow("organization model catalog");
  });

  test("applies custom-provider and Zen restrictions while preserving cloud-managed providers", () => {
    const store = new ToonModelPolicyStore();
    store.update(snapshot(1, ["anthropic/claude"], { allowCustomProviders: false, allowZenModel: false }));
    expect(() => store.assertAllowed("ws-1", model, "config", now)).toThrow("custom provider");
    expect(() => store.assertAllowed("ws-1", { kind: "text", providerID: "opencode", modelID: "zen" }, "api", now)).toThrow("Zen policy");
    expect(() => store.assertAllowed("ws-1", { kind: "text", providerID: "lpr_org", modelID: "managed" }, "api", now)).not.toThrow();
  });

  test("fails closed when a signed-in organization snapshot is stale or incomplete", () => {
    const store = new ToonModelPolicyStore();
    store.update(snapshot(1, [], { policyFresh: false, validatedAt: null }));
    let failure: unknown;
    try { store.assertAllowed("ws-1", model, "api", now); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "model_policy_pending", details: { retryable: true } });
    store.update(snapshot(2, []));
    expect(() => store.assertAllowed("ws-1", model, "api", now + 10 * 60 * 1_000 + 1)).toThrow("not fresh");
  });

  test("keeps a newer restrictive workspace policy when an older request arrives late", () => {
    const store = new ToonModelPolicyStore();
    expect(store.update(snapshot(2, ["anthropic/other"])).applied).toBe(true);
    expect(() => store.update(snapshot(1, ["anthropic/claude"]))).toThrow("older than the current");
    expect(() => store.assertAllowed("ws-1", model, "api", now)).toThrow("organization model catalog");
    expect(store.update(snapshot(2, ["anthropic/other"])).applied).toBe(false);
    expect(() => store.update(snapshot(2, ["anthropic/claude"]))).toThrow("different content");
    expect(() => store.assertAllowed("another-workspace", model, "api", now)).toThrow("for this workspace");
  });

  test("rejects a policy whose digest does not match its scoped content", () => {
    const store = new ToonModelPolicyStore();
    expect(() => store.update({ ...snapshot(1, ["anthropic/claude"]), digest: "f".repeat(64) })).toThrow("does not match");
  });

  test("loads the last valid public policy after restart and cleanup retains it", () => {
    const sqlite = new Database(":memory:");
    const runtime = ToonWorkspaceRuntimeStore.fromDatabase(automationSqliteAdapter({ kind: "bun", sqlite, db: null as never, close: () => sqlite.close() }));
    const first = new ToonModelPolicyStore(runtime);
    first.update(snapshot(7, ["anthropic/claude"]));
    const row = sqlite.query("SELECT workspace_scope, revision, digest, payload, updated_at, stale_at FROM toon_workspace_model_policies").get() as Record<string, unknown>;
    expect(row).toMatchObject({ workspace_scope: "ws-1", revision: 7, digest: expect.any(String), payload: expect.any(String), updated_at: expect.any(Number), stale_at: expect.any(Number) });
    expect(String(row.payload)).not.toMatch(/credential|apiKey|token/i);

    runtime.cleanup({ now: now + 60_000, completedJournalGraceMs: 0, unavailableMappingGraceMs: 0, assistantEventGraceMs: 0, retainedAssistantEvents: 0 });
    const restarted = new ToonModelPolicyStore(runtime);
    expect(() => restarted.assertAllowed("ws-1", model, "api", now)).not.toThrow();
    expect(() => restarted.update(snapshot(6, []))).toThrow("older than the current");
    expect(() => restarted.assertAllowed("ws-1", { ...model, modelID: "other" }, "api", now)).toThrow("organization model catalog");
    runtime.close();
  });
});
