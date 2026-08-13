import { z } from "zod";
import { openRuntimeSqliteDatabase, runtimeDbPath, runtimeSqliteAdapter, type RuntimeSqlValue, type RuntimeSqlite } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";
import { migrateAgentRuntimeDatabase } from "./migrations.js";
import { AgentRuntimePersistenceError } from "./repository.js";

export const AGENT_POLICY_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const AGENT_POLICY_AUDIT_MAX_RECORDS_PER_WORKSPACE = 100_000;
export const AGENT_POLICY_AUDIT_DEFAULT_INSPECTION_LIMIT = 100;
export const AGENT_POLICY_AUDIT_MAX_INSPECTION_LIMIT = 500;

const auditTokenSchema = z.string().min(1).max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be a redacted identifier or code")
  .refine((value) => !looksLikeCredential(value), "must not contain credential material");
const optionalAuditTokenSchema = auditTokenSchema.nullable().optional().default(null);
const policyCodeListSchema = z.array(auditTokenSchema.max(128)).max(32);

const policyAuditInputSchema = z.object({
  id: auditTokenSchema,
  workspaceId: auditTokenSchema,
  sessionId: auditTokenSchema,
  runId: optionalAuditTokenSchema,
  interactionId: optionalAuditTokenSchema,
  runtimeId: auditTokenSchema,
  toolName: auditTokenSchema,
  actorType: z.enum(["user", "remote_user", "runtime", "policy", "system"]),
  actorId: optionalAuditTokenSchema,
  decision: z.enum(["allow", "deny", "modify", "require_approval", "answer", "reject", "timeout", "cancel"]),
  requestReasonCode: auditTokenSchema.max(128),
  policyBasis: z.object({
    source: z.enum(["organization", "workspace", "runtime", "tool", "interaction", "default"]),
    policyId: auditTokenSchema.max(128),
    policyVersion: optionalAuditTokenSchema,
    ruleIds: policyCodeListSchema,
    reasonCodes: policyCodeListSchema.min(1),
    inputModified: z.boolean(),
  }).strict(),
  requestedAt: z.number().int().nonnegative(),
  decidedAt: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.decidedAt < value.requestedAt) {
    context.addIssue({ code: "custom", path: ["decidedAt"], message: "must not precede requestedAt" });
  }
  if ((value.actorType === "user" || value.actorType === "remote_user") && value.actorId === null) {
    context.addIssue({ code: "custom", path: ["actorId"], message: "is required for a user actor" });
  }
});

export type AgentPolicyAuditInput = z.input<typeof policyAuditInputSchema>;
export type AgentPolicyAuditRecord = Omit<z.output<typeof policyAuditInputSchema>, "policyBasis"> & {
  policyBasis: z.output<typeof policyAuditInputSchema>["policyBasis"];
  durationMs: number;
};

export type AgentPolicyAuditInspectionQuery = {
  workspaceId: string;
  sessionId?: string;
  interactionId?: string;
  runtimeId?: string;
  toolName?: string;
  decision?: AgentPolicyAuditRecord["decision"];
  beforeDecidedAt?: number;
  limit?: number;
};

export type AgentPolicyAuditInspection = {
  workspaceId: string;
  count: number;
  oldestDecidedAt: number | null;
  newestDecidedAt: number | null;
  decisions: Record<string, number>;
  runtimes: Record<string, number>;
  tools: Record<string, number>;
  policies: Record<string, number>;
  retention: { retentionMs: number; maxRecordsPerWorkspace: number };
};

export type AgentPolicyAuditRetentionResult = {
  expired: number;
  excess: number;
};

type AgentPolicyAuditRepositoryOptions = {
  now?: () => number;
  retentionMs?: number;
  maxRecordsPerWorkspace?: number;
};

type AuditRow = {
  id: string;
  workspace_id: string;
  session_id: string;
  run_id: string | null;
  interaction_id: string | null;
  runtime_id: string;
  tool_name: string;
  actor_type: AgentPolicyAuditRecord["actorType"];
  actor_id: string | null;
  decision: AgentPolicyAuditRecord["decision"];
  request_reason_code: string;
  policy_source: AgentPolicyAuditRecord["policyBasis"]["source"];
  policy_id: string;
  policy_version: string | null;
  policy_rule_ids_json: string;
  policy_reason_codes_json: string;
  input_modified: number;
  requested_at: number;
  decided_at: number;
  duration_ms: number;
};

const AUDIT_SELECT = `id, workspace_id, session_id, run_id, interaction_id, runtime_id, tool_name,
  actor_type, actor_id, decision, request_reason_code, policy_source, policy_id, policy_version,
  policy_rule_ids_json, policy_reason_codes_json, input_modified, requested_at, decided_at, duration_ms`;

export class AgentPolicyAuditRepository {
  readonly #now: () => number;
  readonly #retentionMs: number;
  readonly #maxRecordsPerWorkspace: number;

