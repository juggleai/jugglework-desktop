import assert from "node:assert/strict";
import test from "node:test";
import { buildLoginUrl, isCloudOnlyCommand, parseLoginGrant } from "../src/cloud-command.js";
import { parseCliArgs } from "../src/args.js";

test("Cloud account and read-only inventory commands are Cloud-only", () => {
  for (const argv of [["login"], ["login", "status"], ["logout"], ["org", "list"], ["catalog", "list"], ["provider", "list"], ["model", "list"]]) {
    assert.equal(isCloudOnlyCommand(parseCliArgs(argv).command), true);
  }
  assert.equal(isCloudOnlyCommand(parseCliArgs(["status"]).command), false);
  assert.equal(isCloudOnlyCommand(parseCliArgs(["provider", "import", "pub_1"]).command), false);
  assert.equal(isCloudOnlyCommand(parseCliArgs(["provider", "remove", "pub_1"]).command), false);
});

test("accepts raw grants and CLI handoff links but rejects malformed inputs", () => {
  assert.equal(parseLoginGrant("grant_value_12345"), "grant_value_12345");
  assert.equal(parseLoginGrant("jugglework-cli://den-auth?grant=grant_value_12345"), "grant_value_12345");
  assert.equal(parseLoginGrant("jugglework://den-auth?grant=grant_value_12345"), null);
  assert.equal(parseLoginGrant("https://example.test/?grant=grant_value_12345"), null);
  assert.equal(parseLoginGrant("short"), null);
});

test("login URL requests a CLI-specific browser handoff", () => {
  const url = new URL(buildLoginUrl("https://cloud.example"));
  assert.equal(url.pathname, "/jwork/login");
  assert.equal(url.searchParams.get("desktopScheme"), "jugglework-cli");
});
