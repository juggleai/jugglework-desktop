import assert from "node:assert/strict";
import test from "node:test";
import { searchSlashCommands } from "../src/cli.js";

const expected = [
  "model", "org", "permissions", "status", "plan", "new", "sessions", "resume", "fork",
  "workspace", "connect", "mcp", "skills", "extensions", "compact", "copy", "doctor", "logout", "exit",
];

test("slash palette stays compact, complete, and searchable", () => {
  assert.deepEqual(searchSlashCommands().map((item) => item.name), expected);
  assert.deepEqual(searchSlashCommands("permission").map((item) => item.name), ["permissions"]);
  assert.deepEqual(searchSlashCommands("Cloud").map((item) => item.name), ["org", "logout"]);
  assert.deepEqual(searchSlashCommands("not-a-command"), []);
});
