import { spawnSync } from "node:child_process";
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

export const CANDIDATE_RECORD = "apps/desktop/release-records/1.2.31-candidate.json";
export const CANDIDATE_SCHEMA = "com.juggleai.jugglework.promotion-candidate";
export const EXCEPTIONS = Object.freeze({
  preCanaryExceptionReason: "Operator explicitly authorized stable macOS arm64 1.2.31 to skip only the real-client upgrade canary",
  metadataExceptionReason: "Operator explicitly authorized stable macOS arm64 1.2.31 to skip only Qiniu Cache-Control metadata mutation and validation",
});
const VERSION = "1.2.31";
const PACKAGES = ["apps/app/package.json", "apps/desktop/package.json", "apps/server/package.json"];
const TYPES = ["zip", "dmg", "zip.blockmap", "dmg.blockmap"];

function command(binary, args, cwd) {
  const result = spawnSync(binary, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  // Never surface subprocess output: a repository or runner error may contain private data.
  if (result.error || result.status !== 0) throw new Error(`${binary} ${args[0]} failed`);
  return result.stdout;
}

export function assertContinuationInputs(environment) {
  if (environment.GITHUB_ACTIONS !== "true" || environment.GITHUB_EVENT_NAME !== "workflow_dispatch"
    || environment.GITHUB_REF !== "refs/heads/dev" || !/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA ?? "")
    || environment.RELEASE_MODE !== "promotion-only" || environment.VERSION !== VERSION
    || environment.CHANNEL !== "stable" || environment.RELEASE_PLATFORM !== "mac" || environment.PROMOTE !== "true") {
    throw new Error("Continuation requires workflow_dispatch on dev for promotion-only stable/mac/arm64/1.2.31 with promote=true");
  }
  if (environment.CANDIDATE_RECORD !== CANDIDATE_RECORD) throw new Error("Candidate record path is fixed");
}

export function candidatePlan(record, dist) {
  assertNoSecrets(record);
  if (record?.schema !== CANDIDATE_SCHEMA || record.schemaVersion !== 1
    || !/^[a-f0-9]{40}$/.test(record.sourceCommit ?? "") || record.evidence?.commit !== record.sourceCommit
    || !/^[a-f0-9]{64}$/.test(record.expectedPreviousChannelDigest ?? "")) {
    throw new Error("Invalid candidate schema, exact source commit, or approved predecessor digest");
  }
  const evidence = record.evidence;
  if (evidence.version !== VERSION || evidence.channel !== "stable" || evidence.platform !== "mac"
    || JSON.stringify(evidence.architectures) !== '["arm64"]' || evidence.artifacts?.length !== 4
    || evidence.workflow?.promotion != null) throw new Error("Candidate must be an unpromoted stable/mac/arm64/1.2.31 release");
  const objects = TYPES.map((type) => {
    const name = `jugglework-mac-arm64-${VERSION}.${type}`;
    const key = artifactKey(VERSION, "arm64", name, "mac");
    const matches = evidence.artifacts.filter((item) => item.key === key && item.name === name);
    if (matches.length !== 1) throw new Error(`Candidate inventory mismatch: ${name}`);
    const item = matches[0];
    if (item.url !== undefined && item.url !== publicUrl(key)) throw new Error("Unapproved artifact URL");
    return { ...item, name, key, type, arch: "arm64", path: path.join(dist, name), url: publicUrl(key) };
  });
  const manifestKey = versionManifestKey(VERSION, "mac");
  const manifest = {
    ...evidence.manifest, name: "latest-mac.yml", type: "manifest", key: manifestKey,
    url: publicUrl(manifestKey), path: path.join(dist, `qiniu-v${VERSION}-latest-mac.yml`),
  };
  for (const item of [...objects, manifest]) {
    if (!Number.isSafeInteger(item.size) || item.size <= 0 || !/^[a-f0-9]{64}$/.test(item.sha256 ?? "")
      || !isCanonicalSha512(item.sha512) || !/^[A-Za-z0-9_-]{28}$/.test(item.etag ?? "")
      || item.mime !== metadataForBuffer("", item.name).mime) throw new Error("Invalid candidate object metadata");
  }
  const plan = {
    version: VERSION, channel: "stable", platform: "mac", architectures: ["arm64"],
    objects: normalizeArtifacts({ version: VERSION, platform: "mac", artifacts: objects }), manifest,
    channelManifest: { key: channelManifestKey("stable", "mac"), url: publicUrl(channelManifestKey("stable", "mac")) },
  };
  assertPromotionEvidence(plan, evidence, EXCEPTIONS);
  for (const [type, schema, producer, submissionId] of [
    ["app", "com.juggleai.jugglework.macos-notarization-receipt", "electron-after-sign", evidence.localVerification.notarization.submissionId],
    ["dmg", "com.juggleai.jugglework.macos-dmg-notarization-receipt", "finalize-macos-artifacts", evidence.localVerification.dmg.notarization.submissionId],
  ]) {
    const receipt = record.receipts?.[type];
    if (receipt?.schema !== schema || receipt.schemaVersion !== 1 || receipt.producer !== producer
      || receipt.version !== VERSION || receipt.submissionId !== submissionId || receipt.status !== "accepted"
      || receipt.staple !== "validated" || !Number.isFinite(Date.parse(receipt.createdAt))
      || (type === "app" && receipt.bundleIdentifier !== "com.juggleai.jugglework")
      || (type === "dmg" && (receipt.teamIdentifier !== "H7PDHSK3C7" || receipt.gatekeeper !== "accepted"
        || receipt.architecture !== "arm64" || receipt.artifactName !== `jugglework-mac-arm64-${VERSION}.dmg`))) {
      throw new Error(`Missing or mismatched original ${type} notarization receipt`);
    }
  }
  if (record.expectedPreviousChannelDigest === manifest.sha256) throw new Error("Predecessor must differ from candidate");
  return plan;
}

