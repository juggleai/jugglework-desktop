import { automationSqliteAdapter } from "./automation/sqlite.js";
import { openRuntimeSqliteDatabase, runtimeDbPath } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";

export type PluginWorkspacePolicy = {
  workspaceId: string;
  disabledPluginSpecs: string[];
  controllablePluginSpecs: string[];
  revision: number;
  updatedAt: number | null;
  enforcementReady: boolean;
};

function normalizeSpecs(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((spec) => typeof spec !== "string" || !spec.trim())) {
    throw new TypeError("disabledPluginSpecs must contain nonempty strings");
  }
  return [...new Set(value as string[])].sort((a, b) => a.localeCompare(b));
}

async function withDatabase<T>(config: ServerConfig, run: (db: ReturnType<typeof automationSqliteAdapter>) => T): Promise<T> {
  const db = automationSqliteAdapter(await openRuntimeSqliteDatabase(runtimeDbPath(config)));
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS workspace_plugin_policies (
      workspace_id TEXT PRIMARY KEY NOT NULL,
      disabled_plugin_specs_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    return run(db);
  } finally {
    db.close();
  }
}

type Row = { specs: string; revision: number; updatedAt: number };

// Keep persisted policy data, but shared runtime config cannot enforce workspace isolation.
export async function readPluginWorkspacePolicy(config: ServerConfig, workspaceId: string): Promise<PluginWorkspacePolicy> {
  return withDatabase(config, (db) => {
    const row = db.get<Row>(
      "SELECT disabled_plugin_specs_json AS specs, revision, updated_at AS updatedAt FROM workspace_plugin_policies WHERE workspace_id = ?",
      [workspaceId],
    );
    return {
      workspaceId,
      disabledPluginSpecs: row ? normalizeSpecs(JSON.parse(row.specs)) : [],
      revision: row?.revision ?? 0,
      updatedAt: row?.updatedAt ?? null,
      controllablePluginSpecs: [],
      enforcementReady: false,
    };
  });
}

export async function writePluginWorkspacePolicy(config: ServerConfig, workspaceId: string, value: unknown): Promise<PluginWorkspacePolicy> {
  const specs = normalizeSpecs(value);
  const now = Date.now();
  return withDatabase(config, (db) => {
    db.run(`INSERT INTO workspace_plugin_policies (workspace_id, disabled_plugin_specs_json, revision, updated_at)
      VALUES (?, ?, 1, ?) ON CONFLICT(workspace_id) DO UPDATE SET
      disabled_plugin_specs_json = excluded.disabled_plugin_specs_json,
      revision = workspace_plugin_policies.revision + 1,
      updated_at = excluded.updated_at`, [workspaceId, JSON.stringify(specs), now]);
    const row = db.get<Row>(
      "SELECT disabled_plugin_specs_json AS specs, revision, updated_at AS updatedAt FROM workspace_plugin_policies WHERE workspace_id = ?",
      [workspaceId],
    );
    return { workspaceId, disabledPluginSpecs: specs, controllablePluginSpecs: [], revision: row?.revision ?? 1, updatedAt: row?.updatedAt ?? now, enforcementReady: false };
  });
}
