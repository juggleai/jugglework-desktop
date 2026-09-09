import assert from "node:assert/strict";
import test from "node:test";

import { CANARY_SCHEMA, EXPECTED_BUNDLE_ID, EXPECTED_TEAM_ID, LOCAL_VERIFICATION_SCHEMA, createEvidence, withEvidenceResults } from "./evidence.mjs";
import { publicUrl } from "./constants.mjs";
import { metadataForBuffer } from "./metadata.mjs";
import { preflightImmutable, promoteChannel, recoverPromotionLock, uploadVersion, verifyCdn } from "./workflow.mjs";

function object(key, content, type = "artifact") {
  return {
    key, url: publicUrl(key), name: key.split("/").at(-1), path: `/dist/${key.split("/").at(-1)}`, type,
    content: type === "manifest" ? content : undefined, ...metadataForBuffer(content, key),
  };
}

function fixturePlan() {
  const root = "jugglework/releases/v1.2.15/mac/arm64";
  const objects = [
    object(`${root}/jugglework-mac-arm64-1.2.15.zip`, "zip"),
    object(`${root}/jugglework-mac-arm64-1.2.15.dmg`, "dmg"),
    object(`${root}/jugglework-mac-arm64-1.2.15.zip.blockmap`, "zip-blockmap"),
    object(`${root}/jugglework-mac-arm64-1.2.15.dmg.blockmap`, "dmg-blockmap"),
  ];
  const manifest = object("jugglework/releases/v1.2.15/mac/latest-mac.yml", "version: 1.2.15\n", "manifest");
  return {
    version: "1.2.15", channel: "stable", platform: "mac", architectures: ["arm64"], objects, manifest,
    channelManifest: { key: "jugglework/releases/stable/mac/latest-mac.yml", url: publicUrl("jugglework/releases/stable/mac/latest-mac.yml") },
  };
}

function createFakeQiniu(initial = new Map()) {
  const state = new Map(initial);
  const calls = [];
  return {
    state, calls,
    async stat(key) { calls.push(["stat", key]); return state.get(key) ?? null; },
    async uploadFile(key, localPath, mime, options) {
      calls.push(["uploadFile", key, localPath, mime, options]);
      const source = fixturePlan().objects.find((item) => item.key === key);
      state.set(key, { size: source.size, etag: source.etag });
    },
    async uploadContent(key, content, mime, options) {
      calls.push(["uploadContent", key, content, mime, options]);
      state.set(key, metadataForBuffer(content, key));
    },
    async delete(key) { calls.push(["delete", key]); state.delete(key); },
  };
}

function verifiedEvidence(plan) {
  const localVerification = {
    schema: LOCAL_VERIFICATION_SCHEMA, schemaVersion: 1, producer: "verify-packaged-macos", version: plan.version, platform: "mac",
    architectures: plan.architectures, verifiedAt: "2026-09-08T00:00:00.000Z", releaseState: "release",
    credentialState: "available",
    identity: { bundleIdentifier: EXPECTED_BUNDLE_ID, teamIdentifier: EXPECTED_TEAM_ID },
    codesign: { status: "accepted", deep: true, strict: true }, hardenedRuntime: { status: "enabled" },
    notarization: { status: "accepted", submissionId: "notary-id" }, staple: { status: "validated" }, gatekeeper: { status: "accepted" },
    artifacts: plan.objects.map((item) => ({ name: item.name, size: item.size, sha256: item.sha256, sha512: item.sha512, etag: item.etag })),
    manifest: { name: "latest-mac.yml", size: plan.manifest.size, sha256: plan.manifest.sha256, sha512: plan.manifest.sha512, etag: plan.manifest.etag },
  };
  const canary = {
    schema: CANARY_SCHEMA, schemaVersion: 1, producer: "jugglework-macos-update-canary", result: "passed", channel: plan.channel,
    sourceVersion: "1.2.14", targetVersion: plan.version, feedUrl: plan.manifest.url, runId: "canary-run", verifiedAt: "2026-09-08T01:00:00.000Z",
    architectures: plan.architectures, manifestSha256: plan.manifest.sha256,
    checks: { cleanClient: "passed", updateDiscovered: "passed", download: "passed", install: "passed", restart: "passed", installedVersion: plan.version, userData: "preserved", workspaceAccess: "preserved", permissions: "preserved" },
    network: { manifestOrigin: "https://downloads.jugglechat.cn", artifactOrigin: "https://downloads.jugglechat.cn" },
  };
  const qiniuChecks = [...plan.objects, plan.manifest].map((item) => ({ key: item.key, size: item.size, etag: item.etag, verified: true }));
  const cdnChecks = [...plan.objects, plan.manifest].map((item) => ({ key: item.key, url: item.url, https: true, mime: item.mime, contentLength: item.size, range: true, size: item.size, sha256: item.sha256, sha512: item.sha512 }));
  return withEvidenceResults(createEvidence({ plan, commit: "abc123", localVerification, canary, timestamps: { createdAt: "2026-09-08T00:00:00.000Z" } }), {
    workflow: {
      immutable: { status: "verified", qiniuChecks, verifiedAt: "2026-09-08T02:00:00.000Z" },
      cdn: { status: "verified", qiniuChecks, cdnChecks, verifiedAt: "2026-09-08T03:00:00.000Z" },
    },
  }, "2026-09-08T03:00:00.000Z");
}