  private constructor(
    private readonly database: RuntimeSqlite,
    options: AgentPolicyAuditRepositoryOptions,
  ) {
    this.#now = options.now ?? Date.now;
    this.#retentionMs = nonNegativeInteger(options.retentionMs ?? AGENT_POLICY_AUDIT_RETENTION_MS, "retentionMs");
    this.#maxRecordsPerWorkspace = positiveInteger(
      options.maxRecordsPerWorkspace ?? AGENT_POLICY_AUDIT_MAX_RECORDS_PER_WORKSPACE,
      "maxRecordsPerWorkspace",
    );
  }

  static async open(config: ServerConfig, options: AgentPolicyAuditRepositoryOptions = {}): Promise<AgentPolicyAuditRepository> {
    const runtime = await openRuntimeSqliteDatabase(runtimeDbPath(config));
    return AgentPolicyAuditRepository.fromDatabase(runtimeSqliteAdapter(runtime), options);
  }

  static fromDatabase(database: RuntimeSqlite, options: AgentPolicyAuditRepositoryOptions = {}): AgentPolicyAuditRepository {
    migrateAgentRuntimeDatabase(database);
    const repository = new AgentPolicyAuditRepository(database, options);
    repository.purgeExpired();
    return repository;
  }

  close(): void {
    this.database.close();
  }

  record(input: AgentPolicyAuditInput): AgentPolicyAuditRecord {
    const audit = parseAuditInput(input);
    return this.database.transaction(() => {
      const session = this.database.get<{ workspace_id: string; runtime_id: string }>(
        "SELECT workspace_id, runtime_id FROM agent_sessions WHERE id = ?",
        [audit.sessionId],
      );
      if (!session) notFound("audit session does not exist");
      if (session.workspace_id !== audit.workspaceId || session.runtime_id !== audit.runtimeId) {
        bindingConflict("audit ownership does not match its session binding");
      }
      const existing = this.get(audit.workspaceId, audit.id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(audit)) {
          bindingConflict("audit identifier was reused with different content");
        }
        return existing;
      }
      this.database.run(
        `INSERT INTO agent_policy_audits(
          id, workspace_id, session_id, run_id, interaction_id, runtime_id, tool_name, actor_type, actor_id,
          decision, request_reason_code, policy_source, policy_id, policy_version, policy_rule_ids_json,
          policy_reason_codes_json, input_modified, requested_at, decided_at, duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [audit.id, audit.workspaceId, audit.sessionId, audit.runId, audit.interactionId, audit.runtimeId,
          audit.toolName, audit.actorType, audit.actorId, audit.decision, audit.requestReasonCode,
          audit.policyBasis.source, audit.policyBasis.policyId, audit.policyBasis.policyVersion,
          JSON.stringify(audit.policyBasis.ruleIds), JSON.stringify(audit.policyBasis.reasonCodes),
          audit.policyBasis.inputModified ? 1 : 0, audit.requestedAt, audit.decidedAt, audit.durationMs],
      );
      this.purgeWorkspaceExcess(audit.workspaceId);
      return audit;
    });
  }

  get(workspaceId: string, auditId: string): AgentPolicyAuditRecord | null {
    const row = this.database.get<AuditRow>(
      `SELECT ${AUDIT_SELECT} FROM agent_policy_audits WHERE workspace_id = ? AND id = ?`,
      [auditToken(workspaceId), auditToken(auditId)],
    );
    return row ? auditFromRow(row) : null;
  }

  listForInspection(query: AgentPolicyAuditInspectionQuery): AgentPolicyAuditRecord[] {
    const clauses = ["workspace_id = ?"];
    const values: RuntimeSqlValue[] = [auditToken(query.workspaceId)];
    addTokenFilter(clauses, values, "session_id", query.sessionId);
    addTokenFilter(clauses, values, "interaction_id", query.interactionId);
    addTokenFilter(clauses, values, "runtime_id", query.runtimeId);
    addTokenFilter(clauses, values, "tool_name", query.toolName);
    if (query.decision !== undefined) {
      const decision = policyAuditInputSchema.shape.decision.safeParse(query.decision);
      if (!decision.success) invalid("invalid audit decision filter");
      clauses.push("decision = ?");
      values.push(decision.data);
    }
    if (query.beforeDecidedAt !== undefined) {
      clauses.push("decided_at < ?");
      values.push(nonNegativeInteger(query.beforeDecidedAt, "beforeDecidedAt"));
    }
    const limit = inspectionLimit(query.limit ?? AGENT_POLICY_AUDIT_DEFAULT_INSPECTION_LIMIT);
    values.push(limit);
    return this.database.all<AuditRow>(
      `SELECT ${AUDIT_SELECT} FROM agent_policy_audits
       WHERE ${clauses.join(" AND ")} ORDER BY decided_at DESC, id DESC LIMIT ?`,
      values,
    ).map(auditFromRow);
  }

  inspect(workspaceId: string): AgentPolicyAuditInspection {
    const id = auditToken(workspaceId);
    const range = this.database.get<{ count: number; oldest: number | null; newest: number | null }>(
      `SELECT COUNT(*) AS count, MIN(decided_at) AS oldest, MAX(decided_at) AS newest
       FROM agent_policy_audits WHERE workspace_id = ?`,
      [id],
    );
    return {
      workspaceId: id,
      count: Number(range?.count ?? 0),
      oldestDecidedAt: range?.oldest == null ? null : Number(range.oldest),
      newestDecidedAt: range?.newest == null ? null : Number(range.newest),
      decisions: this.counts(id, "decision"),
      runtimes: this.counts(id, "runtime_id"),
      tools: this.counts(id, "tool_name"),
      policies: this.counts(id, "policy_id"),
      retention: { retentionMs: this.#retentionMs, maxRecordsPerWorkspace: this.#maxRecordsPerWorkspace },
    };
  }

  purgeExpired(now = this.#now()): AgentPolicyAuditRetentionResult {
    const cutoff = nonNegativeInteger(now, "now") - this.#retentionMs;
    return this.database.transaction(() => {
      const expired = this.database.run("DELETE FROM agent_policy_audits WHERE decided_at < ?", [cutoff]).changes;
      const workspaces = this.database.all<{ workspace_id: string }>("SELECT DISTINCT workspace_id FROM agent_policy_audits");
      let excess = 0;
      for (const row of workspaces) excess += this.purgeWorkspaceExcess(row.workspace_id);
      return { expired, excess };
    });
  }

  private purgeWorkspaceExcess(workspaceId: string): number {
    return this.database.run(
      `DELETE FROM agent_policy_audits WHERE id IN (
        SELECT id FROM agent_policy_audits WHERE workspace_id = ?
        ORDER BY decided_at DESC, id DESC LIMIT -1 OFFSET ?
      )`,
      [workspaceId, this.#maxRecordsPerWorkspace],
    ).changes;
  }

  private counts(workspaceId: string, column: "decision" | "runtime_id" | "tool_name" | "policy_id"): Record<string, number> {
    const rows = this.database.all<{ value: string; count: number }>(
      `SELECT ${column} AS value, COUNT(*) AS count FROM agent_policy_audits
       WHERE workspace_id = ? GROUP BY ${column} ORDER BY ${column}`,
      [workspaceId],
    );
    return Object.fromEntries(rows.map((row) => [row.value, Number(row.count)]));
  }
}

function parseAuditInput(input: AgentPolicyAuditInput): AgentPolicyAuditRecord {
  const parsed = policyAuditInputSchema.safeParse(input);
  if (!parsed.success) invalid(parsed.error.issues[0]?.message ?? "invalid policy audit");
  return { ...parsed.data, durationMs: parsed.data.decidedAt - parsed.data.requestedAt };
}

function auditFromRow(row: AuditRow): AgentPolicyAuditRecord {
  try {
    return parseAuditInput({
      id: row.id,
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      runId: row.run_id,
      interactionId: row.interaction_id,
      runtimeId: row.runtime_id,
      toolName: row.tool_name,
      actorType: row.actor_type,
      actorId: row.actor_id,
      decision: row.decision,
      requestReasonCode: row.request_reason_code,
      policyBasis: {
        source: row.policy_source,
        policyId: row.policy_id,
        policyVersion: row.policy_version,
        ruleIds: JSON.parse(row.policy_rule_ids_json) as string[],
        reasonCodes: JSON.parse(row.policy_reason_codes_json) as string[],
        inputModified: Number(row.input_modified) === 1,
      },
      requestedAt: Number(row.requested_at),
      decidedAt: Number(row.decided_at),
    });
  } catch (error) {
    if (error instanceof AgentRuntimePersistenceError) {
      throw new AgentRuntimePersistenceError("corrupt_record", "persisted policy audit is invalid");
    }
    throw error;
  }
}

function addTokenFilter(clauses: string[], values: RuntimeSqlValue[], column: string, value: string | undefined): void {
  if (value === undefined) return;
  clauses.push(`${column} = ?`);
  values.push(auditToken(value));
}

function auditToken(value: string): string {
  const parsed = auditTokenSchema.safeParse(value);
  if (!parsed.success) invalid(parsed.error.issues[0]?.message ?? "invalid audit token");
  return parsed.data;
}

function inspectionLimit(value: number): number {
  const limit = positiveInteger(value, "limit");
  if (limit > AGENT_POLICY_AUDIT_MAX_INSPECTION_LIMIT) invalid("inspection limit is too large");
  return limit;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${label} must be a non-negative integer`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  const integer = nonNegativeInteger(value, label);
  if (integer < 1) invalid(`${label} must be positive`);
  return integer;
}

function looksLikeCredential(value: string): boolean {
  return /^(?:sk-(?:ant-)?|AKIA[0-9A-Z]{12,}|Bearer$|eyJ[A-Za-z0-9_-]{10,}\.)/i.test(value)
    || /-----BEGIN(?: RSA| EC| OPENSSH)? PRIVATE KEY-----/i.test(value);
}

function invalid(message: string): never {
  throw new AgentRuntimePersistenceError("invalid_record", message);
}

function notFound(message: string): never {
  throw new AgentRuntimePersistenceError("not_found", message);
}

function bindingConflict(message: string): never {
  throw new AgentRuntimePersistenceError("binding_conflict", message);
}
