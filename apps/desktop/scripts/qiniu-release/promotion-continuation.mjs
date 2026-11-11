import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

import { artifactKey, channelManifestKey, DEFAULT_BUCKET, publicUrl, versionManifestKey } from "./constants.mjs";
import { assertNoSecrets, assertPromotionEvidence, assertRecordedPromotion, replaceEvidence, withEvidenceResults, writeEvidence } from "./evidence.mjs";
import { normalizeArtifacts, validateMacManifest } from "./manifest.mjs";
import { inspectArtifact, isCanonicalSha512, metadataForBuffer } from "./metadata.mjs";
import { createQshellAdapter } from "./qshell.mjs";
import { promoteChannel, verifyCdn } from "./workflow.mjs";
import { STANDING_POLICY_SCOPE, STANDING_POLICY_VERSION, STANDING_POLICY_MINIMUM_VERSION,
  assertStandingPolicyCoordinates, assertStandingPolicy, standingPolicyEvidence } from "./standing-policy.mjs";

export const CANDIDATE_RECORD = "apps/desktop/release-records/1.2.31-candidate.json";
export const CANDIDATE_RECORDS = Object.freeze({
  "1.2.31": CANDIDATE_RECORD,
  "1.2.32": "apps/desktop/release-records/1.2.32-candidate.json",
  "1.2.33": "apps/desktop/release-records/1.2.33-candidate.json",
  "1.2.34": "apps/desktop/release-records/1.2.34-candidate.json",
});
export const CANDIDATE_SCHEMA = "com.juggleai.jugglework.promotion-candidate";
export const EXCEPTIONS = Object.freeze({
  preCanaryExceptionReason: "Operator explicitly authorized stable macOS arm64 1.2.31 to skip only the real-client upgrade canary",
  metadataExceptionReason: "Operator explicitly authorized stable macOS arm64 1.2.31 to skip only Qiniu Cache-Control metadata mutation and validation",
});
export function candidateRecordPath(version) {
  if (Object.hasOwn(CANDIDATE_RECORDS, version)) return CANDIDATE_RECORDS[version];
  assertStandingPolicyCoordinates({ version, channel: "stable", platform: "mac", architectures: ["arm64"] });
  return `apps/desktop/release-records/${version}-candidate.json`;
}

