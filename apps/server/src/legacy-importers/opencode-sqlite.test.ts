import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import {
  createLegacyOpencodeSqliteImporter,
  resolveLegacyOpencodeDbPath,
  type LegacySqliteOpen,
} from "./opencode-sqlite.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const openBunSqlite: LegacySqliteOpen = (path, options) => {
  const db = new Database(path, options);
  return {
    exec: (sql) => db.exec(sql),
    get: <T>(sql: string, values = []) => db.query(sql).get(...values) as T | undefined,
    run: (sql, values = []) => {
      db.query(sql).run(...values);
    },
    transaction: (operation) => db.transaction(operation).immediate(),
    close: () => db.close(),
  };
};

async function createDb(schema: "legacy" | "migrated" = "legacy"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jugglework-legacy-opencode-"));
  temporaryDirectories.push(dir);
  const dbPath = join(dir, "opencode-test.db");
  const db = new Database(dbPath);
  db.exec(`
    create table session (
      id text primary key,
      time_updated integer${schema === "migrated" ? ",\n      project_id text not null default 'global',\n      time_archived integer" : ""}
    );
    create table message (
      id text primary key,
      session_id text not null,
      time_created integer,
      time_updated integer,
      data text not null${schema === "migrated" ? ",\n      time_compacting integer" : ""},
      foreign key (session_id) references session(id) on delete cascade
    );
    create table part (
      id text primary key,
      message_id text not null,
      session_id text not null,
      time_created integer,
      time_updated integer,
      data text not null${schema === "migrated" ? ",\n      time_deleted integer,\n      metadata text not null default '{}'" : ""},
      foreign key (message_id) references message(id) on delete cascade,
      foreign key (session_id) references session(id) on delete cascade
    );
    ${schema === "migrated" ? "create index message_session_time_idx on message(session_id, time_created);" : ""}
    insert into session (id, time_updated) values ('ses_test123', 1);
  `);
  db.close();
  return dbPath;
}

function importer() {
  return createLegacyOpencodeSqliteImporter({ openDatabase: openBunSqlite });
}

describe("legacy OpenCode SQLite importer", () => {
  test.each(["legacy", "migrated"] as const)("imports seeded messages with the %s schema", async (schema) => {
    const dbPath = await createDb(schema);
    const result = importer().importMessages({
      dbPath,
      sessionId: "ses_test123",
      workspaceRoot: "/tmp/workspace",
      now: 1700000000000,
      messages: [
        { role: "assistant", text: "Welcome" },
        { role: "user", text: "Help me start" },
        { role: "assistant", text: "Sure" },
      ],
    });

    expect(result).toEqual({ inserted: 3, skipped: false });

    const db = new Database(dbPath, { readonly: true });
    const rows = db.query("select id, session_id, data from message order by time_created asc").all() as Array<{
      id: string;
      session_id: string;
      data: string;
    }>;
    const parts = db.query("select data from part order by time_created asc").all() as Array<{ data: string }>;
    const session = db.query("select time_updated from session where id = 'ses_test123'").get() as { time_updated: number };
    db.close();

    const decoded = rows.map((row) => JSON.parse(row.data) as Record<string, unknown>);
    expect(decoded[0]?.role).toBe("assistant");
    expect(decoded[0]?.parentID).toBe(rows[0]?.id);
    expect(decoded[0]?.modelID).toBe("gpt-5.4");
    expect(decoded[0]?.providerID).toBe("openai");
    expect(decoded[1]?.role).toBe("user");
    expect(decoded[1]?.summary).toEqual({ diffs: [] });
    expect(decoded[2]?.role).toBe("assistant");
    expect(decoded[2]?.parentID).toBe(rows[1]?.id);
    expect(parts.map((row) => JSON.parse(row.data))).toEqual([
      { type: "text", text: "Welcome" },
      { type: "text", text: "Help me start" },
      { type: "text", text: "Sure" },
    ]);
    expect(session.time_updated).toBe(1700000000003);
  });

  test("does not import a seeded session twice", async () => {
    const dbPath = await createDb();
    const legacyImporter = importer();
    const first = legacyImporter.importMessages({
      dbPath,
      sessionId: "ses_test123",
      workspaceRoot: "/tmp/workspace",
      messages: [{ role: "assistant", text: "Welcome" }],
    });
    const second = legacyImporter.importMessages({
      dbPath,
      sessionId: "ses_test123",
      workspaceRoot: "/tmp/workspace",
      messages: [{ role: "assistant", text: "Welcome again" }],
    });

    expect(first.skipped).toBe(false);
    expect(second).toEqual({ inserted: 0, skipped: true });
  });

  test("skips an empty transcript without opening a database", () => {
    let opened = false;
    const legacyImporter = createLegacyOpencodeSqliteImporter({
      openDatabase: () => {
        opened = true;
        throw new Error("unexpected database open");
      },
    });

    expect(
      legacyImporter.importMessages({
        sessionId: "ses_test123",
        workspaceRoot: "/tmp/workspace",
        messages: [{ role: "user", text: "  " }],
      }),
    ).toEqual({ inserted: 0, skipped: true });
    expect(opened).toBe(false);
  });
});

