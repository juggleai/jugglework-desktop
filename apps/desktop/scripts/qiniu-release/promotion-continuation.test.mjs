import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CANDIDATE_RECORDS, EXCEPTIONS, assertContinuationInputs, candidatePlan, continuePromotion, downloadCandidateObject, loadCommittedCandidate, verifyRestoredPackages } from "./promotion-continuation.mjs";
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

function environment(version = "1.2.32") {
  return { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/dev", GITHUB_SHA: sha,
    RELEASE_MODE: "promotion-only", VERSION: version, CHANNEL: "stable", RELEASE_PLATFORM: "mac", PROMOTE: "true",
    CANDIDATE_RECORD: CANDIDATE_RECORDS[version] };
}

function candidate(version = "1.2.32") {
  return JSON.parse(JSON.stringify(original).replaceAll("1.2.31", version));
}

function downloadableCandidate() {
  const record = candidate();
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
  for (const version of ["1.2.31", "1.2.32"]) {
    assert.doesNotThrow(() => assertContinuationInputs(environment(version)));
    for (const patch of [
      { GITHUB_ACTIONS: "false" }, { GITHUB_EVENT_NAME: "push" }, { GITHUB_REF: "refs/heads/main" },
      { GITHUB_SHA: "a".repeat(7) }, { RELEASE_MODE: "build" }, { CHANNEL: "alpha" },
      { RELEASE_PLATFORM: "windows" }, { PROMOTE: "false" },
      { CANDIDATE_RECORD: CANDIDATE_RECORDS[version === "1.2.31" ? "1.2.32" : "1.2.31"] },
      { CANDIDATE_RECORD: `./${CANDIDATE_RECORDS[version]}` },
    ]) assert.throws(() => assertContinuationInputs({ ...environment(version), ...patch }));
  }
  for (const version of ["1.2.33", "1.2.32-alpha.1", "v1.2.32", "1.2.320", "toString"]) {
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

test("candidate gates retain exact source, signed/notarized receipts, evidence digests, inventory and predecessor", () => {
  assert.equal(candidatePlan(candidate(), "/tmp").version, "1.2.32");
  const mutations = [
    (r) => { r.sourceCommit = "abc"; },
    (r) => { r.evidence.commit = sha; },
    (r) => { r.evidence.channel = "alpha"; },
    (r) => { r.evidence.platform = "windows"; },
    (r) => { r.evidence.architectures = ["x64"]; },
    (r) => { r.evidence.artifacts.pop(); },
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
    (r) => { r.evidence.workflow.promotion = { status: "verified" }; },
  ];
  for (const mutate of mutations) {
    const record = candidate();
    mutate(record);
    assert.throws(() => candidatePlan(record, "/tmp"), undefined, mutate.toString());
  }
});

for (const version of ["1.2.31", "1.2.32"]) {
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
    assert.ok(calls.some((args) => JSON.stringify(args) === JSON.stringify(["merge-base", "--is-ancestor", record.sourceCommit, sha])));
    for (const target of ["HEAD", "origin/dev"]) {
      await assert.rejects(loadCommittedCandidate({ root, environment: environment(version), git: (args) => args[0] === "rev-parse" && args[1] === target ? "b".repeat(40) : git(args) }), /exactly match/);
    }
    await assert.rejects(loadCommittedCandidate({ root, environment: environment(version), git: (args) => {
      if (args[0] === "merge-base") throw new Error("Not an ancestor");
      return git(args);
    } }), /Not an ancestor/);
    for (const file of packages) {
      for (const commit of [sha, record.sourceCommit]) {
        await assert.rejects(loadCommittedCandidate({ root, environment: environment(version), git: (args) => args[1] === `${commit}:${file}` ? '{"version":"1.2.33"}' : git(args) }), /Runtime package version/);
      }
      await writeFile(path.join(root, file), '{"version":"1.2.33"}');
      await assert.rejects(loadCommittedCandidate({ root, environment: environment(version), git }), /Runtime package version/);
      await writeFile(path.join(root, file), JSON.stringify({ version }));
    }
    await writeFile(recordPath, `${committed} `);
    await assert.rejects(loadCommittedCandidate({ root, environment: environment(version), git }), /differs from committed/);
    committed = JSON.stringify(candidate(version === "1.2.31" ? "1.2.32" : "1.2.31"));
    await assert.rejects(loadCommittedCandidate({ root, environment: environment(version), git }), /differs from dispatch version/);
  });
}

