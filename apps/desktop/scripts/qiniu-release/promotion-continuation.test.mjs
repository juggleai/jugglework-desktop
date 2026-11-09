import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CANDIDATE_RECORDS, EXCEPTIONS, assertContinuationInputs, candidatePlan, command, continuePromotion, downloadCandidateObject, loadCommittedCandidate, main, safeFailure, verifyRestoredPackages } from "./promotion-continuation.mjs";
import { promotionLockKey } from "./constants.mjs";
import { assertPromotionEvidence } from "./evidence.mjs";
import { normalizeMacManifest } from "./manifest.mjs";
import { metadataForBuffer } from "./metadata.mjs";

const original = JSON.parse(readFileSync(new URL("../../release-records/1.2.31-candidate.json", import.meta.url), "utf8"));
const sha = "a".repeat(40);
const stamp = "2026-10-30T00:00:00.000Z";

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "promotion-continuation-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function environment(version = "1.2.34") {
  return { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/dev", GITHUB_SHA: sha,
    RELEASE_MODE: "promotion-only", VERSION: version, CHANNEL: "stable", RELEASE_PLATFORM: "mac", PROMOTE: "true",
    CANDIDATE_RECORD: CANDIDATE_RECORDS[version] };
}

// Synthetic records are confined to temporary test fixtures, never release-records.
function candidate(version = "1.2.34") {
  return JSON.parse(JSON.stringify(original).replaceAll("1.2.31", version));
}

function downloadableCandidate(version = "1.2.34") {
  const record = candidate(version);
  const plan = candidatePlan(record, "/unused");
  const bodies = new Map();
  const objects = plan.objects.map((item) => {
    const body = Buffer.from(`test bytes for ${item.name}`);
    bodies.set(item.key, body);
    return { ...item, ...metadataForBuffer(body, item.name) };
  });
  const { yaml } = normalizeMacManifest({ version: plan.version, platform: "mac", artifacts: objects });
  const manifest = { ...plan.manifest, ...metadataForBuffer(yaml, "latest-mac.yml") };
  bodies.set(manifest.key, Buffer.from(yaml));
  const evidence = record.evidence;
  evidence.artifacts = objects;
  evidence.manifest = manifest;
  evidence.localVerification.artifacts = objects;
  evidence.localVerification.manifest = manifest;
  const all = [...objects, manifest];
  const qiniuChecks = all.map(({ key, size, etag }) => ({ key, size, etag, verified: true }));
  evidence.workflow.immutable = { status: "verified", verifiedAt: stamp, qiniuChecks };
  evidence.workflow.cdn = { status: "verified", verifiedAt: stamp, qiniuChecks,
    cdnChecks: all.map((item) => ({ ...item, https: true, range: true, contentLength: item.size })) };
  const previous = Buffer.from("version: 1.2.31\n");
  record.expectedPreviousChannelDigest = metadataForBuffer(previous, "latest-mac.yml").sha256;
  return { record, bodies, previous };
}

test("dispatch accepts only exact version/path pairs and trusted dev workflow_dispatch context", () => {
  for (const version of ["1.2.31", "1.2.32", "1.2.33", "1.2.34"]) {
    assert.doesNotThrow(() => assertContinuationInputs(environment(version)));
    for (const patch of [
      { GITHUB_ACTIONS: "false" }, { GITHUB_EVENT_NAME: "push" }, { GITHUB_REF: "refs/heads/main" },
      { GITHUB_SHA: "a".repeat(7) }, { RELEASE_MODE: "build" }, { CHANNEL: "alpha" },
      { RELEASE_PLATFORM: "windows" }, { PROMOTE: "false" },
      { CANDIDATE_RECORD: CANDIDATE_RECORDS[version === "1.2.31" ? "1.2.32" : "1.2.31"] },
      { CANDIDATE_RECORD: `./${CANDIDATE_RECORDS[version]}` },
    ]) assert.throws(() => assertContinuationInputs({ ...environment(version), ...patch }));
  }
  for (const version of ["1.2.35", "1.2.33-alpha.1", "v1.2.33", "1.2.330", "1.2.34-alpha.1", "v1.2.34", "1.2.340", "toString"]) {
    assert.throws(() => assertContinuationInputs(environment(version)), /only exact/);
    assert.throws(() => candidatePlan(candidate(version), "/tmp"), /only exact/);
  }
});

test("original 1.2.31 candidate semantics and exception text remain valid", () => {
  const plan = candidatePlan(original, "/tmp");
  assert.equal(plan.version, "1.2.31");
  assert.equal(assertPromotionEvidence(plan, original.evidence, EXCEPTIONS), original.evidence);
  assert.ok(Object.values(EXCEPTIONS).every((reason) => reason.includes("1.2.31") && reason.trim().length >= 20));
});