function continuationPolicy(version, { standingPolicy = "", releasePolicy } = {}) {
  const candidateRecord = candidateRecordPath(version);
  if (!Object.hasOwn(CANDIDATE_RECORDS, version)) {
    const fields = ["scope", "policyVersion", "minVersion", "currentCoordinates", "reasons"];
    if (releasePolicy && Object.keys(releasePolicy).some((key) => !fields.includes(key))) throw new Error("Unsupported standing release policy fields");
    if (releasePolicy?.scope !== STANDING_POLICY_SCOPE || releasePolicy.policyVersion !== STANDING_POLICY_VERSION
      || releasePolicy.minVersion !== STANDING_POLICY_MINIMUM_VERSION || releasePolicy.currentCoordinates?.version !== version
      || releasePolicy.currentCoordinates.channel !== "stable" || releasePolicy.currentCoordinates.platform !== "mac"
      || releasePolicy.currentCoordinates.architecture !== "arm64") throw new Error("Committed standing policy authorization is required");
    const exceptions = { standingPolicy, preCanaryExceptionReason: releasePolicy.reasons?.canary,
      metadataExceptionReason: releasePolicy.reasons?.mutableCacheControl };
    assertStandingPolicy({ version, channel: "stable", platform: "mac", architectures: ["arm64"] }, exceptions);
    return { candidateRecord, exceptions };
  }
  if (standingPolicy || releasePolicy) throw new Error("Historical candidates cannot inherit standing policy");
  return {
    candidateRecord,
    exceptions: version === "1.2.31" ? EXCEPTIONS : {
      preCanaryExceptionReason: `Operator explicitly authorized stable macOS arm64 ${version} to skip only the real-client upgrade canary`,
      metadataExceptionReason: `Operator explicitly authorized stable macOS arm64 ${version} to skip only Qiniu Cache-Control metadata mutation and validation`,
    },
  };
}
const PACKAGES = ["apps/app/package.json", "apps/desktop/package.json", "apps/server/package.json"];
const TYPES = ["zip", "dmg", "zip.blockmap", "dmg.blockmap"];
const failureDetails = new WeakMap();
const ERROR_NAMES = ["Error", "TypeError", "SyntaxError", "RangeError", "AbortError", "TimeoutError", "AggregateError"];
const ERROR_CODES = ["ENOENT", "EEXIST", "EACCES", "EPERM", "ENOSPC", "EIO", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENOBUFS", "ABORT_ERR", "ERR_BUFFER_OUT_OF_BOUNDS"];
const FETCH_CODES = ["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_ABORTED",
  "UND_ERR_RESPONSE_CONTENT_LENGTH_MISMATCH", "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH", "UND_ERR_RES_EXCEEDED_MAX_SIZE",
  "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CERT_REVOKED", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "EPROTO",
  "ENETUNREACH", "EHOSTUNREACH", "ENOMEM", "ERR_OUT_OF_MEMORY", "ERR_BUFFER_TOO_LARGE", "ERR_INVALID_URL", "ERR_INVALID_ARG_TYPE"];
const SYSCALLS = ["getaddrinfo", "connect", "read", "write", "open"];
const PACKAGE_STAGES = ["prepare", "extract", "mount", "inventory", "metadata", "signature", "architecture", "toon", "updater", "apple-trust", "runtime-version", "detach", "cleanup"];
const STAGES = new Set(["candidate", "manifest.validate", "packages.prepare", "packages.verify", "dmg.outer-trust", "cdn.fresh", "promotion", "evidence.persist",
  ...[...TYPES, "manifest"].map((type) => `download.${type}`),
  ...["zip", "dmg"].flatMap((type) => PACKAGE_STAGES.map((stage) => `${type}.${stage}`))]);

// Project cause/AggregateError trees into a bounded closed vocabulary, never raw errors.
function safeCauses(error) {
  const result = [];
  const seen = new Set([error]);
  const queue = [{ error: error?.cause, depth: 1 }];
  if (Array.isArray(error?.errors)) queue.push(...error.errors.slice(0, 8).map((child) => ({ error: child, depth: 1 })));
  for (let i = 0; i < queue.length && i < 8; i++) {
    const { error: child, depth } = queue[i];
    if (!child || typeof child !== "object" || seen.has(child)) continue;
    seen.add(child);
    const item = { depth };
    if (ERROR_NAMES.includes(child.name)) item.errorName = child.name;
    if ([...ERROR_CODES, ...FETCH_CODES].includes(child.code)) item.errorCode = child.code;
    if (SYSCALLS.includes(child.syscall)) item.syscall = child.syscall;
    if (Object.keys(item).length > 1) result.push(item);
    if (depth < 4) {
      if (child.cause) queue.push({ error: child.cause, depth: depth + 1 });
      if (Array.isArray(child.errors)) queue.push(...child.errors.slice(0, 8).map((nested) => ({ error: nested, depth: depth + 1 })));
    }
  }
  return result;
}

// Closed vocabulary only: never copy message, stack, raw cause, stdout/stderr, argv or paths.
export function safeFailure(error, stage) {
  const known = error && typeof error === "object" ? failureDetails.get(error) : undefined;
  const failure = { stage: STAGES.has(stage) ? stage : "candidate", category: {
    download: "download", manifest: "manifest", packages: "package", zip: "package", dmg: "package",
    cdn: "cdn", promotion: "promotion", evidence: "persistence", candidate: "validation",
  }[(STAGES.has(stage) ? stage : "candidate").split(".")[0]] };
  if (ERROR_NAMES.includes(error?.name)) failure.errorName = error.name;
  if ([...ERROR_CODES, ...FETCH_CODES].includes(error?.code)) failure.errorCode = error.code;
  const causes = safeCauses(error);
  if (causes.length) failure.causes = causes;
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) failure.status = error.status;
  if (known) Object.assign(failure, known);
  return failure;
}

function safeError(failure) {
  const error = new Error(`Continuation gate failed: ${failure.stage}`);
  failureDetails.set(error, failure);
  return error;
}

async function packageGate(stage, operation) {
  try { return await operation(); }
  catch (error) {
    // Keep existing helper callers compatible; the continuation boundary only emits safeFailure.
    if (error && typeof error === "object" && !failureDetails.has(error)) failureDetails.set(error, safeFailure(error, stage));
    throw error;
  }
}

