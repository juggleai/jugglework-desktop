import type { AutomationSqlite } from "../automation/sqlite.js";

export const TOON_WORKSPACE_RUNTIME_SCHEMA_VERSION = 16;

type Migration = (database: AutomationSqlite) => void;

function backfillRootTurnSessions(database: AutomationSqlite): void {
  const required = ["toon_workspace_conversations", "toon_workspace_assistant_turns"];
  const tables = new Set(database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").map((row) => row.name));
  if (required.some((name) => !tables.has(name))) return;
  database.exec(`INSERT OR IGNORE INTO toon_workspace_turn_sessions(
      workspace_scope, project_id, conversation_id, turn_id, session_id, parent_session_id, state, created_at, updated_at
    )
    SELECT t.workspace_scope, t.project_id, t.conversation_id, t.turn_id, c.session_id, NULL,
      CASE WHEN t.status IN ('running','stopping') THEN 'active' WHEN t.status = 'detached' THEN 'detached' ELSE 'terminal' END,
      t.created_at, t.updated_at
    FROM toon_workspace_assistant_turns t
    JOIN toon_workspace_conversations c
      ON c.workspace_scope=t.workspace_scope AND c.project_id=t.project_id AND c.conversation_id=t.conversation_id`);
}

const migrations: Record<number, Migration> = {
  1(database) {
    database.exec(`CREATE TABLE IF NOT EXISTS toon_workspace_projects (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, normalized_root TEXT NOT NULL,
      schema_version INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, unavailable_since INTEGER,
      PRIMARY KEY(workspace_scope, project_id), UNIQUE(workspace_scope, normalized_root)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_operation_outcomes (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, operation_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL, outcome_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, operation_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_recovery_journals (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, operation_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','committing','committed','terminal')),
      terminal_status TEXT, journal_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, operation_id)
    );`);
  },
  2(database) {
    database.exec(`CREATE TABLE IF NOT EXISTS toon_workspace_conversations (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, session_id TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK(visibility IN ('normal','toon_transient_generation','toon_project_assistant','toon_project_subagent')),
      parent_conversation_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, conversation_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_session_lineage (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, session_id TEXT NOT NULL, parent_session_id TEXT,
      visibility TEXT NOT NULL CHECK(visibility IN ('normal','toon_transient_generation','toon_project_assistant','toon_project_subagent')),
      PRIMARY KEY(workspace_scope, project_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_event_cursors (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, cursor TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY(workspace_scope, project_id, conversation_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_conversation_details (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, title TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0, model_json TEXT NOT NULL, active_turn_id TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY(workspace_scope, project_id, conversation_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_assistant_messages (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
      turn_id TEXT NOT NULL, branch_id TEXT NOT NULL, message_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY(workspace_scope, project_id, conversation_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_assistant_events (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      event_id TEXT NOT NULL, event_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, conversation_id, sequence), UNIQUE(workspace_scope, project_id, conversation_id, event_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_assistant_interactions (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, interaction_id TEXT NOT NULL,
      interaction_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, conversation_id, interaction_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_assistant_turns (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      branch_id TEXT NOT NULL, source_message_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('running','stopping','completed','failed','stopped','detached')),
      remote_may_continue INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, conversation_id, turn_id)
    );`);
  },
  3(database) {
    database.exec(`CREATE TABLE IF NOT EXISTS toon_workspace_write_leases (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, lease_id TEXT NOT NULL, holder TEXT NOT NULL,
      expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(workspace_scope, project_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_canvas_leases (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, canvas_id TEXT NOT NULL, lease_id TEXT NOT NULL,
      holder TEXT NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, canvas_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_tool_calls (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, conversation_id TEXT,
      operation_id TEXT, state TEXT NOT NULL, sanitized_result_json TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY(workspace_scope, project_id, tool_call_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_generation_links (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, generation_id TEXT NOT NULL, runtime_job_id TEXT NOT NULL,
      canvas_id TEXT, node_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(workspace_scope, project_id, generation_id)
    );`);
  },
  4(database) {
    database.exec(`CREATE TABLE IF NOT EXISTS toon_workspace_authorizations (
      authorization_id TEXT PRIMARY KEY NOT NULL,
      principal_id TEXT NOT NULL,
      workspace_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      runtime_job_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_toon_workspace_authorization_scope
      ON toon_workspace_authorizations(workspace_scope, project_id, generation_id, request_hash);`);
  },
  5(database) {
    const columns = new Set(database.all<{ name: string }>("PRAGMA table_info(toon_workspace_projects)").map((column) => column.name));
    if (!columns.has("project_instance_id")) database.exec("ALTER TABLE toon_workspace_projects ADD COLUMN project_instance_id TEXT");
    database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_toon_workspace_project_instance ON toon_workspace_projects(workspace_scope, project_instance_id)");
  },
  6(database) {
    database.exec(`CREATE TABLE IF NOT EXISTS toon_workspace_canvas_leases (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, canvas_id TEXT NOT NULL, lease_id TEXT NOT NULL,
      holder TEXT NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, canvas_id)
    )`);
    const columns = new Set(database.all<{ name: string }>("PRAGMA table_info(toon_workspace_canvas_leases)").map((column) => column.name));
    if (!columns.has("lease_token")) database.exec("ALTER TABLE toon_workspace_canvas_leases ADD COLUMN lease_token TEXT NOT NULL DEFAULT ''");
    if (!columns.has("generation")) database.exec("ALTER TABLE toon_workspace_canvas_leases ADD COLUMN generation INTEGER NOT NULL DEFAULT 0");
  },
  7(database) {
    database.exec(`CREATE TABLE IF NOT EXISTS toon_workspace_authorizations (
      authorization_id TEXT PRIMARY KEY NOT NULL,
      principal_id TEXT NOT NULL,
      workspace_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      request_json TEXT,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      runtime_job_id TEXT,
      created_at INTEGER NOT NULL
    )`);
    const columns = new Set(database.all<{ name: string }>("PRAGMA table_info(toon_workspace_authorizations)").map((column) => column.name));
    if (!columns.has("request_json")) database.exec("ALTER TABLE toon_workspace_authorizations ADD COLUMN request_json TEXT");
  },
  8(database) {
    const table = database.get<{ present: number }>("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='toon_workspace_assistant_turns'");
    if (!table) return;
    database.exec(`ALTER TABLE toon_workspace_assistant_turns RENAME TO toon_workspace_assistant_turns_v7;
      CREATE TABLE toon_workspace_assistant_turns (
        workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        branch_id TEXT NOT NULL, source_message_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('running','stopping','completed','failed','stopped','detached','interrupted')),
        remote_may_continue INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(workspace_scope, project_id, conversation_id, turn_id)
      );
      INSERT INTO toon_workspace_assistant_turns SELECT * FROM toon_workspace_assistant_turns_v7;
      DROP TABLE toon_workspace_assistant_turns_v7;`);
  },
  9(database) {
    const authorizationTable = database.get<{ present: number }>("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='toon_workspace_authorizations'");
    if (authorizationTable) {
      const authorizationColumns = new Set(database.all<{ name: string }>("PRAGMA table_info(toon_workspace_authorizations)").map((column) => column.name));
      if (!authorizationColumns.has("invalidated_at")) database.exec("ALTER TABLE toon_workspace_authorizations ADD COLUMN invalidated_at INTEGER");
    }
    const toolCallTable = database.get<{ present: number }>("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='toon_workspace_tool_calls'");
    if (toolCallTable) {
      const toolCallColumns = new Set(database.all<{ name: string }>("PRAGMA table_info(toon_workspace_tool_calls)").map((column) => column.name));
      if (!toolCallColumns.has("turn_id")) database.exec("ALTER TABLE toon_workspace_tool_calls ADD COLUMN turn_id TEXT");
      if (!toolCallColumns.has("session_id")) database.exec("ALTER TABLE toon_workspace_tool_calls ADD COLUMN session_id TEXT");
    }
  },
  10(database) {
    database.exec(`CREATE TABLE IF NOT EXISTS toon_workspace_turn_sessions (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      session_id TEXT NOT NULL, parent_session_id TEXT, state TEXT NOT NULL CHECK(state IN ('active','terminal','detached')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, conversation_id, turn_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_toon_workspace_turn_session_owner
      ON toon_workspace_turn_sessions(workspace_scope, project_id, session_id, updated_at);`);
    backfillRootTurnSessions(database);
  },
  11(database) {
    const table = database.get<{ present: number }>("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='toon_workspace_tool_calls'");
    if (!table) return;
    const columns = new Set(database.all<{ name: string }>("PRAGMA table_info(toon_workspace_tool_calls)").map((column) => column.name));
    if (!columns.has("execution_state")) database.exec("ALTER TABLE toon_workspace_tool_calls ADD COLUMN execution_state TEXT");
    if (!columns.has("proposal_json")) database.exec("ALTER TABLE toon_workspace_tool_calls ADD COLUMN proposal_json TEXT");
  },
  12(database) {
    const table = database.get<{ present: number }>("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='toon_workspace_turn_sessions'");
    if (!table) return;
    const columns = new Set(database.all<{ name: string }>("PRAGMA table_info(toon_workspace_turn_sessions)").map((column) => column.name));
    if (!columns.has("abort_requested_at")) database.exec("ALTER TABLE toon_workspace_turn_sessions ADD COLUMN abort_requested_at INTEGER");
    if (!columns.has("abort_attempts")) database.exec("ALTER TABLE toon_workspace_turn_sessions ADD COLUMN abort_attempts INTEGER NOT NULL DEFAULT 0");
  },
  13(database) {
    const turns = database.get<{ present: number }>("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='toon_workspace_assistant_turns'");
    if (turns) {
      const columns = new Set(database.all<{ name: string }>("PRAGMA table_info(toon_workspace_assistant_turns)").map((column) => column.name));
      if (!columns.has("stop_started_at")) database.exec("ALTER TABLE toon_workspace_assistant_turns ADD COLUMN stop_started_at INTEGER");
      if (!columns.has("stop_deadline_at")) database.exec("ALTER TABLE toon_workspace_assistant_turns ADD COLUMN stop_deadline_at INTEGER");
      if (!columns.has("stop_quiet_since")) database.exec("ALTER TABLE toon_workspace_assistant_turns ADD COLUMN stop_quiet_since INTEGER");
      if (!columns.has("stop_observation_hash")) database.exec("ALTER TABLE toon_workspace_assistant_turns ADD COLUMN stop_observation_hash TEXT");
      if (!columns.has("stop_stable_polls")) database.exec("ALTER TABLE toon_workspace_assistant_turns ADD COLUMN stop_stable_polls INTEGER NOT NULL DEFAULT 0");
      database.exec("UPDATE toon_workspace_assistant_turns SET stop_started_at=COALESCE(stop_started_at, updated_at), stop_deadline_at=COALESCE(stop_deadline_at, updated_at + 60000) WHERE status='stopping'");
    }
    database.exec(`CREATE TABLE IF NOT EXISTS toon_workspace_pending_assistant_replacements (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      replacement_turn_id TEXT NOT NULL, waiting_for_turn_id TEXT NOT NULL, branch_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL, request_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, conversation_id)
    )`);
  },
  14(database) {
    const tables = new Set(database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").map((row) => row.name));
    if (tables.has("toon_workspace_conversation_details")) {
      const details = new Set(database.all<{ name: string }>("PRAGMA table_info(toon_workspace_conversation_details)").map((column) => column.name));
      if (!details.has("active_branch_id")) database.exec("ALTER TABLE toon_workspace_conversation_details ADD COLUMN active_branch_id TEXT");
      if (!details.has("isolation_required")) database.exec("ALTER TABLE toon_workspace_conversation_details ADD COLUMN isolation_required INTEGER NOT NULL DEFAULT 0");
    }
    if (tables.has("toon_workspace_assistant_turns")) {
      const turns = new Set(database.all<{ name: string }>("PRAGMA table_info(toon_workspace_assistant_turns)").map((column) => column.name));
      if (!turns.has("remote_warning_acknowledged_at")) database.exec("ALTER TABLE toon_workspace_assistant_turns ADD COLUMN remote_warning_acknowledged_at INTEGER");
    }
    database.exec(`CREATE TABLE IF NOT EXISTS toon_workspace_assistant_branches (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      branch_id TEXT NOT NULL, root_session_id TEXT NOT NULL, source_message_id TEXT, replay_context TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, conversation_id, branch_id)
    )`);
  },
  15(database) {
    database.exec(`CREATE TABLE IF NOT EXISTS toon_workspace_model_policies (
      workspace_scope TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL,
      digest TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      stale_at INTEGER NOT NULL
    )`);
  },
  16(database) {
    database.exec(`CREATE TABLE IF NOT EXISTS toon_workspace_conversation_cleanups (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state = 'deleting'), last_error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, conversation_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_conversation_cleanup_sessions (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      session_id TEXT NOT NULL, parent_session_id TEXT, depth INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('root','child')),
      state TEXT NOT NULL CHECK(state IN ('pending','deleted','not_found')),
      abort_attempts INTEGER NOT NULL DEFAULT 0, delete_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, conversation_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_toon_workspace_conversation_cleanup_pending
      ON toon_workspace_conversation_cleanups(workspace_scope, state, updated_at);`);
  },
};

export function migrateToonWorkspaceRuntimeDatabase(database: AutomationSqlite): void {
  database.transaction(() => {
    database.exec(`CREATE TABLE IF NOT EXISTS toon_workspace_schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at INTEGER NOT NULL
    )`);
    const applied = database.get<{ version: number }>(
      "SELECT MAX(version) AS version FROM toon_workspace_schema_migrations",
    )?.version ?? 0;
    if (applied > TOON_WORKSPACE_RUNTIME_SCHEMA_VERSION) {
      throw new Error(`Unsupported Toon workspace runtime schema version: ${applied}`);
    }
    for (let version = applied + 1; version <= TOON_WORKSPACE_RUNTIME_SCHEMA_VERSION; version += 1) {
      migrations[version]!(database);
      database.run("INSERT INTO toon_workspace_schema_migrations(version, applied_at) VALUES (?, ?)", [version, Date.now()]);
    }

    // Idempotent index repair is intentionally outside individual historical
    // steps so databases produced by pre-release builds converge safely.
    database.exec(`CREATE TABLE IF NOT EXISTS toon_workspace_projects (
      workspace_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      normalized_root TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      unavailable_since INTEGER,
      PRIMARY KEY(workspace_scope, project_id),
      UNIQUE(workspace_scope, normalized_root)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_conversations (
      workspace_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK(visibility IN ('normal','toon_transient_generation','toon_project_assistant','toon_project_subagent')),
      parent_conversation_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, conversation_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_session_lineage (
      workspace_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      parent_session_id TEXT,
      visibility TEXT NOT NULL CHECK(visibility IN ('normal','toon_transient_generation','toon_project_assistant','toon_project_subagent')),
      PRIMARY KEY(workspace_scope, project_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_event_cursors (
      workspace_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      cursor TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, conversation_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_operation_outcomes (
      workspace_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      outcome_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, operation_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_write_leases (
      workspace_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      holder TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_canvas_leases (
      workspace_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      holder TEXT NOT NULL,
      lease_token TEXT NOT NULL,
      generation INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, canvas_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_recovery_journals (
      workspace_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared','committing','committed','terminal')),
      terminal_status TEXT,
      journal_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, operation_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_tool_calls (
      workspace_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      conversation_id TEXT,
      turn_id TEXT,
      session_id TEXT,
      operation_id TEXT,
      state TEXT NOT NULL,
      execution_state TEXT,
      proposal_json TEXT,
      sanitized_result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, tool_call_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_generation_links (
      workspace_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      runtime_job_id TEXT NOT NULL,
      canvas_id TEXT,
      node_id TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, generation_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_authorizations (
      authorization_id TEXT PRIMARY KEY NOT NULL,
      principal_id TEXT NOT NULL,
      workspace_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      request_json TEXT,
      invalidated_at INTEGER,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      runtime_job_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_toon_workspace_generation_runtime_job ON toon_workspace_generation_links(runtime_job_id);
    CREATE TABLE IF NOT EXISTS toon_workspace_conversation_details (
      workspace_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      title TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      model_json TEXT NOT NULL,
      active_turn_id TEXT,
      active_branch_id TEXT,
      isolation_required INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, conversation_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_assistant_messages (
      workspace_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      message_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, conversation_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_assistant_events (
      workspace_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      event_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, conversation_id, sequence),
      UNIQUE(workspace_scope, project_id, conversation_id, event_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_assistant_interactions (
      workspace_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      interaction_id TEXT NOT NULL,
      interaction_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, conversation_id, interaction_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_assistant_turns (
      workspace_scope TEXT NOT NULL,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      source_message_id TEXT,
       status TEXT NOT NULL CHECK(status IN ('running','stopping','completed','failed','stopped','detached','interrupted')),
       remote_may_continue INTEGER NOT NULL DEFAULT 0,
       remote_warning_acknowledged_at INTEGER,
      stop_started_at INTEGER,
      stop_deadline_at INTEGER,
      stop_quiet_since INTEGER,
      stop_observation_hash TEXT,
      stop_stable_polls INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, conversation_id, turn_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_pending_assistant_replacements (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      replacement_turn_id TEXT NOT NULL, waiting_for_turn_id TEXT NOT NULL, branch_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL, request_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, conversation_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_assistant_branches (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      branch_id TEXT NOT NULL, root_session_id TEXT NOT NULL, source_message_id TEXT, replay_context TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, conversation_id, branch_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_turn_sessions (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      session_id TEXT NOT NULL, parent_session_id TEXT, state TEXT NOT NULL CHECK(state IN ('active','terminal','detached')),
      abort_requested_at INTEGER, abort_attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, conversation_id, turn_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_model_policies (
      workspace_scope TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL,
      digest TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      stale_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_conversation_cleanups (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state = 'deleting'), last_error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, conversation_id)
    );
    CREATE TABLE IF NOT EXISTS toon_workspace_conversation_cleanup_sessions (
      workspace_scope TEXT NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      session_id TEXT NOT NULL, parent_session_id TEXT, depth INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('root','child')),
      state TEXT NOT NULL CHECK(state IN ('pending','deleted','not_found')),
      abort_attempts INTEGER NOT NULL DEFAULT 0, delete_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_scope, project_id, conversation_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_toon_workspace_projects_root ON toon_workspace_projects(workspace_scope, normalized_root);
    CREATE INDEX IF NOT EXISTS idx_toon_workspace_journals_state ON toon_workspace_recovery_journals(state, updated_at);
    CREATE INDEX IF NOT EXISTS idx_toon_workspace_conversations_visibility ON toon_workspace_conversations(workspace_scope, visibility, project_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_toon_workspace_conversations_session ON toon_workspace_conversations(workspace_scope, session_id);
    CREATE INDEX IF NOT EXISTS idx_toon_workspace_lineage_session ON toon_workspace_session_lineage(workspace_scope, session_id);
    CREATE INDEX IF NOT EXISTS idx_toon_workspace_assistant_events_cursor ON toon_workspace_assistant_events(workspace_scope, project_id, conversation_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_toon_workspace_leases_expiry ON toon_workspace_write_leases(expires_at);
    CREATE INDEX IF NOT EXISTS idx_toon_workspace_authorization_scope ON toon_workspace_authorizations(workspace_scope, project_id, generation_id, request_hash);
    CREATE INDEX IF NOT EXISTS idx_toon_workspace_conversation_cleanup_pending ON toon_workspace_conversation_cleanups(workspace_scope, state, updated_at);`);
    const projectColumns = new Set(database.all<{ name: string }>("PRAGMA table_info(toon_workspace_projects)").map((column) => column.name));
    if (!projectColumns.has("project_instance_id")) database.exec("ALTER TABLE toon_workspace_projects ADD COLUMN project_instance_id TEXT");
    database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_toon_workspace_project_instance ON toon_workspace_projects(workspace_scope, project_instance_id)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_toon_workspace_canvas_leases_expiry ON toon_workspace_canvas_leases(expires_at)");
    const authorizationColumns = new Set(database.all<{ name: string }>("PRAGMA table_info(toon_workspace_authorizations)").map((column) => column.name));
    if (!authorizationColumns.has("request_json")) database.exec("ALTER TABLE toon_workspace_authorizations ADD COLUMN request_json TEXT");
    if (!authorizationColumns.has("invalidated_at")) database.exec("ALTER TABLE toon_workspace_authorizations ADD COLUMN invalidated_at INTEGER");
    const toolCallColumns = new Set(database.all<{ name: string }>("PRAGMA table_info(toon_workspace_tool_calls)").map((column) => column.name));
    if (!toolCallColumns.has("turn_id")) database.exec("ALTER TABLE toon_workspace_tool_calls ADD COLUMN turn_id TEXT");
    if (!toolCallColumns.has("session_id")) database.exec("ALTER TABLE toon_workspace_tool_calls ADD COLUMN session_id TEXT");
    if (!toolCallColumns.has("execution_state")) database.exec("ALTER TABLE toon_workspace_tool_calls ADD COLUMN execution_state TEXT");
    if (!toolCallColumns.has("proposal_json")) database.exec("ALTER TABLE toon_workspace_tool_calls ADD COLUMN proposal_json TEXT");
    const turnSessionColumns = new Set(database.all<{ name: string }>("PRAGMA table_info(toon_workspace_turn_sessions)").map((column) => column.name));
    if (!turnSessionColumns.has("abort_requested_at")) database.exec("ALTER TABLE toon_workspace_turn_sessions ADD COLUMN abort_requested_at INTEGER");
    if (!turnSessionColumns.has("abort_attempts")) database.exec("ALTER TABLE toon_workspace_turn_sessions ADD COLUMN abort_attempts INTEGER NOT NULL DEFAULT 0");
    const assistantTurnColumns = new Set(database.all<{ name: string }>("PRAGMA table_info(toon_workspace_assistant_turns)").map((column) => column.name));
    if (!assistantTurnColumns.has("stop_started_at")) database.exec("ALTER TABLE toon_workspace_assistant_turns ADD COLUMN stop_started_at INTEGER");
    if (!assistantTurnColumns.has("stop_deadline_at")) database.exec("ALTER TABLE toon_workspace_assistant_turns ADD COLUMN stop_deadline_at INTEGER");
    if (!assistantTurnColumns.has("stop_quiet_since")) database.exec("ALTER TABLE toon_workspace_assistant_turns ADD COLUMN stop_quiet_since INTEGER");
    if (!assistantTurnColumns.has("stop_observation_hash")) database.exec("ALTER TABLE toon_workspace_assistant_turns ADD COLUMN stop_observation_hash TEXT");
    if (!assistantTurnColumns.has("stop_stable_polls")) database.exec("ALTER TABLE toon_workspace_assistant_turns ADD COLUMN stop_stable_polls INTEGER NOT NULL DEFAULT 0");
    if (!assistantTurnColumns.has("remote_warning_acknowledged_at")) database.exec("ALTER TABLE toon_workspace_assistant_turns ADD COLUMN remote_warning_acknowledged_at INTEGER");
    const conversationDetailColumns = new Set(database.all<{ name: string }>("PRAGMA table_info(toon_workspace_conversation_details)").map((column) => column.name));
    if (!conversationDetailColumns.has("active_branch_id")) database.exec("ALTER TABLE toon_workspace_conversation_details ADD COLUMN active_branch_id TEXT");
    if (!conversationDetailColumns.has("isolation_required")) database.exec("ALTER TABLE toon_workspace_conversation_details ADD COLUMN isolation_required INTEGER NOT NULL DEFAULT 0");
    database.exec("UPDATE toon_workspace_assistant_turns SET stop_started_at=COALESCE(stop_started_at, updated_at), stop_deadline_at=COALESCE(stop_deadline_at, updated_at + 60000) WHERE status='stopping'");
    database.exec("CREATE INDEX IF NOT EXISTS idx_toon_workspace_turn_session_owner ON toon_workspace_turn_sessions(workspace_scope, project_id, session_id, updated_at)");
    backfillRootTurnSessions(database);
  });
}