test("immutable preflight distinguishes absent, matching resume, and mismatch", async () => {
  const target = fixturePlan().objects[0];
  assert.equal((await preflightImmutable([target], { qiniu: createFakeQiniu(), resume: false }))[0].action, "upload");
  const matching = createFakeQiniu(new Map([[target.key, { size: target.size, etag: target.etag }]]));
  assert.equal((await preflightImmutable([target], { qiniu: matching, resume: true }))[0].action, "skip-matching");
  await assert.rejects(preflightImmutable([target], { qiniu: matching, resume: false }), /already exists/);
  const mismatch = createFakeQiniu(new Map([[target.key, { size: target.size + 1, etag: target.etag }]]));
  await assert.rejects(preflightImmutable([target], { qiniu: mismatch, resume: true }), /mismatch/);
});

test("CDN verification binds each digest result to its immutable object key", async () => {
  const plan = fixturePlan();
  const initial = new Map([...plan.objects, plan.manifest].map((item) => [item.key, { size: item.size, etag: item.etag }]));
  const result = await verifyCdn(plan, {
    qiniu: createFakeQiniu(initial),
    verifyObject: async (object) => ({ url: object.url, sha256: object.sha256 }),
  });
  assert.deepEqual(
    result.cdnChecks.map((check) => ({ key: check.key, url: check.url })),
    [...plan.objects, plan.manifest].map((item) => ({ key: item.key, url: item.url })),
  );
});

test("partial resume skips exact objects and uploads manifest after all binaries", async () => {
  const plan = fixturePlan();
  const existing = plan.objects[0];
  const qiniu = createFakeQiniu(new Map([[existing.key, { size: existing.size, etag: existing.etag }]]));
  const events = [];
  await uploadVersion(plan, { qiniu, resume: true, onEvent: (event) => events.push(event) });
  assert.equal(qiniu.calls.some((call) => call[0] === "uploadFile" && call[1] === existing.key), false);
  assert.equal(events.at(-1).type, "upload-manifest");
  assert.deepEqual(qiniu.calls.find((call) => call[0] === "uploadContent")[4], { overwrite: false });
});

test("resume is exact-only and never overwrites a mismatched partial upload", async () => {
  const plan = fixturePlan();
  const corrupt = plan.objects[2];
  const qiniu = createFakeQiniu(new Map([[corrupt.key, { size: corrupt.size, etag: "wrong" }]]));
  await assert.rejects(uploadVersion(plan, { qiniu, resume: true }), /mismatch/);
  assert.equal(qiniu.calls.some((call) => call[0].startsWith("upload")), false);
});

test("lock contention fails before channel mutation", async () => {
  const plan = fixturePlan();
  const lockKey = "jugglework/releases/locks/stable-mac.lock";
  const qiniu = createFakeQiniu(new Map([[lockKey, { size: 10, etag: "held", putTime: "123" }]]));
  await assert.rejects(promoteChannel(plan, verifiedEvidence(plan), { qiniu, refresh: async () => {}, readBack: async () => ({}) }), /Promotion lock is held.*putTime=123/);
  assert.equal(qiniu.calls.some((call) => call[0] === "uploadContent"), false);
});

test("lock recovery re-stats ownership before delete and emits durable audit events", async () => {
  const lockKey = "jugglework/releases/locks/stable-mac.lock";
  const lock = { size: 10, etag: "held", putTime: "123" };
  const qiniu = createFakeQiniu(new Map([[lockKey, lock]]));
  const audit = [];
  await recoverPromotionLock({ channel: "stable", qiniu, reason: "CI publisher was confirmed terminated", actor: "operator", onAudit: async (event) => audit.push(event) });
  assert.deepEqual(audit.map((event) => event.status), ["authorized", "completed"]);
  assert.equal(qiniu.state.has(lockKey), false);

  const raced = createFakeQiniu(new Map([[lockKey, lock]]));
  let observations = 0;
  const originalStat = raced.stat;
  raced.stat = async (key) => {
    const value = await originalStat.call(raced, key);
    observations += 1;
    return observations === 2 ? { ...value, etag: "replacement" } : value;
  };
  await assert.rejects(recoverPromotionLock({ channel: "stable", qiniu: raced, reason: "CI publisher was confirmed terminated", onAudit: async () => {} }), /changed after inspection/);
  assert.equal(raced.calls.some((call) => call[0] === "delete"), false);
});