export function command(binary, args, cwd, execute = spawnSync) {
  const result = execute(binary, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 600_000, killSignal: "SIGKILL" });
  // Never surface subprocess output: a repository or runner error may contain private data.
  if (result.error || result.status !== 0) {
    const error = new Error("Subprocess failed");
    const details = {};
    if (Number.isInteger(result.status) && result.status >= 0 && result.status <= 255) details.exitCode = result.status;
    if (ERROR_NAMES.includes(result.error?.name)) details.errorName = result.error.name;
    if (ERROR_CODES.includes(result.error?.code)) details.errorCode = result.error.code;
    const safeArgs = {
      git: { show: ["show"], "rev-parse": ["rev-parse"], "merge-base": ["merge-base", "--is-ancestor"] },
      ditto: { "-x": ["-x", "-k"] },
      hdiutil: { attach: ["attach", "-readonly", "-nobrowse", "-mountpoint"], detach: ["detach"] },
    };
    if (Object.hasOwn(safeArgs, binary) && Object.hasOwn(safeArgs[binary], args[0])) {
      details.binary = binary;
      details.args = safeArgs[binary][args[0]];
    }
    failureDetails.set(error, details);
    throw error;
  }
  return result.stdout;
}

export function assertContinuationInputs(environment) {
  const candidateRecord = candidateRecordPath(environment.VERSION);
  const standingPolicy = environment.STANDING_POLICY ?? "";
  if (Object.hasOwn(CANDIDATE_RECORDS, environment.VERSION)) {
    if (standingPolicy) throw new Error("Historical candidates cannot inherit standing policy");
  } else if (standingPolicy !== STANDING_POLICY_SCOPE) throw new Error("Explicit standing policy selection is required");
  const verificationOnly = environment.VERIFICATION_ONLY ?? "false";
  if (!["true", "false"].includes(verificationOnly) || environment.PROMOTE !== (verificationOnly === "true" ? "false" : "true")) {
    throw new Error("verification_only and promote must be exact opposite booleans");
  }
  if (environment.GITHUB_ACTIONS !== "true" || environment.GITHUB_EVENT_NAME !== "workflow_dispatch"
    || environment.GITHUB_REF !== "refs/heads/dev" || !/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA ?? "")
    || environment.RELEASE_MODE !== "promotion-only"
    || environment.CHANNEL !== "stable" || environment.RELEASE_PLATFORM !== "mac") {
    throw new Error("Continuation requires workflow_dispatch on dev for promotion-only stable/mac/arm64");
  }
  if (environment.CANDIDATE_RECORD !== candidateRecord) throw new Error("Candidate record path is fixed for the exact version");
}

