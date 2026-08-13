import type { RuntimeSqlite } from "../runtime-db.js";

type AgentRuntimeMigration = {
  version: number;
  statements: string[];
};

const migrations: AgentRuntimeMigration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        backend_session_id TEXT,
        title TEXT NOT NULL,
        canonical_cwd TEXT NOT NULL,
        status_json TEXT NOT NULL,
        config_snapshot_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_error_json TEXT,
        CHECK (created_at >= 0 AND updated_at >= created_at)
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uk_agent_sessions_backend
        ON agent_sessions(runtime_id, backend_session_id) WHERE backend_session_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_agent_sessions_workspace
        ON agent_sessions(workspace_id, updated_at DESC, id DESC)`,
      `CREATE TRIGGER IF NOT EXISTS trg_agent_sessions_immutable_binding
        BEFORE UPDATE ON agent_sessions
        WHEN OLD.workspace_id IS NOT NEW.workspace_id
          OR OLD.runtime_id IS NOT NEW.runtime_id
          OR OLD.canonical_cwd IS NOT NEW.canonical_cwd
          OR OLD.config_snapshot_json IS NOT NEW.config_snapshot_json
          OR OLD.created_at IS NOT NEW.created_at
        BEGIN
          SELECT RAISE(ABORT, 'agent session binding is immutable');
        END`,
      `CREATE TRIGGER IF NOT EXISTS trg_agent_sessions_backend_once
        BEFORE UPDATE OF backend_session_id ON agent_sessions
        WHEN OLD.backend_session_id IS NOT NULL
          AND OLD.backend_session_id IS NOT NEW.backend_session_id
        BEGIN
          SELECT RAISE(ABORT, 'backend session binding is immutable');
        END`,
      `CREATE TABLE IF NOT EXISTS agent_session_links (
        source_session_id TEXT NOT NULL,
        target_session_id TEXT NOT NULL,
        link_type TEXT NOT NULL,
        context_digest TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (source_session_id, target_session_id, link_type),
        FOREIGN KEY (source_session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (target_session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
        CHECK (source_session_id <> target_session_id),
        CHECK (link_type IN ('fork', 'migration'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_agent_session_links_target
        ON agent_session_links(target_session_id, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        backend_message_id TEXT,
        role TEXT NOT NULL,
        parent_id TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
        CHECK (role IN ('user', 'assistant', 'system'))
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uk_agent_messages_backend
        ON agent_messages(session_id, backend_message_id) WHERE backend_message_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_agent_messages_session
        ON agent_messages(session_id, created_at, id)`,
      `CREATE TABLE IF NOT EXISTS agent_parts (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        backend_part_id TEXT,
        ordinal INTEGER NOT NULL,
        type TEXT NOT NULL,
        state TEXT,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (message_id) REFERENCES agent_messages(id) ON DELETE CASCADE,
        UNIQUE (message_id, ordinal),
        CHECK (ordinal >= 0)
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uk_agent_parts_backend
        ON agent_parts(session_id, backend_part_id) WHERE backend_part_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_agent_parts_message
        ON agent_parts(message_id, ordinal, id)`,
      `CREATE TABLE IF NOT EXISTS agent_events (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, sequence),
        FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
        CHECK (sequence > 0)
      )`,
      `CREATE TABLE IF NOT EXISTS agent_event_sequences (
        session_id TEXT PRIMARY KEY NOT NULL,
        next_sequence INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
        CHECK (next_sequence > 0)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_agent_events_workspace
        ON agent_events(workspace_id, created_at, event_id)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_events_type
        ON agent_events(session_id, type, sequence)`,
      `CREATE TABLE IF NOT EXISTS agent_run_usage (
        run_id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_agent_run_usage_session
        ON agent_run_usage(session_id, created_at, run_id)`,
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS agent_event_snapshot_state (
        session_id TEXT PRIMARY KEY NOT NULL,
        todos_json TEXT NOT NULL DEFAULT '[]',
        interactions_json TEXT NOT NULL DEFAULT '[]',
        latest_sequence INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
        CHECK (latest_sequence >= 0)
      )`,
      `CREATE TABLE IF NOT EXISTS agent_event_receipts (
        event_id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
        CHECK (sequence > 0)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_agent_event_receipts_session
        ON agent_event_receipts(session_id, sequence DESC)`,
    ],
  },
  {
    version: 3,
    statements: [
      `CREATE TABLE IF NOT EXISTS agent_policy_audits (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT,
        interaction_id TEXT,
        runtime_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        decision TEXT NOT NULL,
        request_reason_code TEXT NOT NULL,
        policy_source TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        policy_version TEXT,
        policy_rule_ids_json TEXT NOT NULL,
        policy_reason_codes_json TEXT NOT NULL,
        input_modified INTEGER NOT NULL,
        requested_at INTEGER NOT NULL,
        decided_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        CHECK (actor_type IN ('user', 'remote_user', 'runtime', 'policy', 'system')),
        CHECK (decision IN ('allow', 'deny', 'modify', 'require_approval', 'answer', 'reject', 'timeout', 'cancel')),
        CHECK (policy_source IN ('organization', 'workspace', 'runtime', 'tool', 'interaction', 'default')),
        CHECK (input_modified IN (0, 1)),
        CHECK (requested_at >= 0 AND decided_at >= requested_at AND duration_ms = decided_at - requested_at),
        CHECK (json_valid(policy_rule_ids_json) AND json_type(policy_rule_ids_json) = 'array'),
        CHECK (json_valid(policy_reason_codes_json) AND json_type(policy_reason_codes_json) = 'array')
      )`,
      `CREATE INDEX IF NOT EXISTS idx_agent_policy_audits_workspace
        ON agent_policy_audits(workspace_id, decided_at DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_policy_audits_session
        ON agent_policy_audits(session_id, decided_at DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_policy_audits_interaction
        ON agent_policy_audits(interaction_id, decided_at DESC, id DESC) WHERE interaction_id IS NOT NULL`,
      `CREATE TRIGGER IF NOT EXISTS trg_agent_policy_audits_immutable
        BEFORE UPDATE ON agent_policy_audits
        BEGIN
          SELECT RAISE(ABORT, 'agent policy audit is immutable');
        END`,
    ],
  },
];

export const AGENT_RUNTIME_DATABASE_VERSION = migrations.at(-1)?.version ?? 0;

export function migrateAgentRuntimeDatabase(database: RuntimeSqlite, now = Date.now()): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`CREATE TABLE IF NOT EXISTS agent_runtime_schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(
    database.all<{ version: number }>("SELECT version FROM agent_runtime_schema_migrations").map((row) => Number(row.version)),
  );
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    database.transaction(() => {
      for (const sql of migration.statements) database.exec(sql);
      database.run("INSERT INTO agent_runtime_schema_migrations(version, applied_at) VALUES (?, ?)", [migration.version, now]);
    });
  }
}

export function agentRuntimeDatabaseVersion(database: RuntimeSqlite): number {
  return Number(database.get<{ version: number | null }>(
    "SELECT MAX(version) AS version FROM agent_runtime_schema_migrations",
  )?.version ?? 0);
}
