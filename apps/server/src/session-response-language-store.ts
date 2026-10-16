import type { ResponseLanguage } from "@jugglework/types/response-language";

import type { AutomationSqlite } from "./automation/sqlite.js";
import { automationSqliteAdapter } from "./automation/sqlite.js";
import { openRuntimeSqliteDatabase, runtimeDbPath } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";

type ResponseLanguageRow = {
  response_language: ResponseLanguage;
  updated_at: number;
};

export type SessionResponseLanguageMutation = {
  workspaceId: string;
  sessionId: string;
  previous: ResponseLanguage | null;
  language: ResponseLanguage;
  revision: number;
};

function migrate(database: AutomationSqlite): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_response_languages (
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      response_language TEXT NOT NULL CHECK (response_language IN ('en','zh')),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, session_id)
    );
  `);
}

/** Durable language selected only from genuine user submissions. */
export class SessionResponseLanguageStore {
  private constructor(private readonly database: AutomationSqlite) {}

  static async open(config: ServerConfig): Promise<SessionResponseLanguageStore> {
    const runtime = await openRuntimeSqliteDatabase(runtimeDbPath(config));
    return SessionResponseLanguageStore.fromDatabase(automationSqliteAdapter(runtime));
  }

  static fromDatabase(database: AutomationSqlite): SessionResponseLanguageStore {
    migrate(database);
    return new SessionResponseLanguageStore(database);
  }

  close(): void {
    this.database.close();
  }

  read(workspaceId: string, sessionId: string): ResponseLanguage | null {
    return this.database.get<ResponseLanguageRow>(
      `SELECT response_language FROM session_response_languages WHERE workspace_id = ? AND session_id = ?`,
      [workspaceId, sessionId],
    )?.response_language ?? null;
  }

  resolve(input: {
    workspaceId: string;
    sessionId: string;
    detected?: ResponseLanguage;
    fallback: ResponseLanguage;
  }): ResponseLanguage {
    return input.detected ?? this.read(input.workspaceId, input.sessionId) ?? input.fallback;
  }

  resolveAndWrite(input: {
    workspaceId: string;
    sessionId: string;
    detected?: ResponseLanguage;
    fallback: ResponseLanguage;
    now?: number;
  }): ResponseLanguage {
    return this.apply(input).language;
  }

  apply(input: {
    workspaceId: string;
    sessionId: string;
    detected?: ResponseLanguage;
    fallback: ResponseLanguage;
    now?: number;
  }): SessionResponseLanguageMutation {
    return this.database.transaction(() => {
      const previousRow = this.database.get<ResponseLanguageRow>(
        `SELECT response_language, updated_at FROM session_response_languages WHERE workspace_id = ? AND session_id = ?`,
        [input.workspaceId, input.sessionId],
      );
      const language = input.detected ?? previousRow?.response_language ?? input.fallback;
      const revision = Math.max(input.now ?? Date.now(), (previousRow?.updated_at ?? 0) + 1);
      this.database.run(
        `INSERT INTO session_response_languages (workspace_id, session_id, response_language, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, session_id) DO UPDATE SET
           response_language = excluded.response_language,
           updated_at = excluded.updated_at`,
        [input.workspaceId, input.sessionId, language, revision],
      );
      return {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        previous: previousRow?.response_language ?? null,
        language,
        revision,
      };
    });
  }

  rollback(mutation: SessionResponseLanguageMutation): void {
    if (mutation.previous === null) {
      this.database.run(
        `DELETE FROM session_response_languages
         WHERE workspace_id = ? AND session_id = ? AND updated_at = ?`,
        [mutation.workspaceId, mutation.sessionId, mutation.revision],
      );
      return;
    }
    this.database.run(
      `UPDATE session_response_languages
       SET response_language = ?, updated_at = ?
       WHERE workspace_id = ? AND session_id = ? AND updated_at = ?`,
      [mutation.previous, mutation.revision + 1, mutation.workspaceId, mutation.sessionId, mutation.revision],
    );
  }

  delete(workspaceId: string, sessionId: string): void {
    this.database.run(
      `DELETE FROM session_response_languages WHERE workspace_id = ? AND session_id = ?`,
      [workspaceId, sessionId],
    );
  }

  copy(workspaceId: string, sourceSessionId: string, targetSessionId: string, now = Date.now()): void {
    const language = this.read(workspaceId, sourceSessionId);
    if (!language) return;
    this.resolveAndWrite({ workspaceId, sessionId: targetSessionId, detected: language, fallback: language, now });
  }
}