export async function loadCommittedCandidate({ root, environment = process.env,
  git = (args) => args[0] === "show" ? command("git", args, root) : command("git", args, root).trim() }) {
  assertContinuationInputs(environment);
  const sha = environment.GITHUB_SHA;
  if (git(["rev-parse", "HEAD"]) !== sha || git(["rev-parse", "origin/dev"]) !== sha) {
    throw new Error("Checkout HEAD and origin/dev must exactly match github.sha");
  }
  const committed = git(["show", `${sha}:${CANDIDATE_RECORD}`]);
  const record = JSON.parse(committed);
  candidatePlan(record, root);
  git(["merge-base", "--is-ancestor", record.sourceCommit, sha]);
  for (const file of PACKAGES) {
    if (JSON.parse(git(["show", `${record.sourceCommit}:${file}`])).version !== VERSION
      || JSON.parse(git(["show", `${sha}:${file}`])).version !== VERSION
      || JSON.parse(await readFile(path.join(root, file), "utf8")).version !== VERSION) {
      throw new Error(`Runtime package version must be ${VERSION}: ${file}`);
    }
  }
  if ((await readFile(path.join(root, CANDIDATE_RECORD), "utf8")) !== committed) {
    throw new Error("Working candidate differs from committed candidate");
  }
  return { record, recordSha256: metadataForBuffer(committed, "candidate.json").sha256, toolingCommit: sha };
}

export async function downloadCandidateObject(object, { fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(object.url, { redirect: "error", signal: AbortSignal.timeout(600_000) });
  if (response.status !== 200 || response.headers.get("content-length") !== String(object.size)
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== object.mime || !response.body) {
    throw new Error(`Candidate download metadata mismatch: ${object.key}`);
  }
  const file = await open(object.path, "wx", 0o600);
  try {
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > object.size) throw new Error(`Candidate download exceeds expected size: ${object.key}`);
      await file.writeFile(chunk);
    }
    await file.sync();
  } finally {
    await file.close();
  }
  const actual = await inspectArtifact(object.path);
  for (const field of ["size", "sha256", "sha512", "etag", "mime"]) {
    if (actual[field] !== object[field]) throw new Error(`Candidate download ${field} mismatch: ${object.key}`);
  }
}

export async function verifyRestoredPackages(plan, { parent, platform = process.platform, run = command, verifier, extractAsar } = {}) {
  if (platform !== "darwin") throw new Error("Continuation package verification requires macOS");
  const checks = verifier ?? await import("../verify-packaged-macos.mjs");
  const extractFile = extractAsar ?? (await import("@electron/asar")).extractFile;
  const expected = { expectedArch: "arm64", expectedVersion: VERSION };
  const results = {};
  for (const type of ["zip", "dmg"]) {
    const object = plan.objects.find((item) => item.type === type);
    const directory = await mkdtemp(path.join(parent, `${type}-`));
    let mounted = false;
    try {
      if (type === "zip") run("ditto", ["-x", "-k", object.path, directory]);
      else {
        run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", directory, object.path]);
        mounted = true;
      }
      const apps = (await readdir(directory, { withFileTypes: true })).filter((item) => item.isDirectory() && item.name.endsWith(".app"));
      if (apps.length !== 1) throw new Error("Container must contain exactly one top-level App");
      const app = path.join(directory, apps[0].name);
      const metadata = checks.verifyBundleMetadata(app, expected.expectedVersion);
      const signature = checks.verifyCodeSignature(app);
      const architecture = checks.verifyMachOArchitectures(app, expected.expectedArch);
      const toonFactory = checks.verifyMacToonFactoryBundle(app, "arm64");
      const updater = checks.verifyPackagedUpdaterConfiguration(app);
      const trust = checks.verifyAppleTrust(app);
      if (trust.notarization.status !== "accepted" || trust.staple.status !== "validated" || trust.gatekeeper.status !== "accepted") {
        throw new Error("Restored App notarization, staple, or Gatekeeper verification failed");
      }
      const asar = path.join(app, "Contents", "Resources", "app.asar");
      for (const file of ["package.json", "server/package.json"]) {
        if (JSON.parse(extractFile(asar, file).toString("utf8")).version !== VERSION) throw new Error("Restored runtime package version mismatch");
      }
      results[type] = { metadata, signature, architecture, toonFactory, updater, trust };
    } finally {
      // A failed detach must fail closed; never recursively delete a mounted volume.
      if (mounted) run("hdiutil", ["detach", directory]);
      await rm(directory, { recursive: true, force: true });
    }
  }
  const dmg = checks.verifyDmgTrust(plan.objects.find((item) => item.type === "dmg").path);
  if (dmg.signature.status !== "accepted" || dmg.signature.teamIdentifier !== "H7PDHSK3C7"
    || dmg.notarization.status !== "accepted" || dmg.staple.status !== "validated"
    || dmg.gatekeeper.status !== "accepted" || dmg.image.status !== "verified") throw new Error("Restored outer DMG trust verification failed");
  return { producer: "qiniu-promotion-continuation", status: "verified", ...results, dmgTrust: dmg };
}

