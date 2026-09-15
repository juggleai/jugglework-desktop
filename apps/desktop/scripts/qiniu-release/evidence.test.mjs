import assert from "node:assert/strict";
import test from "node:test";

import {
  CANARY_SCHEMA,
  EVIDENCE_SCHEMA,
  EXPECTED_BUNDLE_ID,
  EXPECTED_TEAM_ID,
  LOCAL_VERIFICATION_SCHEMA,
  WINDOWS_CANARY_SCHEMA,
  WINDOWS_LOCAL_VERIFICATION_SCHEMA,
  assertCanary,
  assertLocalVerification,
  assertNoSecrets,
  assertPromotionEvidence,
  createEvidence,
  redactSecrets,
  withEvidenceResults,
} from "./evidence.mjs";
import { metadataForBuffer } from "./metadata.mjs";

function plan(version = "1.2.15", channel = "stable") {
  const artifact = { name: "app.zip", key: `jugglework/releases/v${version}/mac/arm64/app.zip`, url: `https://downloads.jugglechat.cn/jugglework/releases/v${version}/mac/arm64/app.zip`, mime: "application/zip", ...metadataForBuffer("zip", "app.zip") };
  const manifest = { key: `jugglework/releases/v${version}/mac/latest-mac.yml`, url: `https://downloads.jugglechat.cn/jugglework/releases/v${version}/mac/latest-mac.yml`, mime: "text/yaml", ...metadataForBuffer(`version: ${version}\n`, "latest.yml") };
  return { version, channel, platform: "mac", architectures: ["arm64"], objects: [artifact], manifest };
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

function canary(releasePlan = plan()) {
  return {
    schema: CANARY_SCHEMA,
    schemaVersion: 1,
    producer: "jugglework-macos-update-canary",
    result: "passed",
    channel: releasePlan.channel,
    sourceVersion: "1.2.14",
    targetVersion: releasePlan.version,
    feedUrl: releasePlan.manifest.url,
    architectures: ["arm64"],
    manifestSha256: releasePlan.manifest.sha256,
    runId: "canary-123",
    verifiedAt: "2026-09-08T01:00:00.000Z",
    checks: {
      cleanClient: "passed", updateDiscovered: "passed", download: "passed", install: "passed", restart: "passed",
      installedVersion: releasePlan.version, userData: "preserved", workspaceAccess: "preserved", permissions: "preserved",
    },
    network: { manifestOrigin: "https://downloads.jugglechat.cn", artifactOrigin: "https://downloads.jugglechat.cn" },
  };
}

function promotionEvidence(releasePlan = plan()) {
  const checks = [...releasePlan.objects, releasePlan.manifest].map((item) => ({ key: item.key, size: item.size, etag: item.etag }));
  const cdnChecks = [...releasePlan.objects, releasePlan.manifest].map((item) => ({
    key: item.key, url: item.url, https: true, range: true, mime: item.mime, contentLength: item.size,
    size: item.size, sha256: item.sha256, sha512: item.sha512,
  }));
  return withEvidenceResults(createEvidence({ plan: releasePlan, commit: "abc123", localVerification: localVerification(releasePlan), canary: canary(releasePlan), timestamps: { createdAt: "2026-09-08T00:00:00.000Z" } }), {
    workflow: {
      immutable: { status: "verified", verifiedAt: "2026-09-08T02:00:00.000Z", qiniuChecks: checks },
      cdn: { status: "verified", verifiedAt: "2026-09-08T03:00:00.000Z", qiniuChecks: checks, cdnChecks },
    },
  }, "2026-09-08T03:00:00.000Z");
}

function windowsPlan() {
  const version = "1.2.18";
  const objects = ["arm64", "x64"].flatMap((arch) => ["exe", "exe.blockmap"].map((type) => {
    const name = `jugglework-win-${arch}-${version}.${type}`;
    const key = `jugglework/releases/v${version}/windows/${arch}/${name}`;
    return { arch, type, name, key, url: `https://downloads.jugglechat.cn/${key}`, mime: type === "exe" ? "application/vnd.microsoft.portable-executable" : "application/octet-stream", ...metadataForBuffer(`${arch}-${type}`, name) };
  }));
  const manifest = { key: `jugglework/releases/v${version}/windows/latest.yml`, url: `https://downloads.jugglechat.cn/jugglework/releases/v${version}/windows/latest.yml`, mime: "text/yaml", ...metadataForBuffer(`version: ${version}\n`, "latest.yml") };
  return { version, channel: "stable", platform: "windows", architectures: ["arm64", "x64"], objects, manifest };
}

function windowsLocalVerification(releasePlan = windowsPlan()) {
  const approvedPublishers = ["CN=Fixture Publisher, O=Test Only, C=US"];
  const signerCertificate = {
    subject: approvedPublishers[0],
    issuer: "CN=Fixture Issuing CA",
    serialNumber: "0102030405",
    sha256Thumbprint: "A".repeat(64),
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: "2027-01-01T00:00:00.000Z",
  };
  return {
    schema: WINDOWS_LOCAL_VERIFICATION_SCHEMA,
    schemaVersion: 1,
    producer: "verify-packaged-windows",
    result: "passed",
    releaseState: "release",
    version: releasePlan.version,
    platform: "windows",
    architectures: releasePlan.architectures,
    approvedPublishers,
    verifiedAt: "2026-09-08T00:00:00.000Z",
    packagedUpdater: {
      provider: "generic",
      feedUrl: "https://downloads.jugglechat.cn/jugglework/releases/stable/windows",
      publisherNames: approvedPublishers,
    },
    artifacts: releasePlan.objects.map((object) => ({
      name: object.name, arch: object.arch, type: object.type, size: object.size, sha256: object.sha256, sha512: object.sha512, etag: object.etag,
      ...(object.type === "exe" ? {
        peArchitecture: object.arch,
        authenticode: {
          status: "valid",
          digestAlgorithm: "SHA256",
          publisher: approvedPublishers[0],
          signerCertificate: { ...signerCertificate },
          timestamp: { status: "trusted", authority: "Trusted TSA", signedAt: "2026-09-08T00:00:00.000Z" },
        },
      } : {
        postSign: {
          status: "verified",
          executableName: releasePlan.objects.find((candidate) => candidate.arch === object.arch && candidate.type === "exe").name,
          executableSha256: releasePlan.objects.find((candidate) => candidate.arch === object.arch && candidate.type === "exe").sha256,
        },
      }),
    })),
    manifest: { size: releasePlan.manifest.size, sha256: releasePlan.manifest.sha256, sha512: releasePlan.manifest.sha512, etag: releasePlan.manifest.etag },
  };
}

function windowsCanary(releasePlan = windowsPlan()) {
  return {
    schema: WINDOWS_CANARY_SCHEMA,
    schemaVersion: 1,
    producer: "jugglework-windows-update-canary",
    result: "passed",
    channel: releasePlan.channel,
    targetVersion: releasePlan.version,
    feedUrl: releasePlan.manifest.url,
    architectures: releasePlan.architectures,
    manifestSha256: releasePlan.manifest.sha256,
    verifiedAt: "2026-09-08T01:00:00.000Z",
    runs: releasePlan.architectures.map((arch) => {
      const executable = releasePlan.objects.find((object) => object.arch === arch && object.type === "exe");
      return {
        arch, result: "passed", runId: `run-${arch}`, sourceVersion: "1.2.17", targetVersion: releasePlan.version,
        machineKind: "physical", nativeArchitecture: arch, emulated: false, machineId: `machine-${arch}`,
        artifactName: executable.name, artifactSha256: executable.sha256, verifiedAt: "2026-09-08T01:00:00.000Z",
        checks: { cleanClient: "passed", updateDiscovered: "passed", download: "passed", install: "passed", restart: "passed", installedVersion: releasePlan.version, userData: "preserved", workspaceAccess: "preserved", permissions: "preserved", publisherIdentity: "passed" },
        network: { manifestOrigin: "https://downloads.jugglechat.cn", artifactOrigin: "https://downloads.jugglechat.cn" },
      };
    }),
  };
}

function windowsPromotionEvidence(releasePlan = windowsPlan()) {
  const qiniuChecks = [...releasePlan.objects, releasePlan.manifest].map((item) => ({ key: item.key, size: item.size, etag: item.etag }));
  const cdnChecks = [...releasePlan.objects, releasePlan.manifest].map((item) => ({
    key: item.key, url: item.url, https: true, range: true, mime: item.mime, contentLength: item.size,
    size: item.size, sha256: item.sha256, sha512: item.sha512,
  }));
  return withEvidenceResults(createEvidence({
    plan: releasePlan,
    commit: "abc123",
    localVerification: windowsLocalVerification(releasePlan),
    canary: windowsCanary(releasePlan),
    timestamps: { createdAt: "2026-09-08T00:00:00.000Z" },
  }), {
    workflow: {
      immutable: { status: "verified", verifiedAt: "2026-09-08T02:00:00.000Z", qiniuChecks },
      cdn: { status: "verified", verifiedAt: "2026-09-08T03:00:00.000Z", qiniuChecks, cdnChecks },
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

test("an audited notarization exception is restricted to approved stable versions and preserves every other gate", () => {
  const evidence = promotionEvidence();
  evidence.localVerification = localVerification(plan(), {
    releaseState: "candidate",
    credentialState: "missing",
    notarization: { status: "unavailable" },
    staple: { status: "unavailable" },
    gatekeeper: { status: "unavailable" },
  });
  const reason = "Operator explicitly authorized one-time unnotarized stable 1.2.15 publication";
  assert.equal(assertPromotionEvidence(plan(), evidence, { notarizationExceptionReason: reason }).schemaVersion, 2);
  assert.throws(() => assertPromotionEvidence(plan(), evidence, { notarizationExceptionReason: "too short" }), /audited reason/);
  const approvedPlan = plan("1.2.17");
  const approvedEvidence = promotionEvidence(approvedPlan);
  approvedEvidence.localVerification = localVerification(approvedPlan, {
    releaseState: "candidate",
    credentialState: "missing",
    notarization: { status: "unavailable" },
    staple: { status: "unavailable" },
    gatekeeper: { status: "unavailable" },
  });
  const approvedReason = "Operator explicitly authorized one-time unnotarized stable 1.2.17 publication";
  assert.equal(assertPromotionEvidence(approvedPlan, approvedEvidence, { notarizationExceptionReason: approvedReason }).schemaVersion, 2);
  const approvedMajorPlan = plan("2.1.18");
  const approvedMajorEvidence = promotionEvidence(approvedMajorPlan);
  approvedMajorEvidence.localVerification = localVerification(approvedMajorPlan, {
    releaseState: "candidate",
    credentialState: "missing",
    notarization: { status: "unavailable" },
    staple: { status: "unavailable" },
    gatekeeper: { status: "unavailable" },
  });
  const approvedMajorReason = "Operator explicitly authorized one-time unnotarized stable 2.1.18 publication";
  assert.equal(assertPromotionEvidence(approvedMajorPlan, approvedMajorEvidence, { notarizationExceptionReason: approvedMajorReason }).schemaVersion, 2);
  const futurePlan = plan("1.2.18");
  const futureEvidence = promotionEvidence(futurePlan);
  assert.throws(() => assertPromotionEvidence(futurePlan, futureEvidence, { notarizationExceptionReason: reason }), /restricted to stable 1\.2\.15, stable 1\.2\.16, stable 1\.2\.17, or stable 2\.1\.18/);
  const laterMajorPlan = plan("2.1.19");
  const laterMajorEvidence = promotionEvidence(laterMajorPlan);
  assert.throws(() => assertPromotionEvidence(laterMajorPlan, laterMajorEvidence, { notarizationExceptionReason: approvedMajorReason }), /restricted to stable/);
  const brokenCanary = structuredClone(evidence);
  brokenCanary.canary.result = "failed";
  assert.throws(() => assertPromotionEvidence(plan(), brokenCanary, { notarizationExceptionReason: reason }), /passed machine-generated/);
});

test("stable 1.2.16 requires two audited exceptions before a signed candidate can precede its canary", () => {
  const releasePlan = plan("1.2.16");
  const evidence = promotionEvidence(releasePlan);
  evidence.localVerification = localVerification(releasePlan, {
    releaseState: "candidate",
    credentialState: "missing",
    notarization: { status: "unavailable" },
    staple: { status: "unavailable" },
    gatekeeper: { status: "unavailable" },
  });
  evidence.canary = null;
  const notarizationReason = "Operator authorized unnotarized stable 1.2.16 for the live upgrade validation";
  const preCanaryReason = "Operator authorized exposing stable 1.2.16 before validating the live 1.2.15 upgrade";
  assert.equal(assertPromotionEvidence(releasePlan, evidence, {
    notarizationExceptionReason: notarizationReason,
    preCanaryExceptionReason: preCanaryReason,
  }).schemaVersion, 2);
  assert.throws(() => assertPromotionEvidence(releasePlan, evidence, { notarizationExceptionReason: notarizationReason }), /Canary schema|machine-generated macOS update canary/);
  assert.throws(() => assertPromotionEvidence(releasePlan, evidence, { preCanaryExceptionReason: preCanaryReason }), /credential state|rejects candidate/);
  assert.throws(() => assertPromotionEvidence(releasePlan, evidence, {
    notarizationExceptionReason: notarizationReason,
    preCanaryExceptionReason: "too short",
  }), /audited reason/);

  const failedCanary = structuredClone(evidence);
  failedCanary.canary = canary(releasePlan);
  failedCanary.canary.result = "failed";
  assert.throws(() => assertPromotionEvidence(releasePlan, failedCanary, {
    notarizationExceptionReason: notarizationReason,
    preCanaryExceptionReason: preCanaryReason,
  }), /passed machine-generated/);

  const wrongTeam = structuredClone(evidence);
  wrongTeam.localVerification.identity.teamIdentifier = "WRONGTEAM";
  assert.throws(() => assertPromotionEvidence(releasePlan, wrongTeam, {
    notarizationExceptionReason: notarizationReason,
    preCanaryExceptionReason: preCanaryReason,
  }), /identities/);

  const alphaPlan = plan("1.2.16-alpha.1", "alpha");
  const alphaEvidence = promotionEvidence(alphaPlan);
  assert.throws(() => assertPromotionEvidence(alphaPlan, alphaEvidence, { preCanaryExceptionReason: preCanaryReason }), /restricted to stable 1\.2\.16/);
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

test("Windows local verification binds signing, publisher input, PE architecture, post-sign blockmaps, and packaged updater", () => {
  const releasePlan = windowsPlan();
  assert.equal(assertLocalVerification(releasePlan, windowsLocalVerification(releasePlan)).result, "passed");
  const mutations = [
    ["publisher", (value) => { value.artifacts[0].authenticode.publisher = "Unapproved"; }],
    ["publisher", (value) => { value.artifacts[0].authenticode.signerCertificate.subject = "Unapproved"; }],
    ["digest algorithm", (value) => { value.artifacts[0].authenticode.digestAlgorithm = "SHA1"; }],
    ["digest algorithm", (value) => { delete value.artifacts[0].authenticode.digestAlgorithm; }],
    ["timestamp", (value) => { value.artifacts[0].authenticode.timestamp.status = "untrusted"; }],
    ["timestamp", (value) => { value.artifacts[0].authenticode.timestamp.authority = ""; }],
    ["timestamp", (value) => { value.artifacts[0].authenticode.timestamp.signedAt = "not-a-time"; }],
    ["validity period", (value) => { value.artifacts[0].authenticode.timestamp.signedAt = "2028-01-01T00:00:00.000Z"; }],
    ["PE architecture", (value) => { value.artifacts[0].peArchitecture = "x64"; }],
    ["post-sign", (value) => { value.artifacts[1].postSign.executableSha256 = "0".repeat(64); }],
    ["updater", (value) => { value.packagedUpdater.feedUrl = "https://example.test"; }],
  ];
  for (const [label, mutate] of mutations) {
    const verification = windowsLocalVerification(releasePlan);
    mutate(verification);
    assert.throws(() => assertLocalVerification(releasePlan, verification), new RegExp(label, "i"));
  }
  const absentPublisherInput = windowsLocalVerification(releasePlan);
  absentPublisherInput.approvedPublishers = [];
  assert.throws(() => assertLocalVerification(releasePlan, absentPublisherInput), /explicit non-empty approved publisher list/);

  for (const field of ["subject", "issuer", "serialNumber", "sha256Thumbprint", "notBefore", "notAfter"]) {
    const missingSignerField = windowsLocalVerification(releasePlan);
    delete missingSignerField.artifacts[0].authenticode.signerCertificate[field];
    assert.throws(() => assertLocalVerification(releasePlan, missingSignerField), /signer certificate/i);
  }
});

test("Windows canary requires aggregate passed runs bound to both architecture EXEs", () => {
  const releasePlan = windowsPlan();
  assert.equal(assertCanary(releasePlan, windowsCanary(releasePlan)).result, "passed");
  const missing = windowsCanary(releasePlan);
  missing.runs.pop();
  assert.throws(() => assertCanary(releasePlan, missing), /exactly one run per architecture/);
  const mismatched = windowsCanary(releasePlan);
  mismatched.runs[0].artifactSha256 = "0".repeat(64);
  assert.throws(() => assertCanary(releasePlan, mismatched), /missing or mismatched for arm64/);
  const duplicateExtra = windowsCanary(releasePlan);
  duplicateExtra.runs.push(structuredClone(duplicateExtra.runs[0]));
  assert.throws(() => assertCanary(releasePlan, duplicateExtra), /exactly one run per architecture/);

  const mutations = [
    ["physical", (value) => { value.runs[0].machineKind = "virtual"; }],
    ["native arm64", (value) => { value.runs[0].nativeArchitecture = "x64"; }],
    ["non-emulated", (value) => { value.runs[0].emulated = true; }],
    ["unique non-empty", (value) => { value.runs[0].machineId = ""; }],
    ["unique non-empty", (value) => { value.runs[1].machineId = value.runs[0].machineId; }],
    ["unique non-empty", (value) => { value.runs[1].runId = value.runs[0].runId; }],
    ["unique non-empty", (value) => { value.runs[1].machineId = ` ${value.runs[0].machineId} `; }],
    ["unique non-empty", (value) => { value.runs[1].runId = ` ${value.runs[0].runId} `; }],
    ["missing or mismatched", (value) => { value.runs[0].runId = " "; }],
    ["publisherIdentity", (value) => { value.runs[0].checks.publisherIdentity = "failed"; }],
  ];
  for (const [label, mutate] of mutations) {
    const canaryEvidence = windowsCanary(releasePlan);
    mutate(canaryEvidence);
    assert.throws(() => assertCanary(releasePlan, canaryEvidence), new RegExp(label, "i"));
  }
});

test("stable Windows promotion accepts only the complete platform-specific evidence chain", () => {
  const releasePlan = windowsPlan();
  assert.equal(assertPromotionEvidence(releasePlan, windowsPromotionEvidence(releasePlan)).platform, "windows");
  const candidate = windowsPromotionEvidence(releasePlan);
  candidate.localVerification.releaseState = "candidate";
  assert.throws(() => assertPromotionEvidence(releasePlan, candidate), /rejects candidate/);
  const macCanary = windowsPromotionEvidence(releasePlan);
  macCanary.canary = canary();
  assert.throws(() => assertPromotionEvidence(releasePlan, macCanary), /Windows canary schema/);
});

test("Windows rejects macOS evidence and all Apple-only promotion exceptions", () => {
  const releasePlan = windowsPlan();
  assert.throws(() => assertLocalVerification(releasePlan, localVerification()), /Windows local verification schema/);
  const evidence = createEvidence({ plan: releasePlan, commit: "abc", localVerification: windowsLocalVerification(releasePlan), canary: windowsCanary(releasePlan) });
  assert.throws(() => assertPromotionEvidence(releasePlan, evidence, { notarizationExceptionReason: "Audited but forbidden Windows Apple exception" }), /only for macOS/);
  assert.throws(() => assertPromotionEvidence(releasePlan, evidence, { preCanaryExceptionReason: "Audited but forbidden Windows pre-canary exception" }), /only for macOS/);
});
