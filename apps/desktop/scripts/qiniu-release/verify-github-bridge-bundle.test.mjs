import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createReleasePlan } from "./plan.mjs";
import {
  CANARY_SCHEMA,
  EXPECTED_BUNDLE_ID,
  EXPECTED_TEAM_ID,
  LOCAL_VERIFICATION_SCHEMA,
  createEvidence,
  withEvidenceResults,
} from "./evidence.mjs";
import { recordGitHubBridgeEvidence, verifyGitHubBridgeBundle } from "./verify-github-bridge-bundle.mjs";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jugglework-github-bridge-"));
  for (const [extension, content] of [["zip", "zip"], ["zip.blockmap", "zip-blockmap"], ["dmg", "dmg"], ["dmg.blockmap", "dmg-blockmap"]]) {
    await writeFile(path.join(directory, `jugglework-mac-arm64-1.2.15.${extension}`), content);
  }
  const plan = await createReleasePlan({ version: "1.2.15", channel: "stable", platform: "mac", architectures: ["arm64"], dist: directory });
  await writeFile(path.join(directory, "qiniu-v1.2.15-latest-mac.yml"), plan.manifest.content);
  const localVerification = {
    schema: LOCAL_VERIFICATION_SCHEMA, schemaVersion: 1, producer: "verify-packaged-macos", version: plan.version, platform: "mac",
    architectures: plan.architectures, verifiedAt: "2026-09-08T00:00:00.000Z", releaseState: "release", credentialState: "available",
    identity: { bundleIdentifier: EXPECTED_BUNDLE_ID, teamIdentifier: EXPECTED_TEAM_ID },
    codesign: { status: "accepted", deep: true, strict: true }, hardenedRuntime: { status: "enabled" },
    notarization: { status: "accepted", submissionId: "notary-id" }, staple: { status: "validated" }, gatekeeper: { status: "accepted" },
    artifacts: plan.objects.map((object) => ({ name: object.name, size: object.size, sha256: object.sha256, sha512: object.sha512, etag: object.etag })),
    manifest: { name: "latest-mac.yml", size: plan.manifest.size, sha256: plan.manifest.sha256, sha512: plan.manifest.sha512, etag: plan.manifest.etag },
  };
  const canary = {
    schema: CANARY_SCHEMA, schemaVersion: 1, producer: "jugglework-macos-update-canary", result: "passed", channel: "stable",
    sourceVersion: "1.2.14", targetVersion: "1.2.15", feedUrl: plan.manifest.url, architectures: ["arm64"],
    manifestSha256: plan.manifest.sha256, runId: "canary-1", verifiedAt: "2026-09-08T01:00:00.000Z",
    checks: { cleanClient: "passed", updateDiscovered: "passed", download: "passed", install: "passed", restart: "passed", installedVersion: "1.2.15", userData: "preserved", workspaceAccess: "preserved", permissions: "preserved" },
    network: { manifestOrigin: "https://downloads.jugglechat.cn", artifactOrigin: "https://downloads.jugglechat.cn" },
  };
  const objects = [...plan.objects, plan.manifest];
  const qiniuChecks = objects.map((object) => ({ key: object.key, size: object.size, etag: object.etag, verified: true }));
  const cdnChecks = objects.map((object) => ({ key: object.key, url: object.url, https: true, range: true, mime: object.mime, contentLength: object.size, size: object.size, sha256: object.sha256, sha512: object.sha512 }));
  const evidence = withEvidenceResults(createEvidence({ plan, commit: "abc123", localVerification, canary, timestamps: { createdAt: "2026-09-08T00:00:00.000Z" } }), {
    workflow: {
      immutable: { status: "verified", verifiedAt: "2026-09-08T02:00:00.000Z", qiniuChecks },
      cdn: { status: "verified", verifiedAt: "2026-09-08T03:00:00.000Z", qiniuChecks, cdnChecks },
      promotion: { status: "verified", channelKey: plan.channelManifest.key, readBack: { sha256: plan.manifest.sha256, size: plan.manifest.size }, promotedAt: "2026-09-08T04:00:00.000Z" },
    },
  }, "2026-09-08T04:00:00.000Z");
  await writeFile(path.join(directory, "qiniu-release-evidence.json"), `${JSON.stringify(evidence)}\n`);
  return { directory, plan, evidence };
}

test("verifies promoted Qiniu evidence and copies the exact manifest bytes", async () => {
  const { directory, plan } = await fixture();
  try {
    const output = path.join(directory, "latest-mac.yml");
    await verifyGitHubBridgeBundle({ directory, outputManifest: output });
    assert.equal(await readFile(output, "utf8"), plan.manifest.content);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects evidence without exact stable promotion read-back", async () => {
  const { directory, evidence } = await fixture();
  try {
    evidence.workflow.promotion.readBack.sha256 = "0".repeat(64);
    await writeFile(path.join(directory, "qiniu-release-evidence.json"), `${JSON.stringify(evidence)}\n`);
    await assert.rejects(verifyGitHubBridgeBundle({ directory }), /verified stable Qiniu promotion/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects mutated retained artifacts before GitHub upload", async () => {
  const { directory } = await fixture();
  try {
    await writeFile(path.join(directory, "jugglework-mac-arm64-1.2.15.zip"), "mutated");
    await assert.rejects(verifyGitHubBridgeBundle({ directory }), /evidence (?:artifact|manifest)|artifact digest/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("records only the fixed bridge tag and a numeric GitHub release ID", async () => {
  const { directory } = await fixture();
  try {
    const evidence = await recordGitHubBridgeEvidence({
      directory,
      releaseId: "12345",
      now: "2026-09-08T05:00:00.000Z",
    });
    assert.deepEqual(evidence.bridge, { githubReleaseId: "12345", githubTag: "v1.2.15" });
    assert.equal(JSON.parse(await readFile(path.join(directory, "qiniu-release-evidence.json"), "utf8")).bridge.githubReleaseId, "12345");
    await assert.rejects(recordGitHubBridgeEvidence({ directory, releaseId: "not-numeric" }), /must be numeric/);
    await assert.rejects(recordGitHubBridgeEvidence({ directory, releaseId: "12345", tag: "v1.2.16" }), /Unsupported GitHub bridge tag/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