export async function continuePromotion({ record, recordSha256, toolingCommit, directory, actor, qiniu,
  fetchImpl, verifyPackages = verifyRestoredPackages, now = () => new Date(), persist = replaceEvidence }) {
  const plan = candidatePlan(record, directory);
  const evidencePath = path.join(directory, "release-evidence.json");
  let evidence = structuredClone(record.evidence);
  evidence = withEvidenceResults(evidence, { continuation: {
    candidateRecord: CANDIDATE_RECORD, recordSha256, sourceCommit: record.sourceCommit, toolingCommit, receipts: record.receipts,
    expectedPreviousChannelDigest: record.expectedPreviousChannelDigest, actor, status: "started",
  } }, now().toISOString());
  await writeEvidence(evidencePath, evidence);
  try {
    for (const object of [...plan.objects, plan.manifest]) await downloadCandidateObject(object, { fetchImpl });
    const bytes = await readFile(plan.manifest.path);
    validateMacManifest({ ...plan, artifacts: plan.objects, manifest: parseYaml(bytes.toString("utf8")) });
    plan.manifest.content = bytes;
    const verification = await verifyPackages(plan, { parent: directory });
    if (verification?.status !== "verified") throw new Error("Continuation package verification did not pass");
    const cdn = await verifyCdn(plan, { qiniu, fetchImpl });
    evidence = withEvidenceResults(evidence, {
      continuation: { ...evidence.continuation, verification, status: "verified" },
      workflow: { cdn: { status: "verified", ...cdn, verifiedAt: now().toISOString() } },
    }, now().toISOString());
    await persist(evidencePath, evidence);
    return await promoteChannel(plan, evidence, {
      qiniu, refresh: qiniu.refresh.bind(qiniu), fetchImpl, actor, now, ...EXCEPTIONS,
      expectedPreviousChannelDigest: record.expectedPreviousChannelDigest,
      onPromotionVerified: async (result) => {
        evidence = withEvidenceResults(evidence, {
          continuation: { ...evidence.continuation, status: "promoted" },
          workflow: { promotion: { ...result, status: "verified", promotedAt: now().toISOString() } },
        }, now().toISOString());
        assertRecordedPromotion(plan, evidence);
        await persist(evidencePath, evidence);
        assertRecordedPromotion(plan, JSON.parse(await readFile(evidencePath, "utf8")));
      },
    });
  } catch (error) {
    evidence = withEvidenceResults(evidence, {
      continuation: { ...evidence.continuation, status: "failed" },
      ...(evidence.workflow.promotion ? { workflow: { promotion: { ...evidence.workflow.promotion, status: "failed" } } } : {}),
    }, now().toISOString());
    await persist(evidencePath, evidence);
    throw error;
  }
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== "--validate-only") || process.argv.length > 3) throw new Error("Only --validate-only is supported");
  const candidate = await loadCommittedCandidate({ root: process.cwd() });
  if (process.argv[2] === "--validate-only") return;
  if (!process.env.RUNNER_TEMP) throw new Error("RUNNER_TEMP is required");
  // The workflow creates this private directory before invoking the continuation.
  const directory = path.join(process.env.RUNNER_TEMP, "qiniu-promotion-continuation");
  await continuePromotion({ ...candidate, directory,
    actor: `github-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
    qiniu: createQshellAdapter({ bucket: DEFAULT_BUCKET }),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("Promotion continuation failed; inspect retained non-secret evidence and lock state before retrying.\n");
    process.exitCode = 1;
  });
}
