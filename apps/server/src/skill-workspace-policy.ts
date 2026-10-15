import { automationSqliteAdapter } from "./automation/sqlite.js";
import { openRuntimeSqliteDatabase, runtimeDbPath } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";

export type SkillWorkspacePolicy = {
  workspaceId: string;
  disabledSkillNames: string[];
  revision: number;
  updatedAt: number | null;
  enforcementReady: boolean;
};

const cache = new Map<string, SkillWorkspacePolicy>();

function normalizeNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !name.trim())) {
    throw new TypeError("disabledSkillNames must contain nonempty strings");
  }
  return [...new Set(value.map((name: string) => name.trim()))].sort((a, b) => a.localeCompare(b));
}

async function withDatabase<T>(config: ServerConfig, run: (db: ReturnType<typeof automationSqliteAdapter>) => T): Promise<T> {
  const runtime = await openRuntimeSqliteDatabase(runtimeDbPath(config));
  const db = automationSqliteAdapter(runtime);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS workspace_skill_policies (
      workspace_id TEXT PRIMARY KEY NOT NULL,
      disabled_skill_names_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    return run(db);
  } finally {
    db.close();
  }
}

type Row = { names: string; revision: number; updatedAt: number };

export async function readSkillWorkspacePolicy(config: ServerConfig, workspaceId: string): Promise<SkillWorkspacePolicy> {
  const key = `${runtimeDbPath(config)}\0${workspaceId}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const policy = await withDatabase(config, (db) => {
    const row = db.get<Row>(
      "SELECT disabled_skill_names_json AS names, revision, updated_at AS updatedAt FROM workspace_skill_policies WHERE workspace_id = ?",
      [workspaceId],
    );
    return {
      workspaceId,
      disabledSkillNames: row ? normalizeNames(JSON.parse(row.names)) : [],
      revision: row?.revision ?? 0,
      updatedAt: row?.updatedAt ?? null,
      enforcementReady: true,
    };
  });
  cache.set(key, policy);
  return policy;
}

export async function writeSkillWorkspacePolicy(
  config: ServerConfig,
  workspaceId: string,
  disabledSkillNames: string[],
): Promise<SkillWorkspacePolicy> {
  const names = normalizeNames(disabledSkillNames);
  const now = Date.now();
  const policy = await withDatabase(config, (db) => {
    db.run(`INSERT INTO workspace_skill_policies (workspace_id, disabled_skill_names_json, revision, updated_at)
      VALUES (?, ?, 1, ?) ON CONFLICT(workspace_id) DO UPDATE SET
      disabled_skill_names_json = excluded.disabled_skill_names_json,
      revision = workspace_skill_policies.revision + 1,
      updated_at = excluded.updated_at`, [workspaceId, JSON.stringify(names), now]);
    const row = db.get<Row>(
      "SELECT disabled_skill_names_json AS names, revision, updated_at AS updatedAt FROM workspace_skill_policies WHERE workspace_id = ?",
      [workspaceId],
    );
    return { workspaceId, disabledSkillNames: names, revision: row?.revision ?? 1, updatedAt: row?.updatedAt ?? now, enforcementReady: true };
  });
  cache.set(`${runtimeDbPath(config)}\0${workspaceId}`, policy);
  return policy;
}

export function resetSkillWorkspacePolicyCacheForTests(): void {
  cache.clear();
}

export function checkSkillWorkspacePolicy(args: unknown, disabledSkillNames: string[]) {
  const name = args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>).name
    : undefined;
  if (typeof name !== "string" || !name.trim()) return { allowed: false, code: "skill_name_required" };
  return disabledSkillNames.includes(name.trim())
    ? { allowed: false, code: "skill_disabled_in_workspace", skillName: name.trim() }
    : { allowed: true, skillName: name.trim() };
}