for (const version of ["1.2.32", "1.2.33", "1.2.34"]) {
test(`${version} candidate gates retain exact source, signed/notarized receipts, evidence digests, inventory and predecessor`, () => {
  assert.equal(candidatePlan(candidate(version), "/tmp").version, version);
  const mutations = [
    (r) => { r.sourceCommit = "abc"; },
    (r) => { r.evidence.commit = sha; },
    (r) => { r.evidence.channel = "alpha"; },
    (r) => { r.evidence.platform = "windows"; },
    (r) => { r.evidence.architectures = ["x64"]; },
    (r) => { r.evidence.artifacts.pop(); },
    (r) => { r.evidence.artifacts[0].key = r.evidence.artifacts[0].key.replace(version, "1.2.35"); },
    (r) => { r.evidence.manifest.key = r.evidence.manifest.key.replace(version, "1.2.35"); },
    (r) => { r.evidence.artifacts[0].url = "https://example.com/file.zip"; },
    (r) => { r.evidence.artifacts[0].sha256 = "f".repeat(64); },
    (r) => { r.evidence.manifest.sha512 = Buffer.alloc(64).toString("base64"); },
    (r) => { r.evidence.localVerification.codesign.deep = false; },
    (r) => { r.evidence.localVerification.hardenedRuntime.status = "disabled"; },
    (r) => { r.evidence.localVerification.credentialState = "missing"; },
    (r) => { r.evidence.localVerification.notarization.status = "unavailable"; },
    (r) => { r.evidence.localVerification.dmg.staple.status = "unavailable"; },
    (r) => { r.receipts.app.version = "1.2.31"; },
    (r) => { r.receipts.dmg.submissionId = "different"; },
    (r) => { r.receipts.dmg.teamIdentifier = "OTHERTEAM1"; },
    (r) => { r.expectedPreviousChannelDigest = "bad"; },
    (r) => { r.expectedPreviousChannelDigest = r.evidence.manifest.sha256; },
    (r) => { r.evidence.workflow.cdn.cdnChecks[0].sha256 = "f".repeat(64); },
    (r) => { r.evidence.canary = { result: "failed" }; },
    (r) => { r.evidence.workflow.promotion = { status: "verified" }; },
  ];
  for (const mutate of mutations) {
    const record = candidate(version);
    mutate(record);
    assert.throws(() => candidatePlan(record, "/tmp"), undefined, mutate.toString());
  }
});
}

for (const version of ["1.2.31", "1.2.32", "1.2.33", "1.2.34"]) {
  test(`${version} loads only committed dispatch record with exact HEAD/origin, source ancestry and three package versions`, async (t) => {
    const root = await temporary(t);
    const record = candidate(version);
    let committed = `${JSON.stringify(record)}\n`;
    const recordPath = path.join(root, CANDIDATE_RECORDS[version]);
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(recordPath, committed);
    const packages = ["apps/app/package.json", "apps/desktop/package.json", "apps/server/package.json"];
    for (const file of packages) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), JSON.stringify({ version }));
    }
    const calls = [];
    const git = (args) => {
      calls.push(args);
      if (args[0] === "rev-parse") return sha;
      if (args[0] === "merge-base") return "";
      if (args[1] === `${sha}:${CANDIDATE_RECORDS[version]}`) return committed;
      if (args[0] === "show" && packages.some((file) => args[1] === `${sha}:${file}` || args[1] === `${record.sourceCommit}:${file}`)) return JSON.stringify({ version });
      throw new Error("Unexpected git read");
    };
    const loaded = await loadCommittedCandidate({ root, environment: environment(version), git });
    assert.equal(loaded.recordSha256, metadataForBuffer(committed, "candidate.json").sha256);
    assert.equal(loaded.toolingCommit, sha);
    assert.equal(loaded.record.evidence.commit, record.sourceCommit);
    assert.notEqual(loaded.record.sourceCommit, loaded.toolingCommit);
    assert.ok(calls.some((args) => JSON.stringify(args) === JSON.stringify(["merge-base", "--is-ancestor", record.sourceCommit, sha])));
    await assert.rejects(loadCommittedCandidate({ root, environment: environment(version), git: (args) => {
      if (args[1] === `${sha}:${CANDIDATE_RECORDS[version]}`) throw new Error("Candidate not committed");
      return git(args);
    } }), /Candidate not committed/);
    for (const target of ["HEAD", "origin/dev"]) {
      await assert.rejects(loadCommittedCandidate({ root, environment: environment(version), git: (args) => args[0] === "rev-parse" && args[1] === target ? "b".repeat(40) : git(args) }), /exactly match/);
    }
    await assert.rejects(loadCommittedCandidate({ root, environment: environment(version), git: (args) => {
      if (args[0] === "merge-base") throw new Error("Not an ancestor");
      return git(args);
    } }), /Not an ancestor/);
    for (const file of packages) {
      for (const commit of [sha, record.sourceCommit]) {
        await assert.rejects(loadCommittedCandidate({ root, environment: environment(version), git: (args) => args[1] === `${commit}:${file}` ? '{"version":"1.2.35"}' : git(args) }), /Runtime package version/);
      }
      await writeFile(path.join(root, file), '{"version":"1.2.35"}');
      await assert.rejects(loadCommittedCandidate({ root, environment: environment(version), git }), /Runtime package version/);
      await writeFile(path.join(root, file), JSON.stringify({ version }));
    }
    await writeFile(recordPath, `${committed} `);
    await assert.rejects(loadCommittedCandidate({ root, environment: environment(version), git }), /differs from committed/);
    committed = JSON.stringify(candidate(version === "1.2.31" ? "1.2.32" : "1.2.31"));
    await assert.rejects(loadCommittedCandidate({ root, environment: environment(version), git }), /differs from dispatch version/);
  });
}