export function candidatePlan(record, dist, { standingPolicy = "" } = {}) {
  assertNoSecrets(record);
  if (record?.schema !== CANDIDATE_SCHEMA || record.schemaVersion !== 1
    || !/^[a-f0-9]{40}$/.test(record.sourceCommit ?? "") || record.evidence?.commit !== record.sourceCommit
    || !/^[a-f0-9]{64}$/.test(record.expectedPreviousChannelDigest ?? "")) {
    throw new Error("Invalid candidate schema, exact source commit, or approved predecessor digest");
  }
  const evidence = record.evidence;
  const version = evidence?.version;
  const { exceptions } = continuationPolicy(version, { standingPolicy, releasePolicy: record.releasePolicy });
  if (evidence.channel !== "stable" || evidence.platform !== "mac"
    || JSON.stringify(evidence.architectures) !== '["arm64"]' || evidence.artifacts?.length !== 4
    || evidence.workflow?.promotion != null) throw new Error("Candidate must be an unpromoted stable/mac/arm64 release");
  const objects = TYPES.map((type) => {
    const name = `jugglework-mac-arm64-${version}.${type}`;
    const key = artifactKey(version, "arm64", name, "mac");
    const matches = evidence.artifacts.filter((item) => item.key === key && item.name === name);
    if (matches.length !== 1) throw new Error(`Candidate inventory mismatch: ${name}`);
    const item = matches[0];
    if (item.url !== undefined && item.url !== publicUrl(key)) throw new Error("Unapproved artifact URL");
    return { ...item, name, key, type, arch: "arm64", path: path.join(dist, name), url: publicUrl(key) };
  });
  const manifestKey = versionManifestKey(version, "mac");
  const manifest = {
    ...evidence.manifest, name: "latest-mac.yml", type: "manifest", key: manifestKey,
    url: publicUrl(manifestKey), path: path.join(dist, `qiniu-v${version}-latest-mac.yml`),
  };
  for (const item of [...objects, manifest]) {
    if (!Number.isSafeInteger(item.size) || item.size <= 0 || !/^[a-f0-9]{64}$/.test(item.sha256 ?? "")
      || !isCanonicalSha512(item.sha512) || !/^[A-Za-z0-9_-]{28}$/.test(item.etag ?? "")
      || item.mime !== metadataForBuffer("", item.name).mime) throw new Error("Invalid candidate object metadata");
  }
  const plan = {
    version, channel: "stable", platform: "mac", architectures: ["arm64"],
    objects: normalizeArtifacts({ version, platform: "mac", artifacts: objects }), manifest,
    channelManifest: { key: channelManifestKey("stable", "mac"), url: publicUrl(channelManifestKey("stable", "mac")) },
  };
  assertPromotionEvidence(plan, evidence, exceptions);
  if (standingPolicy && JSON.stringify(record.releasePolicy) !== JSON.stringify(standingPolicyEvidence(plan, evidence, exceptions).releasePolicy)) {
    throw new Error("Committed standing policy source or manifest coordinates mismatch");
  }
  for (const [type, schema, producer, submissionId] of [
    ["app", "com.juggleai.jugglework.macos-notarization-receipt", "electron-after-sign", evidence.localVerification.notarization.submissionId],
    ["dmg", "com.juggleai.jugglework.macos-dmg-notarization-receipt", "finalize-macos-artifacts", evidence.localVerification.dmg.notarization.submissionId],
  ]) {
    const receipt = record.receipts?.[type];
    if (receipt?.schema !== schema || receipt.schemaVersion !== 1 || receipt.producer !== producer
      || receipt.version !== version || receipt.submissionId !== submissionId || receipt.status !== "accepted"
      || receipt.staple !== "validated" || !Number.isFinite(Date.parse(receipt.createdAt))
      || (type === "app" && receipt.bundleIdentifier !== "com.juggleai.jugglework")
      || (type === "dmg" && (receipt.teamIdentifier !== "H7PDHSK3C7" || receipt.gatekeeper !== "accepted"
        || receipt.architecture !== "arm64" || receipt.artifactName !== `jugglework-mac-arm64-${version}.dmg`))) {
      throw new Error(`Missing or mismatched original ${type} notarization receipt`);
    }
  }
  if (record.expectedPreviousChannelDigest === manifest.sha256) throw new Error("Predecessor must differ from candidate");
  return plan;
}

export async function loadCommittedCandidate({ root, environment = process.env,
  git = (args) => args[0] === "show" ? command("git", args, root) : command("git", args, root).trim() }) {
  assertContinuationInputs(environment);
  const version = environment.VERSION;
  const candidateRecord = candidateRecordPath(version);
  const sha = environment.GITHUB_SHA;
  if (git(["rev-parse", "HEAD"]) !== sha || git(["rev-parse", "origin/dev"]) !== sha) {
    throw new Error("Checkout HEAD and origin/dev must exactly match github.sha");
  }
  const committed = git(["show", `${sha}:${candidateRecord}`]);
  const record = JSON.parse(committed);
  if (record.evidence?.version !== version) throw new Error("Committed candidate version differs from dispatch version");
  candidatePlan(record, root, { standingPolicy: environment.STANDING_POLICY });
  git(["merge-base", "--is-ancestor", record.sourceCommit, sha]);
  for (const file of PACKAGES) {
    if (JSON.parse(git(["show", `${record.sourceCommit}:${file}`])).version !== version
      || JSON.parse(git(["show", `${sha}:${file}`])).version !== version
      || JSON.parse(await readFile(path.join(root, file), "utf8")).version !== version) {
      throw new Error(`Runtime package version must be ${version}: ${file}`);
    }
  }
  if ((await readFile(path.join(root, candidateRecord), "utf8")) !== committed) {
    throw new Error("Working candidate differs from committed candidate");
  }
  return { record, recordSha256: metadataForBuffer(committed, "candidate.json").sha256, toolingCommit: sha, standingPolicy: environment.STANDING_POLICY };
}

