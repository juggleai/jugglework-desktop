import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CloudProfileStore } from "../src/cloud-profiles.js";

test("profile store isolates deployments and selected organizations", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-cloud-profiles-"));
  const path = join(root, "nested", "profiles.json");
  try {
    const store = new CloudProfileStore(path);
    await store.set("https://one.example", { token: "token-one" });
    await store.set("https://two.example", { token: "token-two", organizationId: "org_two" });
    await store.selectOrganization("https://one.example", "org_one");
    assert.deepEqual(await store.get("https://one.example"), { token: "token-one", organizationId: "org_one" });
    assert.deepEqual(await store.get("https://two.example"), { token: "token-two", organizationId: "org_two" });
    if (process.platform !== "win32") {
      assert.equal((await stat(join(root, "nested"))).mode & 0o777, 0o700);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    assert.deepEqual((await readdir(join(root, "nested"))).sort(), ["profiles.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile store recovers from malformed files on the next atomic write", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-cloud-malformed-"));
  const path = join(root, "profiles.json");
  try {
    await writeFile(path, "{malformed", { mode: 0o600 });
    const store = new CloudProfileStore(path);
    assert.equal(await store.get("https://cloud.example"), null);
    await store.set("https://cloud.example", { token: "replacement-token" });
    assert.equal(JSON.parse(await readFile(path, "utf8")).profiles["https://cloud.example"].token, "replacement-token");
    assert.deepEqual(await readdir(root), ["profiles.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