for (const version of ["1.2.33", "1.2.34"]) {
test(`missing ${version} committed candidate stops before authentication or continuation`, async () => {
  const calls = [];
  await assert.rejects(main({ argv: [], environment: environment(version),
    loadCandidate: async () => { calls.push("load"); throw new Error("Candidate not committed"); },
    adapter: () => { calls.push("authenticate"); },
    continueRelease: async () => { calls.push("continue"); },
  }), /Candidate not committed/);
  assert.deepEqual(calls, ["load"]);
});
}

function packageChecks({ media = true, fail = "", version = "1.2.34" } = {}) {
  const calls = [];
  const trust = { notarization: { status: "accepted" }, staple: { status: "validated" }, gatekeeper: { status: "accepted" } };
  const verifier = Object.fromEntries([
    ["verifyBundleMetadata", {}], ["verifyCodeSignature", {}], ["verifyMachOArchitectures", {}],
    ["verifyMacToonFactoryBundle", media ? { mediaTools: { manifest: { phase: "signed", signingTeam: "H7PDHSK3C7" } } } : {}],
    ["verifyPackagedUpdaterConfiguration", {}], ["verifyAppleTrust", trust],
    ["verifyDmgTrust", { ...trust, signature: { status: "accepted", teamIdentifier: "H7PDHSK3C7" }, image: { status: "verified" } }],
  ].map(([name, result]) => [name, (...args) => {
    calls.push([name, ...args]);
    if (name === fail) throw new Error(`${name} failed`);
    return result;
  }]));
  const run = (binary, args) => {
    if (binary === "ditto") mkdirSync(path.join(args.at(-1), "JuggleWork.app"));
    if (binary === "hdiutil" && args[0] === "attach") mkdirSync(path.join(args[4], "JuggleWork.app"));
  };
  return { calls, verifier, run, platform: "darwin", extractAsar: () => Buffer.from(JSON.stringify({ version })) };
}

for (const version of ["1.2.32", "1.2.33", "1.2.34"]) {
test(`${version} freshly verifies both containers with current signed media and Apple trust verifiers`, async (t) => {
  const parent = await temporary(t);
  const plan = candidatePlan(candidate(version), parent);
  const checks = packageChecks({ version });
  const result = await verifyRestoredPackages(plan, { parent, ...checks });
  assert.equal(result.status, "verified");
  assert.equal(checks.calls.filter(([name]) => name === "verifyMacToonFactoryBundle").length, 2);
  assert.equal(checks.calls.filter(([name]) => name === "verifyAppleTrust").length, 2);
  assert.equal(checks.calls.filter(([name]) => name === "verifyDmgTrust").length, 1);
  for (const name of ["verifyCodeSignature", "verifyMachOArchitectures", "verifyMacToonFactoryBundle", "verifyAppleTrust", "verifyDmgTrust"]) {
    await assert.rejects(verifyRestoredPackages(plan, { parent, ...packageChecks({ version, fail: name }) }), /failed/);
  }
  await assert.rejects(verifyRestoredPackages(plan, { parent, ...packageChecks({ version, media: false }) }), /signed media tools/);
  for (const manifest of [{ phase: "built", signingTeam: "H7PDHSK3C7" }, { phase: "signed", signingTeam: "OTHERTEAM1" }]) {
    const unsigned = packageChecks({ version });
    unsigned.verifier.verifyMacToonFactoryBundle = () => ({ mediaTools: { manifest } });
    await assert.rejects(verifyRestoredPackages(plan, { parent, ...unsigned }), /signed media tools/);
  }
  const untrusted = packageChecks({ version });
  untrusted.verifier.verifyAppleTrust = () => ({ notarization: { status: "unavailable" } });
  await assert.rejects(verifyRestoredPackages(plan, { parent, ...untrusted }), /notarization/);
  const wrongVersion = packageChecks({ version });
  wrongVersion.extractAsar = () => Buffer.from('{"version":"1.2.31"}');
  await assert.rejects(verifyRestoredPackages(plan, { parent, ...wrongVersion }), /runtime package version/);
  await assert.rejects(verifyRestoredPackages(plan, { parent, platform: "linux" }), /requires macOS/);
});
}

