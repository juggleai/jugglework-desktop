import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudProfileStore, cloudProfilePath } from "../src/cloud-profiles.js";
import { cloudWelcomeLabel, hasCloudLogin } from "../src/welcome.js";

test("interactive welcome distinguishes saved Cloud login from unverified account status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jugglework-welcome-"));
  const configPath = join(directory, "cli.json");
  const options = { configPath, cloudUrl: null, cloudToken: null, cloudOrg: null };
  try {
    assert.equal(await hasCloudLogin(options), false);
    assert.equal(await cloudWelcomeLabel(options), "not signed in · run jugglework login");
    await new CloudProfileStore(cloudProfilePath(configPath)).set("https://work.jugglechat.cn", {
      token: "saved-secret",
      organizationId: "org_saved",
      user: { id: "user_1", email: "user@example.test" },
    });
    assert.equal(await hasCloudLogin(options), true);
    assert.equal(await cloudWelcomeLabel(options), "saved login: user@example.test · org org_saved");
    assert.equal(await cloudWelcomeLabel({ ...options, cloudOrg: "org_override" }), "saved login: user@example.test · org org_override");
    assert.equal(await cloudWelcomeLabel({ ...options, cloudToken: "environment-secret" }), "environment token · no org selected");
    assert.equal(await hasCloudLogin({ ...options, cloudToken: "environment-secret" }), true);
    assert.equal(await cloudWelcomeLabel({ ...options, cloudUrl: "http://not-allowed.test" }), "status unavailable · run jugglework doctor");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