export async function downloadCandidateObject(object, { fetchImpl = globalThis.fetch } = {}) {
  const started = performance.now();
  let phase = "headers";
  let bytesReceived = 0;
  let response;
  try {
    response = await fetchImpl(object.url, { redirect: "error", signal: AbortSignal.timeout(600_000) });
    phase = "metadata";
    if (response.status !== 200 || response.headers.get("content-length") !== String(object.size)
      || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== object.mime || !response.body) {
      const error = new Error("Candidate download metadata mismatch");
      if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) failureDetails.set(error, { status: response.status });
      throw error;
    }
    phase = "open";
    const file = await open(object.path, "wx", 0o600);
    try {
      phase = "body";
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        bytesReceived = size;
        if (size > object.size) throw new Error(`Candidate download exceeds expected size: ${object.key}`);
        phase = "write";
        await file.writeFile(chunk);
        phase = "body";
      }
      phase = "sync";
      await file.sync();
    } finally {
      await file.close();
    }
    phase = "digest";
    const actual = await inspectArtifact(object.path);
    for (const field of ["size", "sha256", "sha512", "etag", "mime"]) {
      if (actual[field] !== object[field]) throw new Error(`Candidate download ${field} mismatch: ${object.key}`);
    }
  } catch (error) {
    const memory = process.memoryUsage();
    const runtime = { platform: process.platform, arch: process.arch };
    for (const [key, value] of [["nodeVersion", process.versions.node], ["undiciVersion", process.versions.undici]]) {
      if (/^\d+\.\d+\.\d+$/.test(value ?? "")) runtime[key] = value;
    }
    const { stage, category, ...diagnostics } = safeFailure(error, "candidate");
    const details = { ...diagnostics, phase, bytesReceived,
      elapsedMs: Math.max(0, Math.floor(performance.now() - started)), runtime,
      memory: Object.fromEntries(["rss", "heapUsed", "heapTotal", "external", "arrayBuffers"].map((key) => [key, memory[key]])) };
    if (error && typeof error === "object") failureDetails.set(error, details);
    throw error;
  } finally {
    // Release rejected/unconsumed responses without masking the original gate failure.
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

export async function verifyRestoredPackages(plan, { parent, platform = process.platform, run = command, verifier, extractAsar, gate = packageGate } = {}) {
  candidateRecordPath(plan.version);
  if (platform !== "darwin") throw new Error("Continuation package verification requires macOS");
  const checks = verifier ?? await import("../verify-packaged-macos.mjs");
  const extractFile = extractAsar ?? (await import("@electron/asar")).extractFile;
  const expected = { expectedArch: "arm64", expectedVersion: plan.version };
  // Only these already-published bytes predate bundled media. Never extend this
  // historical trust path to a new candidate, even one bearing the old version.
  const historicalDigests = {
    zip: "75f4eabbea7cb30ce57bea3f65bf662bff74fc63e545c53474e9d0cc1876283a",
    dmg: "3b10dfb931750a7ea2bc989d2f602f8d03d95223923d6d6284194a4744d7c7fd",
  };
  let verifyToonFactory = checks.verifyMacToonFactoryBundle;
  if (plan.version === "1.2.31") {
    if (plan.manifest.sha256 !== "52f5df10f17b5094d088ecca2b00afa24bc892f2ce06c5b0e3e811d6173a65f6"
      || Object.entries(historicalDigests).some(([type, digest]) => plan.objects.find((item) => item.type === type)?.sha256 !== digest)) {
      throw new Error("Historical no-media trust requires the original exact 1.2.31 candidate digests");
    }
    const { verifyToonFactoryBundle } = await import("../../electron/toonFactoryBundle.mjs");
    const { verifyMacBunSignature } = createRequire(import.meta.url)("../macos-bun-signature.cjs");
    verifyToonFactory = (app, arch) => {
      const bundle = verifyToonFactoryBundle(path.join(app, "Contents/Resources/toonFactoryV2"), { platform: "darwin", arch });
      return { ...bundle, ...verifyMacBunSignature(bundle.executablePath), historicalNoMedia: "exact-1.2.31-candidate-only" };
    };
  }
  const results = {};
  for (const type of ["zip", "dmg"]) {
    const object = plan.objects.find((item) => item.type === type);
    const directory = await gate(`${type}.prepare`, () => mkdtemp(path.join(parent, `${type}-`)));
    let mounted = false;
    try {
      if (type === "zip") await gate("zip.extract", () => run("ditto", ["-x", "-k", object.path, directory]));
      else {
        await gate("dmg.mount", () => {
          run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", directory, object.path]);
          mounted = true;
        });
      }
      const app = await gate(`${type}.inventory`, async () => {
        const apps = (await readdir(directory, { withFileTypes: true })).filter((item) => item.isDirectory() && item.name.endsWith(".app"));
        if (apps.length !== 1) throw new Error("Container must contain exactly one top-level App");
        return path.join(directory, apps[0].name);
      });
      const metadata = await gate(`${type}.metadata`, () => checks.verifyBundleMetadata(app, expected.expectedVersion));
      const signature = await gate(`${type}.signature`, () => checks.verifyCodeSignature(app));
      const architecture = await gate(`${type}.architecture`, () => checks.verifyMachOArchitectures(app, expected.expectedArch));
      const toonFactory = await gate(`${type}.toon`, () => {
        const bundle = verifyToonFactory(app, "arm64");
        if (plan.version !== "1.2.31" && (bundle?.mediaTools?.manifest?.phase !== "signed"
          || bundle.mediaTools.manifest.signingTeam !== "H7PDHSK3C7")) throw new Error("Current candidate requires verified signed media tools");
        return bundle;
      });
      const updater = await gate(`${type}.updater`, () => checks.verifyPackagedUpdaterConfiguration(app));
      const trust = await gate(`${type}.apple-trust`, () => {
        const result = checks.verifyAppleTrust(app);
        if (result.notarization.status !== "accepted" || result.staple.status !== "validated" || result.gatekeeper.status !== "accepted") {
          throw new Error("Restored App notarization, staple, or Gatekeeper verification failed");
        }
        return result;
      });
      await gate(`${type}.runtime-version`, () => {
        const asar = path.join(app, "Contents", "Resources", "app.asar");
        for (const file of ["package.json", "server/package.json"]) {
          if (JSON.parse(extractFile(asar, file).toString("utf8")).version !== plan.version) throw new Error("Restored runtime package version mismatch");
        }
      });
      results[type] = { metadata, signature, architecture, toonFactory, updater, trust };
    } finally {
      // A failed detach must fail closed; never recursively delete a mounted volume.
      if (mounted) await gate("dmg.detach", () => run("hdiutil", ["detach", directory]));
      await gate(`${type}.cleanup`, () => rm(directory, { recursive: true, force: true }));
    }
  }
  const dmg = await gate("dmg.outer-trust", () => {
    const result = checks.verifyDmgTrust(plan.objects.find((item) => item.type === "dmg").path);
    if (result.signature.status !== "accepted" || result.signature.teamIdentifier !== "H7PDHSK3C7"
      || result.notarization.status !== "accepted" || result.staple.status !== "validated"
      || result.gatekeeper.status !== "accepted" || result.image.status !== "verified") throw new Error("Restored outer DMG trust verification failed");
    return result;
  });
  return { producer: "qiniu-promotion-continuation", status: "verified", ...results, dmgTrust: dmg };
}

export async function continuePromotion({ record, recordSha256, toolingCommit, directory, actor, qiniu,
  fetchImpl, verifyPackages = verifyRestoredPackages, verificationOnly = false, standingPolicy = "", now = () => new Date(), persist = replaceEvidence }) {
  if (typeof verificationOnly !== "boolean") throw new Error("verificationOnly must be boolean");
  const plan = candidatePlan(record, directory, { standingPolicy });
  const { candidateRecord, exceptions } = continuationPolicy(plan.version, { standingPolicy, releasePolicy: record.releasePolicy });
  const evidencePath = path.join(directory, "release-evidence.json");
  let evidence = structuredClone(record.evidence);
  evidence = withEvidenceResults(evidence, { continuation: {
    candidateRecord, recordSha256, sourceCommit: record.sourceCommit, toolingCommit, receipts: record.receipts,
    ...(standingPolicy ? { releasePolicy: record.releasePolicy } : {}),
    expectedPreviousChannelDigest: record.expectedPreviousChannelDigest, actor, verificationOnly, status: "started", checkpoints: [],
  } }, now().toISOString());
  await writeEvidence(evidencePath, evidence);
  let firstFailure;
  const gate = async (stage, operation) => {
    if (!STAGES.has(stage)) throw safeError(safeFailure(null, "packages.verify"));
    const checkpoint = async (phase) => {
      evidence = withEvidenceResults(evidence, { continuation: { ...evidence.continuation,
        checkpoints: [...evidence.continuation.checkpoints, { stage, phase, at: now().toISOString() }].slice(-128),
      } }, now().toISOString());
      try { await persist(evidencePath, evidence); }
      catch (error) { throw safeError(safeFailure(error, "evidence.persist")); }
    };
    try {
      await checkpoint("before");
      const result = await operation();
      await checkpoint("after");
      return result;
    } catch (error) {
      firstFailure ??= safeFailure(error, stage);
      throw safeError(firstFailure);
    }
  };
  try {
    for (const object of [...plan.objects, plan.manifest]) {
      await gate(`download.${object.type}`, () => downloadCandidateObject(object, { fetchImpl }));
    }
    await gate("manifest.validate", async () => {
      const bytes = await readFile(plan.manifest.path);
      validateMacManifest({ ...plan, artifacts: plan.objects, manifest: parseYaml(bytes.toString("utf8")) });
      plan.manifest.content = bytes;
    });
    const verification = await gate("packages.verify", async () => {
      const result = await verifyPackages(plan, { parent: directory, gate });
      if (result?.status !== "verified") throw new Error("Continuation package verification did not pass");
      return result;
    });
    const cdn = await gate("cdn.fresh", () => verifyCdn(plan, { qiniu, fetchImpl }));
    evidence = withEvidenceResults(evidence, {
      continuation: { ...evidence.continuation, verification, status: "verified" },
      workflow: { cdn: { status: "verified", ...cdn, verifiedAt: now().toISOString() } },
    }, now().toISOString());
    await gate("evidence.persist", () => persist(evidencePath, evidence));
    // Read-only diagnostics ends here, before even resolving refresh or touching a lock.
    if (verificationOnly) return { status: "verified", verificationOnly: true };
    return await gate("promotion", () => promoteChannel(plan, evidence, {
      qiniu, refresh: qiniu.refresh.bind(qiniu), fetchImpl, actor, now, ...exceptions,
      expectedPreviousChannelDigest: record.expectedPreviousChannelDigest,
      onPromotionVerified: async (result) => {
        evidence = withEvidenceResults(evidence, {
          ...(result.releasePolicy ? { releasePolicy: result.releasePolicy } : {}),
          continuation: { ...evidence.continuation, status: "promoted" },
          workflow: { ...result.workflow, promotion: { ...result, workflow: undefined, status: "verified", promotedAt: now().toISOString() } },
        }, now().toISOString());
        assertRecordedPromotion(plan, evidence);
        await persist(evidencePath, evidence);
        assertRecordedPromotion(plan, JSON.parse(await readFile(evidencePath, "utf8")));
      },
    }));
  } catch (error) {
    const failure = firstFailure ?? safeFailure(error, "evidence.persist");
    evidence = withEvidenceResults(evidence, {
      continuation: { ...evidence.continuation, status: "failed", failure },
      ...(evidence.workflow.promotion ? { workflow: { promotion: { ...evidence.workflow.promotion, status: "failed" } } } : {}),
    }, now().toISOString());
    try { await persist(evidencePath, evidence); }
    catch (persistError) { throw safeError(safeFailure(persistError, "evidence.persist")); }
    throw safeError(failure);
  }
}

export async function main({ argv = process.argv.slice(2), environment = process.env, root = process.cwd(),
  loadCandidate = loadCommittedCandidate, adapter = createQshellAdapter, continueRelease = continuePromotion } = {}) {
  if (argv.some((arg) => !["--validate-only", "--verify-only"].includes(arg)) || argv.length > 1) throw new Error("Only --validate-only or --verify-only is supported");
  const verificationOnly = argv[0] === "--verify-only";
  // Standalone --verify-only is safe by construction; explicit workflow flags must agree.
  const context = { ...environment, VERIFICATION_ONLY: environment.VERIFICATION_ONLY ?? (verificationOnly ? "true" : "false") };
  if (argv[0] !== "--validate-only" && (context.VERIFICATION_ONLY === "true") !== verificationOnly) throw new Error("CLI and verification_only input disagree");
  assertContinuationInputs(context);
  const candidate = await loadCandidate({ root, environment: context });
  if (argv[0] === "--validate-only") return;
  if (!environment.RUNNER_TEMP) throw new Error("RUNNER_TEMP is required");
  // The workflow creates this private directory before invoking the continuation.
  const directory = path.join(environment.RUNNER_TEMP, "qiniu-promotion-continuation");
  await continueRelease({ ...candidate, directory, verificationOnly,
    actor: `github-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}`,
    qiniu: adapter({ bucket: DEFAULT_BUCKET }),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ continuation: "failed", failure: safeFailure(error, "candidate") })}\n`);
    process.exitCode = 1;
  });
}