test("restored immutable downloads require exact bytes and never overwrite local output", async (t) => {
  const parent = await temporary(t);
  const body = Buffer.from("exact candidate bytes");
  const object = { key: "test.zip", url: "https://downloads.jugglechat.cn/test.zip", path: path.join(parent, "test.zip"), ...metadataForBuffer(body, "test.zip") };
  const response = (bytes = body) => new Response(bytes, { headers: { "content-type": object.mime, "content-length": String(object.size) } });
  await downloadCandidateObject(object, { fetchImpl: async () => response() });
  assert.deepEqual(await readFile(object.path), body);
  await assert.rejects(downloadCandidateObject(object, { fetchImpl: async () => response() }), /EEXIST/);
  await assert.rejects(downloadCandidateObject({ ...object, path: path.join(parent, "changed.zip") }, { fetchImpl: async () => response(Buffer.alloc(body.length)) }), /mismatch/);
  await assert.rejects(downloadCandidateObject({ ...object, path: path.join(parent, "oversized.zip") }, { fetchImpl: async () => response(Buffer.alloc(body.length + 1)) }), /exceeds expected size/);
});

test("historical no-media path is digest-pinned and cannot apply to replacement 1.2.31 bytes", async (t) => {
  const parent = await temporary(t);
  const plan = candidatePlan(original, parent);
  const checks = packageChecks();
  // The original path invokes the real inventory/Bun verifier, not today's media verifier.
  await assert.rejects(verifyRestoredPackages(plan, { parent, ...checks }), /toonFactory|ENOENT/);
  assert.equal(checks.calls.some(([name]) => name === "verifyMacToonFactoryBundle"), false);
  for (const object of [plan.manifest, ...plan.objects.filter((item) => ["zip", "dmg"].includes(item.type))]) {
    const digest = object.sha256;
    object.sha256 = "f".repeat(64);
    await assert.rejects(verifyRestoredPackages(plan, { parent, ...checks }), /original exact 1.2.31/);
    object.sha256 = digest;
  }
});

function promotionHarness(fixture, { badCdn = false, priorMismatch = false, heldLock = false } = {}) {
  const { record, bodies, previous } = fixture;
  const calls = [];
  const plan = candidatePlan(record, "/unused");
  const lock = promotionLockKey("stable", "mac");
  const state = new Map([...plan.objects, plan.manifest].map((item) => [item.key, { ...item, content: bodies.get(item.key) }]));
  state.set(plan.channelManifest.key, { content: priorMismatch ? Buffer.from("different predecessor") : previous });
  if (heldLock) state.set(lock, { size: 1, etag: "held" });
  const qiniu = {
    async stat(key) { calls.push(["stat", key]); return state.get(key) ?? null; },
    async readContent(key) { calls.push(["read", key]); return state.get(key)?.content ?? null; },
    async uploadContent(key, content, mime, options) {
      calls.push(["upload", key, options]);
      if (!options.overwrite && state.has(key)) throw new Error("exists");
      state.set(key, { ...metadataForBuffer(content, key), content });
    },
    async delete(key) { calls.push(["delete", key]); state.delete(key); },
    async refresh(urls) { calls.push(["refresh", ...urls]); },
    async setCacheControl() { throw new Error("Metadata-only exception must not mutate metadata"); },
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push(["fetch", url, options.method ?? "GET", options.headers?.Range]);
    const key = new URL(url).pathname.slice(1);
    const object = state.get(key);
    const body = object?.content;
    if (!body) throw new Error("Missing fixture body");
    const range = options.headers?.Range;
    const headers = { "content-type": object.mime, "content-length": String(range ? 1 : body.length) };
    if (range) headers["content-range"] = `bytes 0-0/${body.length}`;
    if (badCdn && options.method === "HEAD") headers["content-length"] = "0";
    return new Response(options.method === "HEAD" ? null : range ? body.subarray(0, 1) : body, { status: range ? 206 : 200, headers });
  };
  return { qiniu, fetchImpl, calls, plan, state, lock };
}

