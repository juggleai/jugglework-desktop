import { eq } from "drizzle-orm";
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

export async function writeJuggleWorkWorkspaceConfig(
  config: ServerConfig,
  workspaceId: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const db = await workspaceConfigDb(config);
  const next = normalizeJuggleWorkWorkspaceConfig(updater(await readJuggleWorkWorkspaceConfig(config, workspaceId)));
  db.upsert({ workspaceId, configJson: JSON.stringify(next), updatedAt: Date.now() });
  return next;
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
