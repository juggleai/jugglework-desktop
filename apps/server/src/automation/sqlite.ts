import type { RuntimeSqliteDatabase } from "../runtime-db.js";

export type AutomationSqlValue = string | number | bigint | Uint8Array | null;

export type AutomationSqlRunResult = {
  changes: number;
  lastInsertRowid?: number | bigint;
};

/** 自动化仓储使用的最小 SQLite 能力，统一 Bun 与 Node 驱动差异。 */
export interface AutomationSqlite {
  exec(sql: string): void;
  run(sql: string, values?: AutomationSqlValue[]): AutomationSqlRunResult;
  get<T>(sql: string, values?: AutomationSqlValue[]): T | undefined;
  all<T>(sql: string, values?: AutomationSqlValue[]): T[];
  transaction<T>(operation: () => T): T;
  close(): void;
}

/**
 * 将 runtime.sqlite 驱动转换为自动化仓储适配器。
 * @param runtimeDb 已打开的运行时数据库
 */
export function automationSqliteAdapter(runtimeDb: RuntimeSqliteDatabase): AutomationSqlite {
  if (runtimeDb.kind === "bun") {
    const sqlite = runtimeDb.sqlite;
    return {
      exec: (sql) => sqlite.exec(sql),
      run: (sql, values = []) => {
        const result = sqlite.run(sql, values);
        return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
      },
      get: <T>(sql: string, values: AutomationSqlValue[] = []) => sqlite.query(sql).get(...values) as T | undefined,
      all: <T>(sql: string, values: AutomationSqlValue[] = []) => sqlite.query(sql).all(...values) as T[],
      transaction: <T>(operation: () => T) => sqlite.transaction(operation)(),
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
    get: <T>(sql: string, values: AutomationSqlValue[] = []) => sqlite.prepare(sql).get(...values) as T | undefined,
    all: <T>(sql: string, values: AutomationSqlValue[] = []) => sqlite.prepare(sql).all(...values) as T[],
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