for (const version of ["1.2.32", "1.2.33", "1.2.34"]) {
test(`${version} continuation retains fresh CDN, predecessor/lock, exact manifest promotion and refresh/read-back`, async (t) => {
  const directory = await temporary(t);
  const fixture = downloadableCandidate(version);
  const harness = promotionHarness(fixture);
  const { record } = fixture;
  const recordSha256 = metadataForBuffer(JSON.stringify(record), "candidate.json").sha256;
  const result = await continuePromotion({ record, recordSha256, toolingCommit: sha, directory, actor: "test-only", ...harness,
    verifyPackages: async () => { harness.calls.push(["packages"]); return { status: "verified" }; } });
  assert.equal(result.preCanaryException.scope, `stable-${version}-only`);
  assert.equal(result.metadataException.scope, `stable-${version}-only`);
  for (const exception of [result.preCanaryException, result.metadataException]) {
    assert.ok(exception.reason.trim().length >= 20);
    assert.ok(exception.reason.includes(version));
  }
  assert.notEqual(result.preCanaryException.reason, result.metadataException.reason);
  assert.equal(result.notarizationException, null);
  assert.equal(result.cacheException, undefined);
  assert.equal(result.readBack.sha256, harness.plan.manifest.sha256);
  assert.deepEqual(harness.state.get(harness.plan.channelManifest.key).content, fixture.bodies.get(harness.plan.manifest.key));
  assert.equal(harness.state.has(harness.lock), false);
  const uploads = harness.calls.filter(([name]) => name === "upload");
  assert.deepEqual(uploads.map(([, key]) => key), [harness.lock, harness.plan.channelManifest.key]);
  const lockIndex = harness.calls.findIndex(([name]) => name === "upload");
  for (const item of [...harness.plan.objects, harness.plan.manifest]) {
    assert.ok(harness.calls.slice(0, lockIndex).some(([name, url, method]) => name === "fetch" && url === item.url && method === "HEAD"));
    assert.ok(harness.calls.slice(0, lockIndex).some(([name, url, , range]) => name === "fetch" && url === item.url && range === "bytes=0-0"));
    assert.ok(harness.calls.slice(0, lockIndex).filter(([name, url, method, range]) => name === "fetch" && url === item.url && method === "GET" && !range).length >= 2);
  }
  assert.ok(harness.calls.some(([name]) => name === "refresh"));
  const evidence = JSON.parse(await readFile(path.join(directory, "release-evidence.json"), "utf8"));
  assert.equal(evidence.continuation.candidateRecord, CANDIDATE_RECORDS[version]);
  assert.equal(evidence.continuation.recordSha256, recordSha256);
  assert.equal(evidence.continuation.sourceCommit, record.sourceCommit);
  assert.equal(evidence.commit, record.sourceCommit);
  assert.equal(evidence.continuation.toolingCommit, sha);
  assert.notEqual(evidence.continuation.sourceCommit, evidence.continuation.toolingCommit);
  assert.equal(evidence.continuation.status, "promoted");
  assert.equal(evidence.workflow.promotion.status, "verified");
  assert.deepEqual(evidence.workflow.promotion.preCanaryException, result.preCanaryException);
  assert.deepEqual(evidence.workflow.promotion.metadataException, result.metadataException);
  assert.equal(evidence.workflow.promotion.lock.expectedPreviousChannelDigest, record.expectedPreviousChannelDigest);
  assert.equal(evidence.workflow.promotion.lock.candidateDigest, harness.plan.manifest.sha256);
  assert.equal(evidence.workflow.promotion.lockKey, harness.lock);
  assert.deepEqual(evidence.workflow.promotion.readBack, result.readBack);
});
}

for (const failure of ["badCdn", "priorMismatch", "heldLock", "packages"]) {
  test(`continuation fails closed before channel writes on ${failure}`, async (t) => {
    const directory = await temporary(t);
    const fixture = downloadableCandidate();
    const harness = promotionHarness(fixture, { [failure]: true });
    await assert.rejects(continuePromotion({ record: fixture.record, recordSha256: "f".repeat(64), toolingCommit: sha,
      directory, actor: "test-only", ...harness, verifyPackages: async () => {
        if (failure === "packages") throw new Error("Package trust failed");
        return { status: "verified" };
      } }));
    assert.equal(harness.calls.some(([name]) => name === "upload"), false);
    const evidence = JSON.parse(await readFile(path.join(directory, "release-evidence.json"), "utf8"));
    assert.equal(evidence.continuation.status, "failed");
    assert.equal(evidence.continuation.failure.stage, { badCdn: "cdn.fresh", packages: "packages.verify", priorMismatch: "promotion", heldLock: "promotion" }[failure]);
  });
}

test("verify-only requires exact boolean pairing and CLI agreement, retaining legacy defaults", async () => {
  const env = { ...environment(), VERIFICATION_ONLY: "true", PROMOTE: "false", RUNNER_TEMP: "/private/unused" };
  assert.doesNotThrow(() => assertContinuationInputs(env));
  for (const value of ["TRUE", "", "1", true]) assert.throws(() => assertContinuationInputs({ ...env, VERIFICATION_ONLY: value }));
  for (const patch of [{ PROMOTE: "true" }, { VERIFICATION_ONLY: "false" }, { RELEASE_MODE: "build" }]) {
    assert.throws(() => assertContinuationInputs({ ...env, ...patch }));
  }
  const calls = [];
  const dependencies = { loadCandidate: async ({ environment: context }) => { calls.push(["load", context]); return {}; },
    adapter: () => { calls.push(["adapter"]); return {}; }, continueRelease: async (args) => { calls.push(["continue", args.verificationOnly]); } };
  await main({ argv: ["--verify-only"], environment: env, ...dependencies });
  assert.deepEqual(calls.at(-1), ["continue", true]);
  await main({ argv: ["--verify-only"], environment: { ...environment(), PROMOTE: "false", RUNNER_TEMP: "/private/unused" }, ...dependencies });
  assert.deepEqual(calls.at(-1), ["continue", true]);
  calls.length = 0;
  await main({ argv: ["--validate-only"], environment: env, ...dependencies });
  assert.deepEqual(calls.map(([name]) => name), ["load"]);
  calls.length = 0;
  for (const argv of [[], ["--validate-only", "--verify-only"], ["--verify-only", "--verify-only"], ["--unknown"]]) {
    await assert.rejects(main({ argv, environment: env, ...dependencies }));
  }
  await assert.rejects(main({ argv: ["--verify-only"], environment: environment(), ...dependencies }));
  assert.deepEqual(calls, []);
  await main({ argv: [], environment: { ...environment(), RUNNER_TEMP: "/private/unused" }, ...dependencies });
  assert.deepEqual(calls.at(-1), ["continue", false]);
});

