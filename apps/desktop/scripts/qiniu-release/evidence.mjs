import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
  CDN_ORIGIN,
  assertSemverVersion,
  assertWindowsReleaseVersion,
  compareSemver,
  normalizeReleaseArchitectures,
} from "./constants.mjs";

export const EVIDENCE_SCHEMA = "com.juggleai.jugglework.qiniu-release-evidence";
export const EVIDENCE_SCHEMA_VERSION = 2;
export const LOCAL_VERIFICATION_SCHEMA = "com.juggleai.jugglework.macos-local-verification";
export const CANARY_SCHEMA = "com.juggleai.jugglework.macos-update-canary";
export const WINDOWS_LOCAL_VERIFICATION_SCHEMA = "com.juggleai.jugglework.windows-local-verification";
export const WINDOWS_CANARY_SCHEMA = "com.juggleai.jugglework.windows-update-canary";
export const VERIFICATION_SCHEMA_VERSION = 1;
export const EXPECTED_BUNDLE_ID = "com.juggleai.jugglework";
export const EXPECTED_TEAM_ID = "H7PDHSK3C7";

function isSecretKey(key) {
  const compact = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (compact === "credentialstate") return false;
  if (["access", "secret", "token", "cookie", "password", "privatekey", "credential", "credentials", "authorization"].includes(compact)) {
    return true;
  }
  return [
    "accesskey",
    "secretkey",
    "apikey",
    "apisecret",
    "clientsecret",
    "clientcredential",
    "sessiontoken",
    "accesstoken",
    "refreshtoken",
    "authtoken",
    "idtoken",
    "bearertoken",
    "setcookie",
  ].some((marker) => compact.includes(marker)) || compact.includes("credential");
}

