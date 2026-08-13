import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRuntimeSqliteDatabase, runtimeSqliteAdapter } from "../runtime-db.js";
import { AGENT_RUNTIME_DATABASE_VERSION, agentRuntimeDatabaseVersion, migrateAgentRuntimeDatabase } from "./migrations.js";
import {
  AgentPolicyAuditRepository,
  type AgentPolicyAuditInput,
} from "./policy-audit-repository.js";
import { AgentRuntimePersistenceError } from "./repository.js";

const NOW = Date.parse("2026-08-13T00:00:00Z");
const DAY = 24 * 60 * 60 * 1_000;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent policy audit persistence", () => {
  test("migrates a version 1 runtime database without adding private payload columns", async () => {
    const fixture = await database("migration");
    fixture.database.exec(`CREATE TABLE agent_runtime_schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at INTEGER NOT NULL
    )`);
    fixture.database.run("INSERT INTO agent_runtime_schema_migrations(version, applied_at) VALUES (1, ?)", [NOW]);

    migrateAgentRuntimeDatabase(fixture.database, NOW + 1);

    expect(agentRuntimeDatabaseVersion(fixture.database)).toBe(AGENT_RUNTIME_DATABASE_VERSION);
    const columns = fixture.database.all<{ name: string }>("PRAGMA table_info(agent_policy_audits)").map((row) => row.name);
    expect(columns).toContain("policy_reason_codes_json");
    expect(columns.some((column) => /credential|secret|payload|tool_input|tool_output|content/i.test(column))).toBe(false);
    fixture.database.close();
  });

  test("records immutable redacted decisions and exposes bounded workspace inspection", async () => {
    const fixture = await auditFixture("record");
    const first = fixture.audit.record(auditInput());
    const duplicate = fixture.audit.record(auditInput());
    fixture.audit.record(auditInput({
      id: "audit-2",
      interactionId: "interaction-2",
      actorType: "policy",
      actorId: null,
      decision: "deny",
      decidedAt: NOW + 30,
      policyBasis: {
        source: "organization",
        policyId: "org.network-policy",
        policyVersion: "v3",
        ruleIds: ["network.destination.allowlist"],
        reasonCodes: ["network.destination.denied"],
        inputModified: false,
      },
    }));

    expect(first).toEqual(duplicate);
    expect(first.durationMs).toBe(20);
    expect(fixture.audit.get("workspace-1", "audit-1")).toEqual(first);
    expect(fixture.audit.get("workspace-2", "audit-1")).toBeNull();
    expect(fixture.audit.listForInspection({ workspaceId: "workspace-1", decision: "deny", limit: 1 }))
      .toMatchObject([{ id: "audit-2", actorType: "policy", policyBasis: { policyId: "org.network-policy" } }]);
    expect(fixture.audit.inspect("workspace-1")).toMatchObject({
      count: 2,
      decisions: { allow: 1, deny: 1 },
      runtimes: { "claude-agent": 2 },
      tools: { Read: 2 },
      policies: { "org.network-policy": 1, "workspace.file-policy": 1 },
    });
    expect(JSON.stringify(fixture.audit.listForInspection({ workspaceId: "workspace-1" }))).not.toContain("private file content");
    expect(JSON.stringify(fixture.audit.listForInspection({ workspaceId: "workspace-1" }))).not.toContain("sk-ant-private");

    expect(() => fixture.database.run("UPDATE agent_policy_audits SET decision = 'deny' WHERE id = 'audit-1'"))
      .toThrow(/immutable/i);
    expect(() => fixture.audit.record(auditInput({ decision: "deny" }))).toThrow(AgentRuntimePersistenceError);
    fixture.audit.close();
  });

  test("rejects credentials, raw private payloads, invalid timing, and mismatched session ownership", async () => {
    const fixture = await auditFixture("redaction");
    const withRawPayload = {
      ...auditInput(),
      rawPayload: { credential: "sk-ant-private", content: "private file content" },
    } as unknown as AgentPolicyAuditInput;
    expect(() => fixture.audit.record(withRawPayload)).toThrow(AgentRuntimePersistenceError);
    expect(() => fixture.audit.record(auditInput({ actorId: "sk-ant-private" }))).toThrow(AgentRuntimePersistenceError);
    expect(() => fixture.audit.record(auditInput({ decidedAt: NOW - 1 }))).toThrow(AgentRuntimePersistenceError);
    expect(() => fixture.audit.record(auditInput({ runtimeId: "jugglework" }))).toThrow(AgentRuntimePersistenceError);
    fixture.audit.close();
  });

  test("purges expired audits and caps retained records per workspace", async () => {
    let clock = NOW;
    const fixture = await auditFixture("retention", { now: () => clock, retentionMs: 2 * DAY, maxRecordsPerWorkspace: 2 });
    fixture.audit.record(auditInput({ id: "audit-1", requestedAt: NOW, decidedAt: NOW + 1 }));
    fixture.audit.record(auditInput({ id: "audit-2", requestedAt: NOW + 1, decidedAt: NOW + 2 }));
    fixture.audit.record(auditInput({ id: "audit-3", requestedAt: NOW + 2, decidedAt: NOW + 3 }));
    expect(fixture.audit.listForInspection({ workspaceId: "workspace-1" }).map((item) => item.id)).toEqual(["audit-3", "audit-2"]);

    clock = NOW + (3 * DAY);
    expect(fixture.audit.purgeExpired()).toEqual({ expired: 2, excess: 0 });
    expect(fixture.audit.inspect("workspace-1").count).toBe(0);
    fixture.audit.close();
  });
});

async function database(name: string) {
  const root = await mkdtemp(join(tmpdir(), `jugglework-policy-audit-${name}-`));
  roots.push(root);
  const runtime = await openRuntimeSqliteDatabase(join(root, "runtime.sqlite"));
  return { database: runtimeSqliteAdapter(runtime) };
}

async function auditFixture(
  name: string,
  options: { now?: () => number; retentionMs?: number; maxRecordsPerWorkspace?: number } = {},
) {
  const fixture = await database(name);
  migrateAgentRuntimeDatabase(fixture.database);
  fixture.database.run(
    `INSERT INTO agent_sessions(
      id, workspace_id, runtime_id, backend_session_id, title, canonical_cwd, status_json,
      config_snapshot_json, created_at, updated_at, last_error_json
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL)`,
    ["session-1", "workspace-1", "claude-agent", "Audit session", "/private/workspace", "{\"type\":\"idle\"}", "{}", NOW, NOW],
  );
  const audit = AgentPolicyAuditRepository.fromDatabase(fixture.database, options);
  return { ...fixture, audit };
}

function auditInput(overrides: Partial<AgentPolicyAuditInput> = {}): AgentPolicyAuditInput {
  return {
    id: "audit-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    runId: "run-1",
    interactionId: "interaction-1",
    runtimeId: "claude-agent",
    toolName: "Read",
    actorType: "user",
    actorId: "user-1",
    decision: "allow",
    requestReasonCode: "tool.permission.requested",
    policyBasis: {
      source: "workspace",
      policyId: "workspace.file-policy",
      policyVersion: "v1",
      ruleIds: ["filesystem.authorized-root"],
      reasonCodes: ["filesystem.path.allowed"],
      inputModified: true,
    },
    requestedAt: NOW,
    decidedAt: NOW + 20,
    ...overrides,
  };
}