test("bounded subprocess diagnostics include only fixed binary/flags, exit and allowlisted codes", () => {
  const secret = "/private/runner/secret-token?credential=do-not-record";
  const execute = (binary, args, options) => {
    assert.equal(options.timeout, 600_000);
    assert.equal(options.maxBuffer, 16 * 1024 * 1024);
    return { status: 69, error: Object.assign(new Error(secret), { code: "EACCES", path: secret }), stdout: secret, stderr: secret };
  };
  let failure;
  try { command("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", secret, secret], secret, execute); }
  catch (error) { failure = safeFailure(error, "dmg.mount"); assert.ok(!error.message.includes(secret)); }
  assert.deepEqual(failure, { stage: "dmg.mount", category: "package", errorName: "Error", errorCode: "EACCES", exitCode: 69,
    binary: "hdiutil", args: ["attach", "-readonly", "-nobrowse", "-mountpoint"] });
  const hostile = Object.assign(new Error(secret), { name: secret, code: secret, status: secret, cause: secret });
  assert.deepEqual(safeFailure(hostile, secret), { stage: "candidate", category: "validation" });
  assert.equal(safeFailure({ status: 503 }, "download.zip").status, 503);
  assert.equal(safeFailure({ status: 999 }, "download.zip").status, undefined);
  try { command(secret, [secret], secret, execute); }
  catch (error) { assert.ok(!JSON.stringify(safeFailure(error, "zip.extract")).includes(secret)); }
});