export function secretPaths(value, current = "$", found = []) {
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${current}.${key}`;
    if (isSecretKey(key)) found.push(childPath);
    else secretPaths(child, childPath, found);
  }
  return found;
}

export function assertNoSecrets(value) {
  const paths = secretPaths(value);
  if (paths.length > 0) throw new Error(`Evidence contains secret-like keys: ${paths.join(", ")}`);
  return value;
}

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, isSecretKey(key) ? "[REDACTED]" : redactSecrets(child)]));
}

function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
  return value;
}

function exactObjectCheck(check, object, label) {
  if (!check || check.key !== object.key || check.size !== object.size || check.etag !== object.etag) {
    throw new Error(`${label} does not match ${object.key}`);
  }
}

function sameArray(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function artifactDigestsMatch(verified, object) {
  return verified?.name === object.name && verified.size === object.size && verified.sha256 === object.sha256
    && verified.sha512 === object.sha512 && verified.etag === object.etag;
}

function assertWindowsSignerCertificate(certificate, objectName) {
  for (const field of ["subject", "issuer", "serialNumber"]) {
    if (typeof certificate?.[field] !== "string" || !certificate[field].trim()) {
      throw new Error(`Windows EXE signer certificate ${field} is missing for ${objectName}`);
    }
  }
  if (typeof certificate.sha256Thumbprint !== "string" || !/^[0-9a-f]{64}$/i.test(certificate.sha256Thumbprint)) {
    throw new Error(`Windows EXE signer certificate SHA-256 thumbprint is missing or invalid for ${objectName}`);
  }
  timestamp(certificate.notBefore, `Windows EXE signer certificate notBefore for ${objectName}`);
  timestamp(certificate.notAfter, `Windows EXE signer certificate notAfter for ${objectName}`);
  if (Date.parse(certificate.notBefore) >= Date.parse(certificate.notAfter)) {
    throw new Error(`Windows EXE signer certificate validity period is invalid for ${objectName}`);
  }
  return certificate;
}

function assertMacLocalVerification(plan, verification, { stable }) {
  assertNoSecrets(verification);
  if (verification?.schema !== LOCAL_VERIFICATION_SCHEMA || verification?.schemaVersion !== VERIFICATION_SCHEMA_VERSION) {
    throw new Error("Local verification schema or version is unsupported");
  }
  if (verification.producer !== "verify-packaged-macos" || verification.version !== plan.version || verification.platform !== "mac") {
    throw new Error("Local verification producer or release coordinates do not match");
  }
  if (!sameArray(verification.architectures, plan.architectures)) {
    throw new Error("Local verification architectures do not match the release plan");
  }
  timestamp(verification.verifiedAt, "Local verification verifiedAt");
  if (verification.identity?.bundleIdentifier !== EXPECTED_BUNDLE_ID || verification.identity?.teamIdentifier !== EXPECTED_TEAM_ID) {
    throw new Error("Local verification signing identities do not match the required bundle and Team IDs");
  }
  if (verification.codesign?.status !== "accepted" || verification.codesign?.deep !== true || verification.codesign?.strict !== true) {
    throw new Error("Local verification must record accepted codesign --deep --strict verification");
  }
  if (verification.hardenedRuntime?.status !== "enabled") {
    throw new Error("Local verification must record hardened runtime as enabled");
  }
  const verifiedArtifacts = new Map((verification.artifacts ?? []).map((artifact) => [artifact.name, artifact]));
  if (verifiedArtifacts.size !== plan.objects.length) {
    throw new Error("Local verification artifact inventory is incomplete");
  }
  for (const object of plan.objects) {
    const verified = verifiedArtifacts.get(object.name);
    if (!verified || verified.size !== object.size || verified.sha256 !== object.sha256
      || verified.sha512 !== object.sha512 || verified.etag !== object.etag) {
      throw new Error(`Local verification artifact digest does not match ${object.name}`);
    }
  }
  if (!verification.manifest || verification.manifest.size !== plan.manifest.size
    || verification.manifest.sha256 !== plan.manifest.sha256
    || verification.manifest.sha512 !== plan.manifest.sha512
    || verification.manifest.etag !== plan.manifest.etag) {
    throw new Error("Local verification manifest digest does not match the release plan");
  }
  if (stable) {
    if (verification.credentialState !== "available") {
      throw new Error("Stable promotion rejects missing or unavailable signing/notarization credential state");
    }
    if (verification.releaseState !== "release") {
      throw new Error("Stable promotion rejects candidate or otherwise non-release verification state");
    }
    if (verification.notarization?.status !== "accepted" || typeof verification.notarization.submissionId !== "string" || !verification.notarization.submissionId) {
      throw new Error("Stable promotion requires accepted notarization; unavailable or missing-credential candidates are rejected");
    }
    if (verification.staple?.status !== "validated" || verification.gatekeeper?.status !== "accepted") {
      throw new Error("Stable promotion requires a validated stapled ticket and accepted Gatekeeper assessment");
    }
  }
  return verification;
}

function assertWindowsLocalVerification(plan, verification, { stable }) {
  assertNoSecrets(verification);
  assertWindowsReleaseVersion(plan.version);
  normalizeReleaseArchitectures(plan.architectures, "windows");
  if (verification?.schema !== WINDOWS_LOCAL_VERIFICATION_SCHEMA || verification?.schemaVersion !== VERIFICATION_SCHEMA_VERSION) {
    throw new Error("Windows local verification schema or version is unsupported");
  }
  if (verification.producer !== "verify-packaged-windows" || verification.version !== plan.version || verification.platform !== "windows"
    || verification.result !== "passed" || !sameArray(verification.architectures, plan.architectures)) {
    throw new Error("Windows local verification producer, result, or release coordinates do not match");
  }
  timestamp(verification.verifiedAt, "Windows local verification verifiedAt");
  if (!Array.isArray(verification.approvedPublishers) || verification.approvedPublishers.length === 0
    || verification.approvedPublishers.some((publisher) => typeof publisher !== "string" || !publisher.trim())
    || new Set(verification.approvedPublishers).size !== verification.approvedPublishers.length) {
    throw new Error("Windows local verification requires an explicit non-empty approved publisher list");
  }
  const expectedFeed = `${CDN_ORIGIN}/jugglework/releases/${plan.channel}/windows`;
  if (verification.packagedUpdater?.provider !== "generic" || verification.packagedUpdater?.feedUrl !== expectedFeed
    || !sameArray(verification.packagedUpdater?.publisherNames, verification.approvedPublishers)) {
    throw new Error("Packaged Windows updater must bind the approved publisher list and Qiniu channel feed");
  }
  if (!Array.isArray(verification.artifacts) || verification.artifacts.length !== plan.objects.length) {
    throw new Error("Windows local verification artifact inventory is incomplete");
  }
  const verifiedArtifacts = new Map(verification.artifacts.map((artifact) => [artifact.name, artifact]));
  if (verifiedArtifacts.size !== plan.objects.length) throw new Error("Windows local verification artifact inventory is incomplete");
  for (const object of plan.objects) {
    const verified = verifiedArtifacts.get(object.name);
    if (!artifactDigestsMatch(verified, object) || verified.arch !== object.arch || verified.type !== object.type) {
      throw new Error(`Windows local verification artifact digest does not match ${object.name}`);
    }
    if (object.type === "exe") {
      const signature = verified.authenticode;
      const signerCertificate = assertWindowsSignerCertificate(signature?.signerCertificate, object.name);
      if (signature?.status !== "valid" || signature.publisher !== signerCertificate.subject
        || !verification.approvedPublishers.includes(signerCertificate.subject)) {
        throw new Error(`Windows EXE Authenticode publisher is invalid or unapproved for ${object.name}`);
      }
      if (signature.digestAlgorithm !== "SHA256") {
        throw new Error(`Windows EXE Authenticode digest algorithm must be SHA256 for ${object.name}`);
      }
      if (signature.timestamp?.status !== "trusted" || typeof signature.timestamp.authority !== "string" || !signature.timestamp.authority.trim()) {
        throw new Error(`Windows EXE requires a trusted Authenticode timestamp for ${object.name}`);
      }
      timestamp(signature.timestamp.signedAt, `Windows EXE timestamp for ${object.name}`);
      if (Date.parse(signature.timestamp.signedAt) < Date.parse(signerCertificate.notBefore)
        || Date.parse(signature.timestamp.signedAt) > Date.parse(signerCertificate.notAfter)) {
        throw new Error(`Windows EXE timestamp is outside the signer certificate validity period for ${object.name}`);
      }
      if (verified.peArchitecture !== object.arch) throw new Error(`Windows PE architecture does not match ${object.arch} for ${object.name}`);
    } else {
      const executable = plan.objects.find((candidate) => candidate.arch === object.arch && candidate.type === "exe");
      if (verified.postSign?.status !== "verified" || verified.postSign.executableName !== executable?.name
        || verified.postSign.executableSha256 !== executable?.sha256) {
        throw new Error(`Windows blockmap was not verified against the post-sign EXE for ${object.name}`);
      }
    }
  }
  if (!verification.manifest || verification.manifest.size !== plan.manifest.size
    || verification.manifest.sha256 !== plan.manifest.sha256 || verification.manifest.sha512 !== plan.manifest.sha512
    || verification.manifest.etag !== plan.manifest.etag) {
    throw new Error("Windows local verification manifest digest does not match the release plan");
  }
  if (stable && verification.releaseState !== "release") {
    throw new Error("Stable Windows promotion rejects candidate or otherwise non-release verification state");
  }
  return verification;
}

export function assertLocalVerification(plan, verification, { stable = plan.channel === "stable" } = {}) {
  if (plan.platform === "windows") return assertWindowsLocalVerification(plan, verification, { stable });
  if (plan.platform !== "mac") throw new Error(`Unsupported local verification platform: ${plan.platform}`);
  return assertMacLocalVerification(plan, verification, { stable });
}

function assertMacCanary(plan, canary) {
  assertNoSecrets(canary);
  if (canary?.schema !== CANARY_SCHEMA || canary?.schemaVersion !== VERIFICATION_SCHEMA_VERSION) {
    throw new Error("Canary schema or version is unsupported");
  }
  if (canary.producer !== "jugglework-macos-update-canary" || canary.result !== "passed") {
    throw new Error("A passed machine-generated macOS update canary is required");
  }
  if (canary.channel !== plan.channel || canary.targetVersion !== plan.version || canary.feedUrl !== plan.manifest.url) {
    throw new Error("Canary release coordinates or targeted feed do not match the release plan");
  }
  if (!sameArray(canary.architectures, plan.architectures) || canary.manifestSha256 !== plan.manifest.sha256) {
    throw new Error("Canary architectures or immutable manifest digest do not match the release plan");
  }
  assertSemverVersion(canary.sourceVersion);
  if (compareSemver(canary.sourceVersion, plan.version) >= 0 || !canary.runId) {
    throw new Error("Canary must identify a semantically older source version and a run ID");
  }
  timestamp(canary.verifiedAt, "Canary verifiedAt");
  const expectedChecks = {
    cleanClient: "passed",
    updateDiscovered: "passed",
    download: "passed",
    install: "passed",
    restart: "passed",
    installedVersion: plan.version,
    userData: "preserved",
    workspaceAccess: "preserved",
    permissions: "preserved",
  };
  for (const [name, expected] of Object.entries(expectedChecks)) {
    if (canary.checks?.[name] !== expected) throw new Error(`Canary check ${name} is missing or failed`);
  }
  if (canary.network?.manifestOrigin !== CDN_ORIGIN || canary.network?.artifactOrigin !== CDN_ORIGIN) {
    throw new Error("Canary did not verify the required Qiniu CDN origins");
  }
  return canary;
}

function assertCanaryChecks(checks, version, label) {
  const expectedChecks = {
    cleanClient: "passed",
    updateDiscovered: "passed",
    download: "passed",
    install: "passed",
    restart: "passed",
    installedVersion: version,
    userData: "preserved",
    workspaceAccess: "preserved",
    permissions: "preserved",
    publisherIdentity: "passed",
  };
  for (const [name, expected] of Object.entries(expectedChecks)) {
    if (checks?.[name] !== expected) throw new Error(`${label} check ${name} is missing or failed`);
  }
}

function assertWindowsCanary(plan, canary) {
  assertNoSecrets(canary);
  assertWindowsReleaseVersion(plan.version);
  normalizeReleaseArchitectures(plan.architectures, "windows");
  if (canary?.schema !== WINDOWS_CANARY_SCHEMA || canary?.schemaVersion !== VERIFICATION_SCHEMA_VERSION) {
    throw new Error("Windows canary schema or version is unsupported");
  }
  if (canary.producer !== "jugglework-windows-update-canary" || canary.result !== "passed" || canary.channel !== plan.channel
    || canary.targetVersion !== plan.version || canary.feedUrl !== plan.manifest.url
    || !sameArray(canary.architectures, plan.architectures) || canary.manifestSha256 !== plan.manifest.sha256) {
    throw new Error("A passed aggregated Windows update canary matching the release plan is required");
  }
  timestamp(canary.verifiedAt, "Windows canary verifiedAt");
  if (!Array.isArray(canary.runs) || canary.runs.length !== plan.architectures.length) {
    throw new Error("Windows canary must aggregate exactly one run per architecture");
  }
  const runs = new Map(canary.runs.map((run) => [run.arch, run]));
  if (runs.size !== plan.architectures.length) throw new Error("Windows canary must aggregate exactly one run per architecture");
  const machineIds = new Set();
  const runIds = new Set();
  for (const arch of plan.architectures) {
    const run = runs.get(arch);
    const executable = plan.objects.find((object) => object.arch === arch && object.type === "exe");
    if (!run || run.result !== "passed" || typeof run.runId !== "string" || !run.runId.trim() || run.targetVersion !== plan.version
      || run.artifactName !== executable?.name || run.artifactSha256 !== executable?.sha256) {
      throw new Error(`Windows canary run is missing or mismatched for ${arch}`);
    }
    const machineId = typeof run.machineId === "string" ? run.machineId.trim() : "";
    const runId = run.runId.trim();
    if (!machineId || machineIds.has(machineId) || runIds.has(runId)) {
      throw new Error(`Windows canary requires unique non-empty machineId and runId values for ${arch}`);
    }
    machineIds.add(machineId);
    runIds.add(runId);
    if (run.machineKind !== "physical" || run.nativeArchitecture !== arch || run.emulated !== false) {
      throw new Error(`Windows canary run must use a physical, non-emulated native ${arch} machine`);
    }
    assertSemverVersion(run.sourceVersion);
    if (compareSemver(run.sourceVersion, plan.version) >= 0) throw new Error(`Windows canary source version must be older for ${arch}`);
    timestamp(run.verifiedAt, `Windows canary verifiedAt for ${arch}`);
    assertCanaryChecks(run.checks, plan.version, `Windows canary ${arch}`);
    if (run.network?.manifestOrigin !== CDN_ORIGIN || run.network?.artifactOrigin !== CDN_ORIGIN) {
      throw new Error(`Windows canary did not verify Qiniu CDN origins for ${arch}`);
    }
  }
  return canary;
}

export function assertCanary(plan, canary) {
  if (plan.platform === "windows") return assertWindowsCanary(plan, canary);
  if (plan.platform !== "mac") throw new Error(`Unsupported canary platform: ${plan.platform}`);
  return assertMacCanary(plan, canary);
}

export function createEvidence({ plan, commit, localVerification = null, canary = null, den = {}, timestamps = {} }) {
  const createdAt = timestamps.createdAt ?? new Date().toISOString();
  const evidence = {
    schema: EVIDENCE_SCHEMA,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    version: plan.version,
    commit: String(commit || "").trim(),
    platform: plan.platform,
    architectures: plan.architectures,
    channel: plan.channel,
    artifacts: plan.objects.map((object) => ({
      name: object.name,
      key: object.key,
      size: object.size,
      sha256: object.sha256,
      sha512: object.sha512,
      etag: object.etag,
      mime: object.mime,
    })),
    manifest: {
      key: plan.manifest.key,
      url: plan.manifest.url,
      sha256: plan.manifest.sha256,
      sha512: plan.manifest.sha512,
      size: plan.manifest.size,
      etag: plan.manifest.etag,
      mime: plan.manifest.mime,
    },
    localVerification,
    canary,
    workflow: {
      local: localVerification ? { status: "verified", verifiedAt: localVerification.verifiedAt } : null,
      immutable: null,
      cdn: null,
      promotion: null,
    },
    den: {
      publishedVersionReadBack: String(den.publishedVersionReadBack || ""),
      latestVersionReadBack: String(den.latestVersionReadBack || ""),
    },
    timestamps: { createdAt, updatedAt: createdAt },
  };
  if (!evidence.commit) throw new Error("Evidence commit is required");
  timestamp(createdAt, "Evidence createdAt");
  return assertNoSecrets(evidence);
}

export function assertEvidenceMatchesPlan(plan, evidence) {
  assertNoSecrets(evidence);
  if (evidence?.schema !== EVIDENCE_SCHEMA || evidence?.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    throw new Error("Release evidence schema or version is unsupported");
  }
  if (evidence.version !== plan.version || evidence.channel !== plan.channel || evidence.platform !== plan.platform) {
    throw new Error("Release evidence coordinates do not match the release plan");
  }
  if (typeof evidence.commit !== "string" || !evidence.commit.trim()) throw new Error("Release evidence commit is required");
  if (JSON.stringify(evidence.architectures) !== JSON.stringify(plan.architectures)) {
    throw new Error("Release evidence architectures do not match the release plan");
  }
  if (evidence.manifest?.key !== plan.manifest.key || evidence.manifest?.url !== plan.manifest.url
    || evidence.manifest?.size !== plan.manifest.size || evidence.manifest?.sha256 !== plan.manifest.sha256
    || evidence.manifest?.sha512 !== plan.manifest.sha512 || evidence.manifest?.etag !== plan.manifest.etag
    || evidence.manifest?.mime !== plan.manifest.mime) {
    throw new Error("Release evidence manifest does not match the release plan");
  }
  const artifacts = new Map((evidence.artifacts ?? []).map((artifact) => [artifact.key, artifact]));
  if (artifacts.size !== plan.objects.length) throw new Error("Release evidence artifact inventory is incomplete");
  for (const object of plan.objects) {
    const recorded = artifacts.get(object.key);
    if (!recorded || recorded.size !== object.size || recorded.sha256 !== object.sha256 || recorded.sha512 !== object.sha512 || recorded.etag !== object.etag || recorded.mime !== object.mime) {
      throw new Error(`Release evidence artifact does not match ${object.key}`);
    }
  }
  return evidence;
}

function assertStableNotarizationException(plan, reason) {
  if (plan.channel !== "stable" || !["1.2.15", "1.2.16", "1.2.17", "1.2.18"].includes(plan.version)) {
    throw new Error("The notarization exception is restricted to stable 1.2.15, stable 1.2.16, stable 1.2.17, or stable 1.2.18");
  }
  if (typeof reason !== "string" || reason.trim().length < 20) {
    throw new Error(`The stable ${plan.version} notarization exception requires an explicit audited reason`);
  }
  return reason.trim();
}

function assertStablePreCanaryException(plan, reason) {
  if (plan.channel !== "stable" || !["1.2.16", "1.2.18"].includes(plan.version)) {
    throw new Error("The pre-canary promotion exception is restricted to stable 1.2.16 or stable 1.2.18");
  }
  if (typeof reason !== "string" || reason.trim().length < 20) {
    throw new Error(`The stable ${plan.version} pre-canary promotion exception requires an explicit audited reason`);
  }
  return reason.trim();
}

export function assertPromotionEvidence(plan, evidence, {
  notarizationExceptionReason = "",
  preCanaryExceptionReason = "",
} = {}) {
  assertEvidenceMatchesPlan(plan, evidence);
  if (plan.platform !== "mac" && (notarizationExceptionReason || preCanaryExceptionReason)) {
    throw new Error("Apple notarization and pre-canary exceptions are allowed only for macOS releases");
  }
  if (notarizationExceptionReason) {
    assertStableNotarizationException(plan, notarizationExceptionReason);
    assertLocalVerification(plan, evidence.localVerification, { stable: false });
  } else {
    assertLocalVerification(plan, evidence.localVerification);
  }
  if (preCanaryExceptionReason) {
    assertStablePreCanaryException(plan, preCanaryExceptionReason);
    if (evidence.canary !== null && evidence.canary !== undefined) assertCanary(plan, evidence.canary);
  } else {
    assertCanary(plan, evidence.canary);
  }
  const objects = [...plan.objects, plan.manifest];
  if (evidence.workflow?.immutable?.status !== "verified") throw new Error("Workflow-recorded immutable verification is required");
  if (evidence.workflow?.cdn?.status !== "verified") throw new Error("Workflow-recorded CDN verification is required");
  timestamp(evidence.workflow.immutable.verifiedAt, "Immutable verification timestamp");
  timestamp(evidence.workflow.cdn.verifiedAt, "CDN verification timestamp");
  for (const object of objects) {
    exactObjectCheck(evidence.workflow.immutable.qiniuChecks?.find((check) => check.key === object.key), object, "Immutable Qiniu check");
    exactObjectCheck(evidence.workflow.cdn.qiniuChecks?.find((check) => check.key === object.key), object, "CDN-stage Qiniu check");
    const check = evidence.workflow.cdn.cdnChecks?.find((item) => item.key === object.key);
    if (!check || check.url !== object.url || check.https !== true || check.range !== true || check.mime !== object.mime
      || check.contentLength !== object.size || check.size !== object.size || check.sha256 !== object.sha256 || check.sha512 !== object.sha512) {
      throw new Error(`Workflow-recorded CDN evidence is missing or mismatched for ${object.key}`);
    }
  }
  return evidence;
}

export function withEvidenceResults(evidence, changes, now = new Date().toISOString()) {
  const updated = {
    ...evidence,
    ...changes,
    workflow: { ...evidence.workflow, ...(changes.workflow ?? {}) },
    timestamps: { ...evidence.timestamps, updatedAt: now },
  };
  timestamp(now, "Evidence updatedAt");
  return assertNoSecrets(updated);
}

async function durableWrite(filePath, content, flag) {
  const handle = await open(filePath, flag, 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeEvidence(filePath, evidence) {
  assertNoSecrets(evidence);
  await durableWrite(filePath, `${JSON.stringify(evidence, null, 2)}\n`, "wx");
}

export async function replaceEvidence(filePath, evidence) {
  assertNoSecrets(evidence);
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await durableWrite(temporary, `${JSON.stringify(evidence, null, 2)}\n`, "wx");
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function appendAuditRecord(filePath, record) {
  assertNoSecrets(record);
  await durableWrite(filePath, `${JSON.stringify(record)}\n`, "a");
}
