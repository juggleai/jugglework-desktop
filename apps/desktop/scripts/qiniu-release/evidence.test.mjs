import assert from "node:assert/strict";
import test from "node:test";

import {
  CANARY_SCHEMA,
  EVIDENCE_SCHEMA,
  EXPECTED_BUNDLE_ID,
  EXPECTED_TEAM_ID,
  LOCAL_VERIFICATION_SCHEMA,
  assertLocalVerification,
  assertNoSecrets,
  assertPromotionEvidence,
  createEvidence,
  redactSecrets,
  withEvidenceResults,
} from "./evidence.mjs";
import { metadataForBuffer } from "./metadata.mjs";

function plan() {
  const artifact = { name: "app.zip", key: "jugglework/releases/v1.2.15/mac/arm64/app.zip", url: "https://downloads.jugglechat.cn/jugglework/releases/v1.2.15/mac/arm64/app.zip", mime: "application/zip", ...metadataForBuffer("zip", "app.zip") };
  const manifest = { key: "jugglework/releases/v1.2.15/mac/latest-mac.yml", url: "https://downloads.jugglechat.cn/jugglework/releases/v1.2.15/mac/latest-mac.yml", mime: "text/yaml", ...metadataForBuffer("version: 1.2.15\n", "latest.yml") };
  return { version: "1.2.15", channel: "stable", platform: "mac", architectures: ["arm64"], objects: [artifact], manifest };
}

function localVerification(releasePlan = plan(), overrides = {}) {
  return {
    schema: LOCAL_VERIFICATION_SCHEMA,
    schemaVersion: 1,
    producer: "verify-packaged-macos",
    version: releasePlan.version,
    platform: "mac",
    architectures: releasePlan.architectures,
    verifiedAt: "2026-09-08T00:00:00.000Z",
    releaseState: "release",
    credentialState: "available",
    identity: { bundleIdentifier: EXPECTED_BUNDLE_ID, teamIdentifier: EXPECTED_TEAM_ID },
    codesign: { status: "accepted", deep: true, strict: true },
    hardenedRuntime: { status: "enabled" },
    notarization: { status: "accepted", submissionId: "submission-id" },
    staple: { status: "validated" },
    gatekeeper: { status: "accepted" },
    artifacts: releasePlan.objects.map((object) => ({
      name: object.name,
      size: object.size,
      sha256: object.sha256,
      sha512: object.sha512,
      etag: object.etag,
    })),
    manifest: {
      name: "latest-mac.yml",
      size: releasePlan.manifest.size,
      sha256: releasePlan.manifest.sha256,
      sha512: releasePlan.manifest.sha512,
      etag: releasePlan.manifest.etag,
    },
    ...overrides,
  };
}

function canary() {
  return {
    schema: CANARY_SCHEMA,
    schemaVersion: 1,
    producer: "jugglework-macos-update-canary",
    result: "passed",
    channel: "stable",
    sourceVersion: "1.2.14",
    targetVersion: "1.2.15",
    feedUrl: "https://downloads.jugglechat.cn/jugglework/releases/v1.2.15/mac/latest-mac.yml",
    architectures: ["arm64"],
    manifestSha256: plan().manifest.sha256,
    runId: "canary-123",
    verifiedAt: "2026-09-08T01:00:00.000Z",
    checks: {
      cleanClient: "passed", updateDiscovered: "passed", download: "passed", install: "passed", restart: "passed",
      installedVersion: "1.2.15", userData: "preserved", workspaceAccess: "preserved", permissions: "preserved",
    },
    network: { manifestOrigin: "https://downloads.jugglechat.cn", artifactOrigin: "https://downloads.jugglechat.cn" },
  };
}

function promotionEvidence() {
  const releasePlan = plan();
  const checks = [...releasePlan.objects, releasePlan.manifest].map((item) => ({ key: item.key, size: item.size, etag: item.etag }));
  const cdnChecks = [...releasePlan.objects, releasePlan.manifest].map((item) => ({
    key: item.key, url: item.url, https: true, range: true, mime: item.mime, contentLength: item.size,
    size: item.size, sha256: item.sha256, sha512: item.sha512,
  }));
  return withEvidenceResults(createEvidence({ plan: releasePlan, commit: "abc123", localVerification: localVerification(releasePlan), canary: canary(), timestamps: { createdAt: "2026-09-08T00:00:00.000Z" } }), {
    workflow: {
      immutable: { status: "verified", verifiedAt: "2026-09-08T02:00:00.000Z", qiniuChecks: checks },
      cdn: { status: "verified", verifiedAt: "2026-09-08T03:00:00.000Z", qiniuChecks: checks, cdnChecks },
    },
  }, "2026-09-08T03:00:00.000Z");
}