describe("resolveLegacyOpencodeDbPath", () => {
  test("prefers an existing XDG opencode.db when present", async () => {
    const xdg = await mkdtemp(join(tmpdir(), "jugglework-opencode-xdg-"));
    temporaryDirectories.push(xdg);
    const dir = join(xdg, "opencode");
    const file = join(dir, "opencode.db");
    await mkdir(dir, { recursive: true });
    await writeFile(file, "", "utf8");

    const previousXdg = process.env.XDG_DATA_HOME;
    const previousChannel = process.env.OPENCODE_CHANNEL;
    const previousDb = process.env.OPENCODE_DB;
    try {
      process.env.XDG_DATA_HOME = xdg;
      process.env.OPENCODE_CHANNEL = "local";
      delete process.env.OPENCODE_DB;

      expect(resolveLegacyOpencodeDbPath()).toBe(file);
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdg;
      if (previousChannel === undefined) delete process.env.OPENCODE_CHANNEL;
      else process.env.OPENCODE_CHANNEL = previousChannel;
      if (previousDb === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = previousDb;
    }
  });

  test.each([
    ["JuggleWork-managed", "jugglework-dev-data/xdg/data/opencode"],
    ["legacy", "opencode-dev/ws-test/xdg/data/opencode"],
  ])("finds %s OpenCode databases under JUGGLEWORK_DATA_DIR", async (_label, relativeDir) => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-data-"));
    temporaryDirectories.push(root);
    const dir = join(root, relativeDir);
    const file = join(dir, "opencode.db");
    await mkdir(dir, { recursive: true });
    await writeFile(file, "", "utf8");

    const previousDataDir = process.env.JUGGLEWORK_DATA_DIR;
    const previousXdg = process.env.XDG_DATA_HOME;
    const previousChannel = process.env.OPENCODE_CHANNEL;
    const previousDb = process.env.OPENCODE_DB;
    try {
      process.env.JUGGLEWORK_DATA_DIR = root;
      delete process.env.XDG_DATA_HOME;
      process.env.OPENCODE_CHANNEL = "local";
      delete process.env.OPENCODE_DB;

      expect(resolveLegacyOpencodeDbPath()).toBe(file);
    } finally {
      if (previousDataDir === undefined) delete process.env.JUGGLEWORK_DATA_DIR;
      else process.env.JUGGLEWORK_DATA_DIR = previousDataDir;
      if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdg;
      if (previousChannel === undefined) delete process.env.OPENCODE_CHANNEL;
      else process.env.OPENCODE_CHANNEL = previousChannel;
      if (previousDb === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = previousDb;
    }
  });
});