function packageChecks({ media = true, fail = "" } = {}) {
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
  return { calls, verifier, run, platform: "darwin", extractAsar: () => Buffer.from('{"version":"1.2.32"}') };
}

test("1.2.32 freshly verifies both containers with current signed media and Apple trust verifiers", async (t) => {
  const parent = await temporary(t);
  const plan = candidatePlan(candidate(), parent);
  const checks = packageChecks();
  const result = await verifyRestoredPackages(plan, { parent, ...checks });
  assert.equal(result.status, "verified");
  assert.equal(checks.calls.filter(([name]) => name === "verifyMacToonFactoryBundle").length, 2);
  assert.equal(checks.calls.filter(([name]) => name === "verifyAppleTrust").length, 2);
  assert.equal(checks.calls.filter(([name]) => name === "verifyDmgTrust").length, 1);
  for (const name of ["verifyCodeSignature", "verifyMachOArchitectures", "verifyMacToonFactoryBundle", "verifyAppleTrust", "verifyDmgTrust"]) {
    await assert.rejects(verifyRestoredPackages(plan, { parent, ...packageChecks({ fail: name }) }), /failed/);
  }
  await assert.rejects(verifyRestoredPackages(plan, { parent, ...packageChecks({ media: false }) }), /signed media tools/);
  for (const manifest of [{ phase: "built", signingTeam: "H7PDHSK3C7" }, { phase: "signed", signingTeam: "OTHERTEAM1" }]) {
    const unsigned = packageChecks();
    unsigned.verifier.verifyMacToonFactoryBundle = () => ({ mediaTools: { manifest } });
    await assert.rejects(verifyRestoredPackages(plan, { parent, ...unsigned }), /signed media tools/);
  }
  const untrusted = packageChecks();
  untrusted.verifier.verifyAppleTrust = () => ({ notarization: { status: "unavailable" } });
  await assert.rejects(verifyRestoredPackages(plan, { parent, ...untrusted }), /notarization/);
  const wrongVersion = packageChecks();
  wrongVersion.extractAsar = () => Buffer.from('{"version":"1.2.31"}');
  await assert.rejects(verifyRestoredPackages(plan, { parent, ...wrongVersion }), /runtime package version/);
  await assert.rejects(verifyRestoredPackages(plan, { parent, platform: "linux" }), /requires macOS/);
});

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

test("1.2.32 continuation retains fresh CDN, predecessor/lock, exact manifest promotion and refresh/read-back", async (t) => {
  const directory = await temporary(t);
  const fixture = downloadableCandidate();
  const harness = promotionHarness(fixture);
  const { record } = fixture;
  const recordSha256 = metadataForBuffer(JSON.stringify(record), "candidate.json").sha256;
  const result = await continuePromotion({ record, recordSha256, toolingCommit: sha, directory, actor: "test-only", ...harness,
    verifyPackages: async () => { harness.calls.push(["packages"]); return { status: "verified" }; } });
  assert.equal(result.preCanaryException.scope, "stable-1.2.32-only");
  assert.equal(result.metadataException.scope, "stable-1.2.32-only");
  for (const exception of [result.preCanaryException, result.metadataException]) assert.ok(exception.reason.trim().length >= 20);
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
  }
  assert.ok(harness.calls.some(([name]) => name === "refresh"));
  const evidence = JSON.parse(await readFile(path.join(directory, "release-evidence.json"), "utf8"));
  assert.equal(evidence.continuation.candidateRecord, CANDIDATE_RECORDS["1.2.32"]);
  assert.equal(evidence.continuation.recordSha256, recordSha256);
  assert.equal(evidence.continuation.status, "promoted");
  assert.equal(evidence.workflow.promotion.status, "verified");
});

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
  });
}
