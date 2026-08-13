export type LegacySessionMessage = {
  role: "assistant" | "user";
  text: string;
};

export type LegacySessionImportInput = {
  sessionId: string;
  workspaceRoot: string;
  messages: LegacySessionMessage[];
  dbPath?: string;
  now?: number;
};

export type LegacySessionImportResult = {
  inserted: number;
  skipped: boolean;
};

/** Compatibility boundary for seeding sessions still owned by a legacy runtime. */
export interface LegacySessionImporter {
  importMessages(input: LegacySessionImportInput): LegacySessionImportResult;
}