test("fetch diagnostics retain bounded nested/aggregate codes without messages, hosts, paths or secrets", () => {
  const secret = "SENTINEL_SECRET https://private.invalid/?token=never-record";
  const leaf = Object.assign(new Error(secret), { code: "ETIMEDOUT", syscall: "connect", address: secret, hostname: secret });
  const aggregate = new AggregateError([leaf, Object.assign(new Error(secret), { code: secret, syscall: secret })], secret);
  const error = new TypeError(secret, { cause: aggregate });
  leaf.cause = error;
  const failure = safeFailure(error, "download.zip");
  assert.deepEqual(failure.causes, [
    { depth: 1, errorName: "AggregateError" },
    { depth: 2, errorName: "Error", errorCode: "ETIMEDOUT", syscall: "connect" },
    { depth: 2, errorName: "Error" },
  ]);
  assert.ok(!JSON.stringify(failure).includes(secret));
  for (const code of ["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "ERR_TLS_CERT_ALTNAME_INVALID", "ENOMEM"]) {
    assert.equal(safeFailure(new TypeError(secret, { cause: Object.assign(new Error(secret), { code }) }), "download.zip").causes[0].errorCode, code);
  }
  let deep = leaf;
  for (let i = 0; i < 100; i++) deep = new AggregateError(Array(20).fill(deep), secret);
  assert.ok(safeFailure(deep, "download.zip").causes.length <= 8);
});

test("first GET transport failure retains phase/runtime/cause and stops before all Qiniu effects, without retry", async (t) => {
  const directory = await temporary(t);
  const fixture = downloadableCandidate();
  let fetches = 0;
  let remoteCalls = 0;
  const secret = "SENTINEL_SECRET /private/runner token=never-record";
  const qiniu = new Proxy({}, { get() { remoteCalls++; throw new Error("Must not access Qiniu"); } });
  let rejected;
  try {
    await continuePromotion({ record: fixture.record, recordSha256: "f".repeat(64), toolingCommit: sha, directory, actor: "test-only", qiniu,
      fetchImpl: async (url, options) => {
        fetches++;
        assert.equal(url, candidatePlan(fixture.record, directory).objects[0].url);
        assert.equal(options.redirect, "error");
        assert.equal(options.method ?? "GET", "GET");
        assert.ok(options.signal instanceof AbortSignal);
        throw new TypeError(secret, { cause: Object.assign(new Error(secret), { code: "UND_ERR_CONNECT_TIMEOUT", hostname: secret }) });
      } });
  } catch (error) { rejected = error; }
  assert.ok(rejected);
  assert.equal(fetches, 1);
  assert.equal(remoteCalls, 0);
  const evidence = JSON.parse(await readFile(path.join(directory, "release-evidence.json"), "utf8"));
  const failure = evidence.continuation.failure;
  assert.equal(failure.stage, "download.zip");
  assert.equal(failure.phase, "headers");
  assert.equal(failure.bytesReceived, 0);
  assert.equal(failure.causes[0].errorCode, "UND_ERR_CONNECT_TIMEOUT");
  assert.equal(failure.runtime.nodeVersion, process.versions.node);
  assert.equal(failure.runtime.undiciVersion, process.versions.undici);
  assert.ok(Number.isInteger(failure.elapsedMs) && failure.elapsedMs >= 0);
  assert.ok(failure.memory.rss > 0 && failure.memory.heapUsed > 0);
  assert.equal(evidence.workflow.promotion, null);
  assert.deepEqual(evidence.continuation.checkpoints.map(({ stage, phase }) => [stage, phase]), [["download.zip", "before"]]);
  assert.ok(!JSON.stringify([evidence, safeFailure(rejected, "candidate"), rejected.message, rejected.stack]).includes(secret));
});

test("interrupted body diagnostics distinguish received bytes and preserve partial output without retry", async (t) => {
  const directory = await temporary(t);
  const body = Buffer.from("immutable candidate bytes");
  const object = { path: path.join(directory, "test.zip"), ...metadataForBuffer(body, "test.zip") };
  let fetches = 0;
  const fetchImpl = async () => {
    fetches++;
    let pulls = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (pulls++ === 0) controller.enqueue(body.subarray(0, 4));
      else controller.error(new TypeError("SENTINEL_SECRET", { cause: Object.assign(new Error("SENTINEL_SECRET"), { code: "UND_ERR_SOCKET" }) }));
    } }, { highWaterMark: 0 }), { headers: { "content-type": object.mime, "content-length": String(object.size) } });
  };
  let failure;
  try { await downloadCandidateObject(object, { fetchImpl }); }
  catch (error) { failure = safeFailure(error, "download.zip"); }
  assert.equal(failure.phase, "body");
  assert.equal(failure.bytesReceived, 4);
  assert.equal(failure.causes[0].errorCode, "UND_ERR_SOCKET");
  assert.equal(fetches, 1);
  assert.deepEqual(await readFile(object.path), body.subarray(0, 4));
  assert.ok(!JSON.stringify(failure).includes("SENTINEL_SECRET"));
});

test("verify-only completes all five downloads, manifest, both package gates and fresh CDN without lock/write/refresh", async (t) => {
  const directory = await temporary(t);
  const fixture = downloadableCandidate();
  const harness = promotionHarness(fixture, { heldLock: true, priorMismatch: true });
  const allowed = new Set([...harness.plan.objects, harness.plan.manifest].map((object) => object.key));
  const qiniu = { async stat(key) { assert.ok(allowed.has(key)); return harness.qiniu.stat(key); } };
  // No refresh/read/write/delete/recover functions exist; a lock is deliberately held.
  const result = await continuePromotion({ record: fixture.record, recordSha256: "f".repeat(64), toolingCommit: sha,
    directory, actor: "test-only", verificationOnly: true, qiniu, fetchImpl: harness.fetchImpl,
    verifyPackages: (plan, options) => verifyRestoredPackages(plan, { ...options, ...packageChecks() }) });
  assert.deepEqual(result, { status: "verified", verificationOnly: true });
  assert.equal(harness.state.has(harness.lock), true);
  assert.deepEqual(harness.state.get(harness.plan.channelManifest.key).content, Buffer.from("different predecessor"));
  assert.ok(harness.calls.every(([name, key]) => name === "fetch" || (name === "stat" && allowed.has(key))));
  const evidence = JSON.parse(await readFile(path.join(directory, "release-evidence.json"), "utf8"));
  assert.equal(evidence.continuation.status, "verified");
  assert.equal(evidence.workflow.promotion, null);
  const checkpoints = evidence.continuation.checkpoints;
  for (const stage of ["download.zip", "download.dmg", "download.zip.blockmap", "download.dmg.blockmap", "download.manifest", "manifest.validate", "cdn.fresh", "dmg.outer-trust",
    ...["zip", "dmg"].flatMap((type) => ["metadata", "signature", "architecture", "toon", "updater", "apple-trust", "runtime-version"].map((gate) => `${type}.${gate}`))]) {
    assert.deepEqual(checkpoints.filter((item) => item.stage === stage).map((item) => item.phase), ["before", "after"], stage);
  }
  assert.ok(!checkpoints.some(({ stage }) => stage === "promotion"));
});

