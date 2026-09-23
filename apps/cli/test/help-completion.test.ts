import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "../src/args.js";
import { commandHelp, completionScript } from "../src/help.js";

test("hierarchical help snapshots expose only implemented command contexts", () => {
  assert.equal(commandHelp(["org"]), `jugglework - Manage the selected Cloud organization.\n\nUsage:\n  jugglework org <command>\n\nCommands:\n  list  List account organizations\n  use   Select an organization by exact ID or slug\n`);
  assert.equal(commandHelp(["doctor"]), `jugglework - Run redacted diagnostics without starting an embedded runtime.\n\nUsage:\n  jugglework doctor [--json] [--server <url> --token <token>]\n`);
  assert.match(commandHelp(), /doctor\s+Run redacted installation/);
  assert.match(commandHelp(), /session\s+Manage the persisted session lifecycle/);
  assert.match(commandHelp(["session"]), /delete\s+Permanently delete a session/);
  assert.match(commandHelp(["session", "delete"]), /--force/);
  assert.match(commandHelp(), /workspace\s+List, add, or activate/);
  assert.match(commandHelp(), /dangerously-bypass-approvals-and-sandbox/);
  assert.doesNotMatch(commandHelp(), /extension enable/);
  assert.deepEqual(parseCliArgs(["org", "--help"]).helpTopic, ["org"]);
  assert.deepEqual(parseCliArgs(["org", "use", "--help"]).helpTopic, ["org", "use"]);
});

test("completion generation supports bash, zsh, fish, and PowerShell", () => {
  for (const shell of ["bash", "zsh", "fish", "powershell"] as const) {
    const script = completionScript(shell);
    assert.match(script, /jugglework/);
    assert.match(script, /doctor/);
    assert.match(script, /completion/);
    assert.match(script, /workspace/);
    assert.match(script, /session/);
  }
  assert.match(completionScript("bash"), /complete -F _jugglework/);
  assert.match(completionScript("zsh"), /#compdef jugglework/);
  assert.match(completionScript("fish"), /complete -c jugglework/);
  assert.match(completionScript("powershell"), /Register-ArgumentCompleter/);
});

test("meta and diagnostic commands parse deterministically", () => {
  assert.deepEqual(parseCliArgs(["doctor"]).command, { group: "diagnostics", action: "doctor" });
  assert.deepEqual(parseCliArgs(["completion", "fish"]).command, { group: "meta", action: "completion", shell: "fish" });
  assert.throws(() => parseCliArgs(["completion", "unknown"]), /completion requires one of/);
  assert.throws(() => parseCliArgs(["doctor", "extra"]), /does not accept positional/);
});
