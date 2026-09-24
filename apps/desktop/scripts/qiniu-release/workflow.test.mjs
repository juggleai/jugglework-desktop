import assert from "node:assert/strict";
import test from "node:test";

import { CANARY_SCHEMA, EXPECTED_BUNDLE_ID, EXPECTED_TEAM_ID, LOCAL_VERIFICATION_SCHEMA, createEvidence, withEvidenceResults } from "./evidence.mjs";
import { CHANNEL_MANIFEST_CACHE_CONTROL, publicUrl } from "./constants.mjs";
import { metadataForBuffer } from "./metadata.mjs";
import { preflightImmutable, promoteChannel, recoverPromotionLock, uploadVersion, verifyCdn } from "./workflow.mjs";

function object(key, content, type = "artifact") {
  return {
    key, url: publicUrl(key), name: key.split("/").at(-1), path: `/dist/${key.split("/").at(-1)}`, type,
    content: type === "manifest" ? content : undefined, ...metadataForBuffer(content, key),
  };
}

function fixturePlan(version = "1.2.15") {
  const root = `jugglework/releases/v${version}/mac/arm64`;
  const objects = [
    object(`${root}/jugglework-mac-arm64-${version}.zip`, "zip"),
    object(`${root}/jugglework-mac-arm64-${version}.dmg`, "dmg"),
    object(`${root}/jugglework-mac-arm64-${version}.zip.blockmap`, "zip-blockmap"),
    object(`${root}/jugglework-mac-arm64-${version}.dmg.blockmap`, "dmg-blockmap"),
  ];
  const manifest = object(`jugglework/releases/v${version}/mac/latest-mac.yml`, `version: ${version}\n`, "manifest");
  return {
    version, channel: "stable", platform: "mac", architectures: ["arm64"], objects, manifest,
    channelManifest: { key: "jugglework/releases/stable/mac/latest-mac.yml", url: publicUrl("jugglework/releases/stable/mac/latest-mac.yml") },
  };
}

