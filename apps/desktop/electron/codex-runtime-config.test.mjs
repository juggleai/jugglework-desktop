import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { CODEX_LOCAL_SECRET_ENV, writeCodexRuntimeConfig } from "./codex-runtime-config.mjs";

describe("Codex runtime config", () => {
  it("creates a private isolated profile without persisting either credential", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "jugglework-codex-config-"));
    const result = await writeCodexRuntimeConfig({
      userDataPath,
      organizationId: "org_1",
      workspaceId: "../../workspace_1",
      brokerBaseUrl: "http://127.0.0.1:45123/random/v1",
      localSecret: "local-secret-value",
      model: "gpt-5.6-terra",
      workspaceRoot: userDataPath,
    });
    const config = await readFile(path.join(result.codexHome, "config.toml"), "utf8");
    assert.equal(path.dirname(path.dirname(result.codexHome)), path.join(userDataPath, "codex"));
    assert.equal(result.env.CODEX_HOME, result.codexHome);
    assert.equal(result.env.HOME, result.codexHome);
    assert.equal(result.env.USERPROFILE, result.codexHome);
    assert.equal(result.env[CODEX_LOCAL_SECRET_ENV], "local-secret-value");
    assert.match(config, /wire_api = "responses"/);
    assert.match(config, /JUGGLEWORK_CODEX_LOCAL_SECRET/);
    assert.doesNotMatch(config, /local-secret-value|remote-token/);
    assert.equal((await stat(path.join(result.codexHome, "config.toml"))).mode & 0o777, 0o600);
    await Promise.all(["sessions", "logs"].map((name) => stat(path.join(result.codexHome, name))));
    await stat(path.join(result.codexHome, ".agents", "skills"));
  });

  it("uses distinct stable homes for different organizations and workspaces", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "jugglework-codex-profiles-"));
    const base = { userDataPath, workspaceRoot: userDataPath, brokerBaseUrl: "http://127.0.0.1:1/n/v1", localSecret: "secret", model: "model" };
    const first = await writeCodexRuntimeConfig({ ...base, organizationId: "org_1", workspaceId: "ws_1" });
    const same = await writeCodexRuntimeConfig({ ...base, organizationId: "org_1", workspaceId: "ws_1" });
    const other = await writeCodexRuntimeConfig({ ...base, organizationId: "org_2", workspaceId: "ws_1" });
    assert.equal(first.codexHome, same.codexHome);
    assert.notEqual(first.codexHome, other.codexHome);
  });
});