test("lock recovery dry-run does not delete or emit a completed audit", async () => {
  const lockKey = "jugglework/releases/locks/stable-mac.lock";
  const qiniu = createFakeQiniu(new Map([[lockKey, { size: 10, etag: "held", putTime: "123" }]]));
  const events = [];
  const result = await recoverPromotionLock({ channel: "stable", qiniu, reason: "CI publisher was confirmed terminated", dryRun: true, onAudit: async (event) => events.push(event) });
  assert.equal(result.observedPutTime, "123");
  assert.equal(qiniu.state.has(lockKey), true);
  assert.deepEqual(events, []);
});

test("missing machine verification or canary makes no Qiniu calls", async () => {
  const plan = fixturePlan();
  for (const mutate of [(e) => { e.localVerification = null; }, (e) => { e.canary.result = "failed"; }]) {
    const evidence = verifiedEvidence(plan);
    mutate(evidence);
    const qiniu = createFakeQiniu();
    await assert.rejects(promoteChannel(plan, evidence, { qiniu, refresh: async () => {}, readBack: async () => ({}) }), /verification|canary/i);
    assert.deepEqual(qiniu.calls, []);
  }
});

test("promotion order is lock, verification, overwrite, refresh, read-back, unlock", async () => {
  const plan = fixturePlan();
  const initial = new Map([...plan.objects, plan.manifest].map((item) => [item.key, { size: item.size, etag: item.etag }]));
  const qiniu = createFakeQiniu(initial);
  const events = [];
  const readBackCalls = [];
  await promoteChannel(plan, verifiedEvidence(plan), {
    qiniu, refresh: async () => {}, readBack: async (...args) => { readBackCalls.push(args); return { converged: true }; }, onEvent: (event) => events.push(event.type),
  });
  assert.deepEqual(events, ["lock-acquire", "channel-upload", "cdn-refresh", "channel-readback", "lock-release"]);
  assert.equal(readBackCalls[0][2].expectedSize, plan.manifest.size);
  assert.deepEqual(qiniu.calls.find((call) => call[0] === "uploadContent" && call[1] === plan.channelManifest.key)[4], { overwrite: true });
  assert.equal(qiniu.state.has("jugglework/releases/locks/stable-mac.lock"), false);
});

test("records the narrowly scoped notarization exception in promotion output", async () => {
  const plan = fixturePlan();
  const evidence = verifiedEvidence(plan);
  evidence.localVerification.releaseState = "candidate";
  evidence.localVerification.credentialState = "missing";
  evidence.localVerification.notarization = { status: "unavailable" };
  evidence.localVerification.staple = { status: "unavailable" };
  evidence.localVerification.gatekeeper = { status: "unavailable" };
  const initial = new Map([...plan.objects, plan.manifest].map((item) => [item.key, { size: item.size, etag: item.etag }]));
  const reason = "Operator explicitly authorized one-time unnotarized stable 1.2.15 publication";
  const result = await promoteChannel(plan, evidence, {
    qiniu: createFakeQiniu(initial),
    refresh: async () => {},
    readBack: async () => ({ sha256: plan.manifest.sha256, size: plan.manifest.size }),
    notarizationExceptionReason: reason,
  });
  assert.deepEqual(result.notarizationException, { scope: "stable-1.2.15-only", reason });
});

test("failed CDN refresh or read-back fails promotion and retains the lock", async () => {
  const plan = fixturePlan();
  const initial = new Map([...plan.objects, plan.manifest].map((item) => [item.key, { size: item.size, etag: item.etag }]));
  for (const dependencies of [{ refresh: async () => { throw new Error("refresh failed"); }, readBack: async () => ({}) }, { refresh: async () => {}, readBack: async () => { throw new Error("read-back failed"); } }]) {
    const qiniu = createFakeQiniu(new Map(initial));
    await assert.rejects(promoteChannel(plan, verifiedEvidence(plan), { qiniu, ...dependencies }), /failed/);
    assert.equal(qiniu.state.has("jugglework/releases/locks/stable-mac.lock"), true);
  }
});

test("promotion fails clearly when cache refresh is unavailable", async () => {
  const plan = fixturePlan();
  const qiniu = createFakeQiniu();
  await assert.rejects(promoteChannel(plan, verifiedEvidence(plan), { qiniu, readBack: async () => ({}) }), /refresh operation is unavailable/);
  assert.deepEqual(qiniu.calls, []);
});

test("dry runs cause no Qiniu, refresh, or read-back mutation", async () => {
  const plan = fixturePlan();
  const qiniu = createFakeQiniu();
  let externalCalls = 0;
  const refresh = async () => { externalCalls += 1; };
  const readBack = async () => { externalCalls += 1; };
  assert.equal((await uploadVersion(plan, { qiniu, dryRun: true })).dryRun, true);
  assert.equal((await promoteChannel(plan, verifiedEvidence(plan), { qiniu, refresh, readBack, dryRun: true })).dryRun, true);
  assert.deepEqual(qiniu.calls, []);
  assert.equal(externalCalls, 0);
});
