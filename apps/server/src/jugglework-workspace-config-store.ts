import { eq } from "drizzle-orm";
import { existsSync } from "node:fs";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { openRuntimeSqliteDatabase, runtimeDbPath } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";

const juggleworkWorkspaceConfigs = sqliteTable("jugglework_workspace_configs", {
  workspaceId: text("workspace_id").primaryKey(),
  configJson: text("config_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

type JuggleWorkWorkspaceConfigDb = {
  get: (workspaceId: string) => { configJson: string } | undefined;
  upsert: (value: { workspaceId: string; configJson: string; updatedAt: number }) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeJuggleWorkWorkspaceConfig(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

async function openDb(path: string): Promise<JuggleWorkWorkspaceConfigDb> {
  const runtimeDb = await openRuntimeSqliteDatabase(path);
  if (runtimeDb.kind === "bun") {
    const sqlite = runtimeDb.sqlite;
    sqlite.run("CREATE TABLE IF NOT EXISTS jugglework_workspace_configs (workspace_id TEXT PRIMARY KEY NOT NULL, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const db = runtimeDb.db;
    return {
      get: (workspaceId) => db
        .select()
        .from(juggleworkWorkspaceConfigs)
        .where(eq(juggleworkWorkspaceConfigs.workspaceId, workspaceId))
        .get(),
      upsert: ({ workspaceId, configJson, updatedAt }) => {
        db
          .insert(juggleworkWorkspaceConfigs)
          .values({ workspaceId, configJson, updatedAt })
          .onConflictDoUpdate({
            target: juggleworkWorkspaceConfigs.workspaceId,
            set: { configJson, updatedAt },
          })
          .run();
      },
    };
  }
  const sqlite = runtimeDb.sqlite;
  sqlite.exec("CREATE TABLE IF NOT EXISTS jugglework_workspace_configs (workspace_id TEXT PRIMARY KEY NOT NULL, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  const get = sqlite.prepare("SELECT config_json AS configJson FROM jugglework_workspace_configs WHERE workspace_id = ?");
  const upsert = sqlite.prepare("INSERT INTO jugglework_workspace_configs (workspace_id, config_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at");
  return {
    get: (workspaceId) => {
      const row = get.get(workspaceId);
      if (!isRecord(row) || typeof row.configJson !== "string") return undefined;
      return { configJson: row.configJson };
    },
    upsert: ({ workspaceId, configJson, updatedAt }) => {
      upsert.run(workspaceId, configJson, updatedAt);
    },
  };
}

const dbByPath = new Map<string, Promise<JuggleWorkWorkspaceConfigDb>>();
const writesByWorkspace = new Map<string, Promise<void>>();

async function workspaceConfigDb(config: ServerConfig): Promise<JuggleWorkWorkspaceConfigDb> {
  const path = runtimeDbPath(config);
  const existing = dbByPath.get(path);
  if (existing) return existing;
  const db = openDb(path);
  dbByPath.set(path, db);
  return db;
}

export async function readJuggleWorkWorkspaceConfig(config: ServerConfig, workspaceId: string): Promise<Record<string, unknown>> {
  const db = await workspaceConfigDb(config);
  const row = db.get(workspaceId);
  if (!row) return {};
  try {
    return normalizeJuggleWorkWorkspaceConfig(JSON.parse(row.configJson));
  } catch {
    return {};
  }
}

/** Credential-only reads must not create a database or initialize its schema. */
export async function inspectJuggleWorkWorkspaceConfig(config: ServerConfig, workspaceId: string): Promise<Record<string, unknown>> {
  const path = runtimeDbPath(config);
  if (!existsSync(path)) return {};
  const sql = "SELECT CASE WHEN length(CAST(config_json AS BLOB)) <= 1048576 THEN config_json ELSE NULL END AS configJson FROM jugglework_workspace_configs WHERE workspace_id = ?";
  let sqlite: { close(): void; query?: (sql: string) => { get(...args: unknown[]): unknown }; prepare?: (sql: string) => { get(...args: unknown[]): unknown } } | undefined;
  try {
    if (process.versions.bun) {
      const { Database } = await import("bun:sqlite");
      sqlite = new Database(path, { readonly: true, create: false });
    } else {
      const { DatabaseSync } = await import("node:sqlite");
      sqlite = new DatabaseSync(path, { readOnly: true });
    }
    const row = (sqlite.query ? sqlite.query(sql) : sqlite.prepare!(sql)).get(workspaceId);
    if (!isRecord(row)) return {};
    if (typeof row.configJson !== "string" || row.configJson.length > 1024 * 1024) throw new Error("workspace_config_unavailable");
    const value: unknown = JSON.parse(row.configJson);
    if (!isRecord(value)) throw new Error("workspace_config_unavailable");
    return value;
  } catch (error) {
    if (error instanceof Error && error.message.includes("no such table")) return {};
    throw new Error("workspace_config_unavailable");
  } finally {
    sqlite?.close();
  }
}

export async function writeJuggleWorkWorkspaceConfig(
  config: ServerConfig,
  workspaceId: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const lockKey = `${runtimeDbPath(config)}\0${workspaceId}`;
  const previous = writesByWorkspace.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  writesByWorkspace.set(lockKey, queued);
  await previous;
  try {
    const db = await workspaceConfigDb(config);
    const row = db.get(workspaceId);
    const stored = row ? (() => {
      try { return normalizeJuggleWorkWorkspaceConfig(JSON.parse(row.configJson)); } catch { return {}; }
    })() : {};
    const next = normalizeJuggleWorkWorkspaceConfig(updater(stored));
    db.upsert({ workspaceId, configJson: JSON.stringify(next), updatedAt: Date.now() });
    return next;
  } finally {
    release();
    if (writesByWorkspace.get(lockKey) === queued) writesByWorkspace.delete(lockKey);
  }
}

export async function hasJuggleWorkWorkspaceConfig(
  config: ServerConfig,
  workspaceId: string,
): Promise<boolean> {
  const db = await workspaceConfigDb(config);
  return Boolean(db.get(workspaceId));
}

/**
 * Seed the DB-backed jugglework config for a workspace if no row exists yet.
 * Used at workspace creation and as the migrate-on-read landing spot for
 * legacy `.opencode/jugglework.json` files. No-op when a row is already present,
 * so it never clobbers live provisioning state.
 */
export async function seedJuggleWorkWorkspaceConfigIfEmpty(
  config: ServerConfig,
  workspaceId: string,
  seed: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (await hasJuggleWorkWorkspaceConfig(config, workspaceId)) {
    return readJuggleWorkWorkspaceConfig(config, workspaceId);
  }
  return writeJuggleWorkWorkspaceConfig(config, workspaceId, () => seed);
}

export function mergeJuggleWorkWorkspaceConfigs(
  legacy: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  return { ...legacy, ...stored };
}