const packageFailures = {
  metadata: "verifyBundleMetadata", signature: "verifyCodeSignature", architecture: "verifyMachOArchitectures",
  toon: "verifyMacToonFactoryBundle", updater: "verifyPackagedUpdaterConfiguration", "apple-trust": "verifyAppleTrust",
};
for (const stage of ["download.zip", "download.dmg", "download.zip.blockmap", "download.dmg.blockmap", "download.manifest", "manifest.validate", "cdn.fresh", "zip.extract", "dmg.mount", "dmg.detach",
  ...["zip", "dmg"].flatMap((type) => [...Object.keys(packageFailures), "runtime-version"].map((gate) => `${type}.${gate}`)), "dmg.outer-trust"]) {
  test(`verify-only persists exact failed gate ${stage} without raw exception data or remote mutations`, async (t) => {
    const directory = await temporary(t);
    const fixture = downloadableCandidate();
    const harness = promotionHarness(fixture);
    const secret = "SENTINEL_SECRET /private/path credential=never-record";
    const hostile = () => { throw Object.assign(new Error(secret), { code: "EIO", stderr: secret, stack: secret, cause: secret }); };
    if (stage === "manifest.validate") {
      const manifest = harness.state.get(harness.plan.manifest.key);
      const content = Buffer.from("not: [valid YAML");
      const metadata = metadataForBuffer(content, "latest-mac.yml");
      Object.assign(manifest, metadata, { content });
      Object.assign(fixture.record.evidence.manifest, metadata);
      Object.assign(fixture.record.evidence.localVerification.manifest, metadata);
      for (const entry of [fixture.record.evidence.workflow.immutable, fixture.record.evidence.workflow.cdn]) {
        Object.assign(entry.qiniuChecks.find(({ key }) => key === manifest.key), { size: metadata.size, etag: metadata.etag });
      }
      Object.assign(fixture.record.evidence.workflow.cdn.cdnChecks.find(({ key }) => key === manifest.key), metadata, { contentLength: metadata.size });
    }
    const checks = packageChecks();
    let container = "zip";
    const run = checks.run;
    checks.run = (binary, args) => {
      if (binary === "hdiutil" && args[0] === "attach") container = "dmg";
      if ((stage === "zip.extract" && binary === "ditto") || (stage === "dmg.mount" && args[0] === "attach") || (stage === "dmg.detach" && args[0] === "detach")) {
        return command(binary, args, directory, () => ({ status: 69, stderr: secret, stdout: secret }));
      }
      // A second cleanup failure must never hide the original package failure.
      if (stage === "dmg.signature" && args[0] === "detach") hostile();
      return run(binary, args);
    };
    for (const [gate, name] of Object.entries(packageFailures)) {
      const verify = checks.verifier[name];
      checks.verifier[name] = (...args) => { if (stage === `${container}.${gate}`) hostile(); return verify(...args); };
    }
    if (stage === "dmg.outer-trust") checks.verifier.verifyDmgTrust = hostile;
    const extract = checks.extractAsar;
    checks.extractAsar = (...args) => { if (stage === `${container}.runtime-version`) hostile(); return extract(...args); };
    const fetchImpl = (url, options) => {
      if (stage.startsWith("download.") && url === [...harness.plan.objects, harness.plan.manifest].find(({ type }) => stage === `download.${type}`).url) hostile();
      return harness.fetchImpl(url, options);
    };
    if (stage === "cdn.fresh") harness.qiniu.stat = hostile;
    const snapshots = [];
    let rejected;
    try {
      await continuePromotion({ record: fixture.record, recordSha256: "f".repeat(64), toolingCommit: sha, directory, actor: "test-only",
        verificationOnly: true, qiniu: harness.qiniu, fetchImpl,
        persist: async (file, evidence) => { snapshots.push(structuredClone(evidence)); await writeFile(file, JSON.stringify(evidence)); },
        verifyPackages: (plan, options) => verifyRestoredPackages(plan, { ...options, ...checks }) });
    } catch (error) { rejected = error; }
    assert.ok(rejected);
    const evidence = JSON.parse(await readFile(path.join(directory, "release-evidence.json"), "utf8"));
    assert.equal(evidence.continuation.status, "failed");
    assert.equal(evidence.continuation.failure.stage, stage);
    if (["zip.extract", "dmg.mount", "dmg.detach"].includes(stage)) assert.equal(evidence.continuation.failure.exitCode, 69);
    assert.equal(evidence.workflow.promotion, null);
    assert.ok(!JSON.stringify([snapshots, safeFailure(rejected, "candidate"), rejected.message, rejected.stack]).includes(secret));
    assert.ok(!harness.calls.some(([name, key]) => ["upload", "delete", "refresh", "read"].includes(name) || key === harness.lock));
    const checkpoints = evidence.continuation.checkpoints.filter((item) => item.stage === stage);
    assert.deepEqual(checkpoints.map(({ phase }) => phase), ["before"]);
  });
}