test("recursively rejects and redacts broad secret-like evidence key names", () => {
  for (const key of ["accessKey", "secretKey", "token", "cookie", "password", "privateKey", "apiKey", "clientSecret", "authorization", "sessionToken", "refresh_token"]) {
    assert.throws(() => assertNoSecrets({ safe: [{ nested: { [key]: "do-not-record" } }] }), /secret-like keys/);
    assert.equal(redactSecrets({ [key]: "secret" })[key], "[REDACTED]");
  }
});

test("creates versioned evidence without converting absent external results into success", () => {
  const evidence = createEvidence({ plan: plan(), commit: "abc123", timestamps: { createdAt: "2026-09-08T00:00:00.000Z" } });
  assert.equal(evidence.schema, EVIDENCE_SCHEMA);
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.localVerification, null);
  assert.equal(evidence.canary, null);
  assert.equal(evidence.workflow.local, null);
  assert.equal(evidence.workflow.immutable, null);
});

test("stable promotion accepts only exact machine verification and canary contracts", () => {
  assert.equal(assertPromotionEvidence(plan(), promotionEvidence()).schemaVersion, 2);
  assert.throws(() => assertPromotionEvidence(plan(), { ...promotionEvidence(), schemaVersion: 1 }), /schema or version/);
  const wrongTeam = promotionEvidence();
  wrongTeam.localVerification.identity.teamIdentifier = "WRONGTEAM";
  assert.throws(() => assertPromotionEvidence(plan(), wrongTeam), /identities/);
  const selfAsserted = promotionEvidence();
  selfAsserted.localVerification = null;
  selfAsserted.gates = { codesignVerified: true, notarized: true, canaryPassed: true };
  assert.throws(() => assertPromotionEvidence(plan(), selfAsserted), /Local verification schema/);
});

test("candidate and missing-credential states can be recorded but never authorize stable promotion", () => {
  const candidate = localVerification(plan(), { releaseState: "candidate", notarization: { status: "unavailable", reason: "credentials-unavailable" } });
  assert.equal(assertLocalVerification(plan(), candidate, { stable: false }).releaseState, "candidate");
  const evidence = promotionEvidence();
  evidence.localVerification = candidate;
  assert.throws(() => assertPromotionEvidence(plan(), evidence), /rejects candidate/);

  const missingCredentials = promotionEvidence();
  missingCredentials.localVerification.credentialState = "missing";
  assert.throws(() => assertPromotionEvidence(plan(), missingCredentials), /credential state/);
});

test("accepted notarization without an Apple submission ID cannot authorize stable promotion", () => {
  const evidence = promotionEvidence();
  evidence.localVerification.notarization = { status: "accepted", submissionId: "" };
  assert.throws(() => assertPromotionEvidence(plan(), evidence), /accepted notarization/);
});

test("local verification is bound to exact artifact and manifest digests", () => {
  const artifactMismatch = promotionEvidence();
  artifactMismatch.localVerification.artifacts[0].sha256 = "0".repeat(64);
  assert.throws(() => assertPromotionEvidence(plan(), artifactMismatch), /artifact digest/);
  const manifestMismatch = promotionEvidence();
  manifestMismatch.localVerification.manifest.sha256 = "0".repeat(64);
  assert.throws(() => assertPromotionEvidence(plan(), manifestMismatch), /manifest digest/);
});

test("canary source must be semantically older than the target", () => {
  const evidence = promotionEvidence();
  evidence.canary.sourceVersion = "1.2.16-alpha.1";
  assert.throws(() => assertPromotionEvidence(plan(), evidence), /semantically older/);
});

test("canary and evidence bind to the exact immutable manifest", () => {
  const canaryMismatch = promotionEvidence();
  canaryMismatch.canary.manifestSha256 = "0".repeat(64);
  assert.throws(() => assertPromotionEvidence(plan(), canaryMismatch), /manifest digest/);
  const evidenceMismatch = promotionEvidence();
  evidenceMismatch.manifest.size += 1;
  assert.throws(() => assertPromotionEvidence(plan(), evidenceMismatch), /manifest does not match/);
});
