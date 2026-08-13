import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Database as BunDatabase } from "bun:sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "./types.js";
import { ensureDir } from "./utils.js";

export type RuntimeBunSqliteDatabase = {
  kind: "bun";
  sqlite: BunDatabase;
  db: BunSQLiteDatabase;
  close: () => void;
};

export type RuntimeNodeSqliteDatabase = {
  kind: "node";
  sqlite: DatabaseSync;
  close: () => void;
};

export type RuntimeSqliteDatabase = RuntimeBunSqliteDatabase | RuntimeNodeSqliteDatabase;

export type RuntimeSqlValue = string | number | bigint | Uint8Array | null;

export type RuntimeSqlRunResult = {
  changes: number;
  lastInsertRowid?: number | bigint;
};

/** Minimal synchronous SQLite surface shared by Bun and Node runtime stores. */
export interface RuntimeSqlite {
  exec(sql: string): void;
  run(sql: string, values?: RuntimeSqlValue[]): RuntimeSqlRunResult;
  get<T>(sql: string, values?: RuntimeSqlValue[]): T | undefined;
  all<T>(sql: string, values?: RuntimeSqlValue[]): T[];
  transaction<T>(operation: () => T): T;
  close(): void;
}

export function runtimeDbPath(config: ServerConfig): string {
  const override = process.env.JUGGLEWORK_RUNTIME_DB?.trim();
  if (override) return resolve(override);
  const configPath = config.configPath?.trim();
  const configDir = configPath ? dirname(configPath) : join(homedir(), ".config", "jugglework");
  return join(configDir, "runtime.sqlite");
}

/** Directory holding runtime state (the SQLite DB and derived files). */
export function runtimeStorageDir(config: ServerConfig): string {
  return dirname(runtimeDbPath(config));
}

export async function openRuntimeSqliteDatabase(path: string): Promise<RuntimeSqliteDatabase> {
  await ensureDir(dirname(path));
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const { drizzle } = await import("drizzle-orm/bun-sqlite");
    const sqlite = new Database(path, { create: true });
    return {
      kind: "bun",
      sqlite,
      db: drizzle(sqlite),
      close: () => sqlite.close(),
    };
  }

  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(path);
  return {
    kind: "node",
    sqlite,
    close: () => sqlite.close(),
  };
}

export function runtimeSqliteAdapter(runtimeDb: RuntimeSqliteDatabase): RuntimeSqlite {
  if (runtimeDb.kind === "bun") {
    const sqlite = runtimeDb.sqlite;
    return {
      exec: (sql) => sqlite.exec(sql),
      run: (sql, values = []) => {
        const result = sqlite.run(sql, values);
        return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
      },
      get: <T>(sql: string, values: RuntimeSqlValue[] = []) => sqlite.query(sql).get(...values) as T | undefined,
      all: <T>(sql: string, values: RuntimeSqlValue[] = []) => sqlite.query(sql).all(...values) as T[],
      transaction: <T>(operation: () => T) => sqlite.transaction(operation).immediate(),
      close: runtimeDb.close,
    };
  }

  const sqlite = runtimeDb.sqlite;
  return {
    exec: (sql) => sqlite.exec(sql),
    run: (sql, values = []) => {
      const result = sqlite.prepare(sql).run(...values);
      return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
    },
    get: <T>(sql: string, values: RuntimeSqlValue[] = []) => sqlite.prepare(sql).get(...values) as T | undefined,
    all: <T>(sql: string, values: RuntimeSqlValue[] = []) => sqlite.prepare(sql).all(...values) as T[],
    transaction: <T>(operation: () => T) => {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    close: runtimeDb.close,
  };
}