function createFakeQiniu(initial = new Map()) {
  const state = new Map(initial);
  const calls = [];
  let putTime = 1_000;
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
      putTime += 1;
      state.set(key, { ...metadataForBuffer(content, key), putTime: String(putTime) });
    },
    async setCacheControl(key, cacheControl, expected) {
      calls.push(["setCacheControl", key, cacheControl, expected]);
      const existing = state.get(key);
      if (!existing || existing.size !== expected.size || existing.etag !== expected.etag || existing.putTime !== expected.putTime) throw new Error("conditional metadata mismatch");
      const updated = { ...existing, cacheControl };
      state.set(key, updated);
      return updated;
    },
    async readContent(key) {
      calls.push(["readContent", key]);
      return state.get(key)?.content ?? null;
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
    dmg: {
      signature: { status: "accepted", teamIdentifier: EXPECTED_TEAM_ID },
      notarization: { status: "accepted", submissionId: "dmg-notary-id" },
      staple: { status: "validated" },
      gatekeeper: { status: "accepted" },
      image: { status: "verified" },
    },
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

test("Windows immutable upload fails closed on absent local verification before Qiniu calls", async () => {
  const plan = { ...fixturePlan("1.2.18"), platform: "windows", architectures: ["arm64", "x64"] };
  const qiniu = createFakeQiniu();
  await assert.rejects(uploadVersion(plan, { qiniu }), /evidence schema|local verification/i);
  assert.deepEqual(qiniu.calls, []);
});

test("lock recovery is isolated by Windows platform", async () => {
  const lockKey = "jugglework/releases/locks/stable-windows.lock";
  const qiniu = createFakeQiniu(new Map([[lockKey, { size: 10, etag: "held", putTime: "123" }]]));
  const result = await recoverPromotionLock({
    channel: "stable",
    platform: "windows",
    qiniu,
    reason: "Windows publisher was confirmed terminated",
    dryRun: true,
  });
  assert.equal(result.platform, "windows");
  assert.equal(result.lockKey, lockKey);
  assert.equal(qiniu.calls[0][1], lockKey);
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

test("promotion order is lock, verification, overwrite, cache metadata, refresh, read-back, unlock", async () => {
  const plan = fixturePlan();
  const initial = new Map([...plan.objects, plan.manifest].map((item) => [item.key, { size: item.size, etag: item.etag }]));
  const qiniu = createFakeQiniu(initial);
  const events = [];
  const readBackCalls = [];
  const result = await promoteChannel(plan, verifiedEvidence(plan), {
    qiniu, refresh: async () => {}, readBack: async (...args) => { readBackCalls.push(args); return { converged: true }; }, onEvent: (event) => events.push(event.type),
  });
  assert.deepEqual(events, ["lock-acquire", "channel-upload", "channel-cache-control", "cdn-refresh", "channel-readback", "lock-release"]);
  assert.equal(readBackCalls[0][2].expectedSize, plan.manifest.size);
  assert.deepEqual(qiniu.calls.find((call) => call[0] === "uploadContent" && call[1] === plan.channelManifest.key)[4], { overwrite: true });
  assert.deepEqual(qiniu.calls.find((call) => call[0] === "setCacheControl"), [
    "setCacheControl",
    plan.channelManifest.key,
    CHANNEL_MANIFEST_CACHE_CONTROL,
    { size: plan.manifest.size, etag: plan.manifest.etag, putTime: "1002" },
  ]);
  assert.deepEqual(result.cacheControl, {
    key: plan.channelManifest.key,
    value: CHANNEL_MANIFEST_CACHE_CONTROL,
    size: plan.manifest.size,
    etag: plan.manifest.etag,
    verified: true,
  });
  assert.equal(qiniu.state.has("jugglework/releases/locks/stable-mac.lock"), false);
  const lockCall = qiniu.calls.find((call) => call[0] === "uploadContent" && call[1].endsWith(".lock"));
  const lock = JSON.parse(lockCall[2]);
  assert.equal(lock.expectedPreviousChannelDigest, null);
  assert.equal(lock.candidateDigest, plan.manifest.sha256);
});

test("promotion lock records previous digest and refuses channel races before overwrite", async () => {
  const plan = fixturePlan();
  const previous = "version: 1.2.14\n";
  const initial = new Map([
    ...[...plan.objects, plan.manifest].map((item) => [item.key, { size: item.size, etag: item.etag }]),
    [plan.channelManifest.key, { ...metadataForBuffer(previous, plan.channelManifest.key), content: Buffer.from(previous) }],
  ]);
  const qiniu = createFakeQiniu(initial);
  const originalRead = qiniu.readContent;
  let reads = 0;
  qiniu.readContent = async (key) => {
    const value = await originalRead.call(qiniu, key);
    reads += 1;
    return reads === 2 ? Buffer.from("version: raced\n") : value;
  };
  await assert.rejects(promoteChannel(plan, verifiedEvidence(plan), {
    qiniu, refresh: async () => {}, readBack: async () => ({}),
  }), /changed after lock acquisition/);
  assert.equal(qiniu.calls.some((call) => call[0] === "uploadContent" && call[1] === plan.channelManifest.key), false);
  assert.equal(qiniu.state.has("jugglework/releases/locks/stable-mac.lock"), false);
  const lock = JSON.parse(qiniu.calls.find((call) => call[0] === "uploadContent" && call[1].endsWith(".lock"))[2]);
  assert.equal(lock.expectedPreviousChannelDigest, metadataForBuffer(previous, plan.channelManifest.key).sha256);
  assert.equal(lock.candidateDigest, plan.manifest.sha256);
});

test("promotion revalidates lock ownership immediately before channel overwrite", async () => {
  const plan = fixturePlan();
  const initial = new Map([...plan.objects, plan.manifest].map((item) => [item.key, { size: item.size, etag: item.etag }]));
  const qiniu = createFakeQiniu(initial);
  const originalStat = qiniu.stat;
  let lockStats = 0;
  qiniu.stat = async (key) => {
    const value = await originalStat.call(qiniu, key);
    if (key.endsWith(".lock") && value) {
      lockStats += 1;
      if (lockStats === 2) return { ...value, etag: "stolen" };
    }
    return value;
  };
  await assert.rejects(promoteChannel(plan, verifiedEvidence(plan), {
    qiniu, refresh: async () => {}, readBack: async () => ({}),
  }), /ownership changed before channel overwrite/);
  assert.equal(qiniu.calls.some((call) => call[0] === "uploadContent" && call[1] === plan.channelManifest.key), false);
  assert.equal(qiniu.state.has("jugglework/releases/locks/stable-mac.lock"), true);
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
  assert.equal(result.preCanaryException, null);
});

test("records both stable 1.2.16 pre-canary candidate exceptions", async () => {
  const plan = fixturePlan("1.2.16");
  const evidence = verifiedEvidence(plan);
  evidence.localVerification.releaseState = "candidate";
  evidence.localVerification.credentialState = "missing";
  evidence.localVerification.notarization = { status: "unavailable" };
  evidence.localVerification.staple = { status: "unavailable" };
  evidence.localVerification.gatekeeper = { status: "unavailable" };
  evidence.canary = null;
  const initial = new Map([...plan.objects, plan.manifest].map((item) => [item.key, { size: item.size, etag: item.etag }]));
  const notarizationReason = "Operator authorized unnotarized stable 1.2.16 for the live upgrade validation";
  const preCanaryReason = "Operator authorized exposing stable 1.2.16 before validating the live 1.2.15 upgrade";
  const result = await promoteChannel(plan, evidence, {
    qiniu: createFakeQiniu(initial),
    refresh: async () => {},
    readBack: async () => ({ sha256: plan.manifest.sha256, size: plan.manifest.size }),
    notarizationExceptionReason: notarizationReason,
    preCanaryExceptionReason: preCanaryReason,
  });
  assert.deepEqual(result.notarizationException, { scope: "stable-1.2.16-only", reason: notarizationReason });
  assert.deepEqual(result.preCanaryException, { scope: "stable-1.2.16-only", reason: preCanaryReason });
});

test("records both stable 1.2.18 macOS exceptions with the corrected scope", async () => {
  const plan = fixturePlan("1.2.18");
  const evidence = verifiedEvidence(plan);
  evidence.localVerification.releaseState = "candidate";
  evidence.localVerification.credentialState = "missing";
  evidence.localVerification.notarization = { status: "unavailable" };
  evidence.localVerification.staple = { status: "unavailable" };
  evidence.localVerification.gatekeeper = { status: "unavailable" };
  evidence.canary = null;
  const initial = new Map([...plan.objects, plan.manifest].map((item) => [item.key, { size: item.size, etag: item.etag }]));
  const notarizationReason = "Operator authorized unnotarized stable 1.2.18 after correcting the release version";
  const preCanaryReason = "Operator authorized stable 1.2.18 promotion without a local macOS canary for this release only";
  const result = await promoteChannel(plan, evidence, {
    qiniu: createFakeQiniu(initial),
    refresh: async () => {},
    readBack: async () => ({ sha256: plan.manifest.sha256, size: plan.manifest.size }),
    notarizationExceptionReason: notarizationReason,
    preCanaryExceptionReason: preCanaryReason,
  });
  assert.deepEqual(result.notarizationException, { scope: "stable-1.2.18-only", reason: notarizationReason });
  assert.deepEqual(result.preCanaryException, { scope: "stable-1.2.18-only", reason: preCanaryReason });
});

test("records both stable 1.2.19 macOS exceptions with exact release scope", async () => {
  const plan = fixturePlan("1.2.19");
  const evidence = verifiedEvidence(plan);
  evidence.localVerification.releaseState = "candidate";
  evidence.localVerification.credentialState = "missing";
  evidence.localVerification.notarization = { status: "unavailable" };
  evidence.localVerification.staple = { status: "unavailable" };
  evidence.localVerification.gatekeeper = { status: "unavailable" };
  evidence.canary = null;
  const initial = new Map([...plan.objects, plan.manifest].map((item) => [item.key, { size: item.size, etag: item.etag }]));
  const notarizationReason = "Operator authorized stable macOS 1.2.19 without production notarization for this release only";
  const preCanaryReason = "Operator authorized stable macOS 1.2.19 without a local installation canary for this release only";
  const result = await promoteChannel(plan, evidence, {
    qiniu: createFakeQiniu(initial),
    refresh: async () => {},
    readBack: async () => ({ sha256: plan.manifest.sha256, size: plan.manifest.size }),
    notarizationExceptionReason: notarizationReason,
    preCanaryExceptionReason: preCanaryReason,
  });
  assert.deepEqual(result.notarizationException, { scope: "stable-1.2.19-only", reason: notarizationReason });
  assert.deepEqual(result.preCanaryException, { scope: "stable-1.2.19-only", reason: preCanaryReason });
});

test("records both stable 1.2.20 recovery exceptions with exact release scope", async () => {
  const plan = fixturePlan("1.2.20");
  const evidence = verifiedEvidence(plan);
  evidence.localVerification.releaseState = "candidate";
  evidence.localVerification.credentialState = "missing";
  evidence.localVerification.notarization = { status: "unavailable" };
  evidence.localVerification.staple = { status: "unavailable" };
  evidence.localVerification.gatekeeper = { status: "unavailable" };
  evidence.canary = null;
  const initial = new Map([...plan.objects, plan.manifest].map((item) => [item.key, { size: item.size, etag: item.etag }]));
  const notarizationReason = "Operator authorized stable macOS arm64 1.2.20 without Apple notarization for recovery only";
  const preCanaryReason = "Operator authorized stable macOS arm64 1.2.20 without a local installation canary for recovery only";
  const result = await promoteChannel(plan, evidence, {
    qiniu: createFakeQiniu(initial),
    refresh: async () => {},
    readBack: async () => ({ sha256: plan.manifest.sha256, size: plan.manifest.size }),
    notarizationExceptionReason: notarizationReason,
    preCanaryExceptionReason: preCanaryReason,
  });
  assert.deepEqual(result.notarizationException, { scope: "stable-1.2.20-only", reason: notarizationReason });
  assert.deepEqual(result.preCanaryException, { scope: "stable-1.2.20-only", reason: preCanaryReason });
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

test("failed channel Cache-Control mutation stops before CDN refresh and retains the lock", async () => {
  const plan = fixturePlan();
  const initial = new Map([...plan.objects, plan.manifest].map((item) => [item.key, { size: item.size, etag: item.etag }]));
  const qiniu = createFakeQiniu(initial);
  qiniu.setCacheControl = async (...args) => {
    qiniu.calls.push(["setCacheControl", ...args]);
    throw new Error("metadata verification failed");
  };
  let externalCalls = 0;
  await assert.rejects(promoteChannel(plan, verifiedEvidence(plan), {
    qiniu,
    refresh: async () => { externalCalls += 1; },
    readBack: async () => { externalCalls += 1; },
  }), /metadata verification failed/);
  assert.equal(externalCalls, 0);
  assert.equal(qiniu.state.has("jugglework/releases/locks/stable-mac.lock"), true);
});

test("failed durable promotion evidence after read-back retains the lock", async () => {
  const plan = fixturePlan();
  const initial = new Map([...plan.objects, plan.manifest].map((item) => [item.key, { size: item.size, etag: item.etag }]));
  const qiniu = createFakeQiniu(initial);
  await assert.rejects(promoteChannel(plan, verifiedEvidence(plan), {
    qiniu,
    refresh: async () => {},
    readBack: async () => ({ converged: true, sha256: plan.manifest.sha256, size: plan.manifest.size, checkedAt: "2026-09-08T03:30:00.000Z" }),
    onPromotionVerified: async () => { throw new Error("evidence persistence failed"); },
  }), /evidence persistence failed/);
  assert.equal(qiniu.state.has("jugglework/releases/locks/stable-mac.lock"), true);
});

test("indeterminate channel upload failure retains the lock", async () => {
  const plan = fixturePlan();
  const initial = new Map([...plan.objects, plan.manifest].map((item) => [item.key, { size: item.size, etag: item.etag }]));
  const qiniu = createFakeQiniu(initial);
  const originalUpload = qiniu.uploadContent;
  qiniu.uploadContent = async (key, ...args) => {
    await originalUpload.call(qiniu, key, ...args);
    if (key === plan.channelManifest.key) throw new Error("upload response lost");
  };
  await assert.rejects(promoteChannel(plan, verifiedEvidence(plan), {
    qiniu,
    refresh: async () => {},
    readBack: async () => ({}),
  }), /upload response lost/);
  assert.equal(qiniu.state.has("jugglework/releases/locks/stable-mac.lock"), true);
  assert.equal(qiniu.state.has(plan.channelManifest.key), true);
});

test("promotion fails clearly when cache refresh is unavailable", async () => {
  const plan = fixturePlan();
  const qiniu = createFakeQiniu();
  await assert.rejects(promoteChannel(plan, verifiedEvidence(plan), { qiniu, readBack: async () => ({}) }), /refresh operation is unavailable/);
  assert.deepEqual(qiniu.calls, []);
});

test("stable macOS arm64 1.2.23 cache exception promotes without cache metadata, refresh, or public read-back", async () => {
  const plan = fixturePlan("1.2.23");
  const initial = new Map([...plan.objects, plan.manifest].map((item) => [item.key, { size: item.size, etag: item.etag }]));
  const qiniu = createFakeQiniu(initial);
  delete qiniu.setCacheControl;
  const evidence = verifiedEvidence(plan);
  evidence.canary = null;
  const result = await promoteChannel(plan, evidence, {
    qiniu,
    preCanaryExceptionReason: "Operator authorized stable macOS arm64 1.2.23 without a local real-client upgrade canary",
    cacheExceptionReason: "Operator authorized stable macOS arm64 1.2.23 without cache expiry, refresh, or public Stable convergence validation",
  });
  assert.deepEqual(result.channelObject, { size: plan.manifest.size, etag: plan.manifest.etag, verified: true });
  assert.equal(result.cacheException.scope, "stable-1.2.23-only");
  assert.equal(qiniu.calls.some(([method]) => method === "setCacheControl"), false);
  assert.equal(qiniu.state.has("jugglework/releases/locks/stable-mac.lock"), false);
});

test("stable macOS arm64 1.2.24 cache exception still verifies the channel object under lock", async () => {
  const plan = fixturePlan("1.2.24");
  const initial = new Map([...plan.objects, plan.manifest].map((item) => [item.key, { size: item.size, etag: item.etag }]));
  const qiniu = createFakeQiniu(initial);
  delete qiniu.setCacheControl;
  const evidence = verifiedEvidence(plan);
  evidence.canary = null;
  const result = await promoteChannel(plan, evidence, {
    qiniu,
    preCanaryExceptionReason: "Operator authorized stable macOS arm64 1.2.24 without a local real-client upgrade canary",
    cacheExceptionReason: "Operator authorized stable macOS arm64 1.2.24 without cache expiry or public Stable convergence validation",
  });
  assert.deepEqual(result.channelObject, { size: plan.manifest.size, etag: plan.manifest.etag, verified: true });
  assert.equal(result.cacheException.scope, "stable-1.2.24-only");
  assert.equal(qiniu.state.has("jugglework/releases/locks/stable-mac.lock"), false);
});

test("promotion fails before Qiniu calls when cache metadata management is unavailable", async () => {
  const plan = fixturePlan();
  const qiniu = createFakeQiniu();
  delete qiniu.setCacheControl;
  await assert.rejects(promoteChannel(plan, verifiedEvidence(plan), {
    qiniu,
    refresh: async () => {},
    readBack: async () => ({}),
  }), /Cache-Control metadata operation is unavailable/);
  assert.deepEqual(qiniu.calls, []);
});

test("cache metadata preflight fails before acquiring the promotion lock", async () => {
  const plan = fixturePlan();
  const qiniu = createFakeQiniu();
  qiniu.prepareCacheControl = async () => { throw new Error("metadata credentials missing"); };
  await assert.rejects(promoteChannel(plan, verifiedEvidence(plan), {
    qiniu,
    refresh: async () => {},
    readBack: async () => ({}),
  }), /metadata credentials missing/);
  assert.deepEqual(qiniu.calls, []);
});

test("dry runs cause no Qiniu, refresh, or read-back mutation", async () => {
  const plan = fixturePlan();
  const qiniu = createFakeQiniu();
  let externalCalls = 0;
  const refresh = async () => { externalCalls += 1; };
  const readBack = async () => { externalCalls += 1; };
  assert.equal((await uploadVersion(plan, { qiniu, dryRun: true })).dryRun, true);
  const promotion = await promoteChannel(plan, verifiedEvidence(plan), { qiniu, refresh, readBack, dryRun: true });
  assert.deepEqual(promotion.cacheControl, {
    conditional: true,
    value: CHANNEL_MANIFEST_CACHE_CONTROL,
    verifiedBeforeRefresh: true,
  });
  assert.equal(promotion.refreshUrl, plan.channelManifest.url);
  assert.deepEqual(promotion.readBack, { sha256: plan.manifest.sha256, size: plan.manifest.size });
  assert.deepEqual(qiniu.calls, []);
  assert.equal(externalCalls, 0);
});
