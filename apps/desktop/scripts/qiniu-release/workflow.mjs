import { metadataForBuffer } from "./metadata.mjs";
import { CHANNEL_MANIFEST_CACHE_CONTROL, promotionLockKey } from "./constants.mjs";
import { readBackDigest, verifyCdnObject } from "./cdn.mjs";
import { assertEvidenceMatchesPlan, assertLocalVerification, assertPromotionEvidence } from "./evidence.mjs";

function exactRemote(remote, object) {
  return remote?.size === object.size && remote?.etag === object.etag;
}

export async function preflightImmutable(objects, { qiniu, resume = false }) {
  const decisions = [];
  for (const object of objects) {
    const remote = await qiniu.stat(object.key);
    if (!remote) {
      decisions.push({ object, action: "upload" });
      continue;
    }
    if (!resume) throw new Error(`Immutable object already exists; use resume after verifying it: ${object.key}`);
    if (!exactRemote(remote, object)) {
      throw new Error(`Immutable object mismatch; refusing overwrite: ${object.key}`);
    }
    decisions.push({ object, action: "skip-matching" });
  }
  return decisions;
}

export async function verifyQiniuObjects(objects, { qiniu }) {
  const checks = [];
  for (const object of objects) {
    const remote = await qiniu.stat(object.key);
    if (!exactRemote(remote, object)) throw new Error(`Qiniu stat mismatch for ${object.key}`);
    checks.push({ key: object.key, size: remote.size, etag: remote.etag, verified: true });
  }
  return checks;
}

export async function uploadVersion(plan, { qiniu, evidence, resume = false, dryRun = false, onEvent = () => {} }) {
  if (plan.platform === "windows") {
    assertEvidenceMatchesPlan(plan, evidence);
    assertLocalVerification(plan, evidence.localVerification, { stable: false });
  }
  const binaries = plan.objects;
  const manifest = plan.manifest;
  if (dryRun) {
    return {
      dryRun: true,
      actions: [...binaries.map((object) => `upload ${object.key} without overwrite`), `upload ${manifest.key} without overwrite`],
    };
  }

  // Preflight all binaries before the first mutation; the manifest is deliberately last.
  const binaryDecisions = await preflightImmutable(binaries, { qiniu, resume });
  const manifestDecisions = await preflightImmutable([manifest], { qiniu, resume });
  for (const decision of binaryDecisions) {
    if (decision.action === "skip-matching") continue;
    onEvent({ type: "upload", key: decision.object.key });
    await qiniu.uploadFile(decision.object.key, decision.object.path, decision.object.mime, { overwrite: false });
    await verifyQiniuObjects([decision.object], { qiniu });
  }
  await verifyQiniuObjects(binaries, { qiniu });
  const manifestDecision = manifestDecisions[0];
  if (manifestDecision.action === "upload") {
    onEvent({ type: "upload-manifest", key: manifest.key });
    await qiniu.uploadContent(manifest.key, manifest.content, manifest.mime, { overwrite: false });
  }
  return verifyQiniuObjects([...binaries, manifest], { qiniu });
}

export async function verifyCdn(plan, { qiniu, fetchImpl, verifyObject = verifyCdnObject }) {
  const objects = [...plan.objects, plan.manifest];
  const qiniuChecks = await verifyQiniuObjects(objects, { qiniu });
  const cdnChecks = [];
  for (const object of objects) {
    cdnChecks.push({ key: object.key, ...(await verifyObject(object, { fetchImpl })) });
  }
  return { qiniuChecks, cdnChecks };
}

export async function promoteChannel(plan, evidence, {
  qiniu,
  refresh,
  readBack = readBackDigest,
  fetchImpl,
  dryRun = false,
  now = () => new Date(),
  actor = process.env.CI_JOB_ID || process.env.GITHUB_RUN_ID || "manual",
  notarizationExceptionReason = "",
  preCanaryExceptionReason = "",
  cacheExceptionReason = "",
  onEvent = () => {},
  onPromotionVerified = async () => {},
} = {}) {
  assertPromotionEvidence(plan, evidence, { notarizationExceptionReason, preCanaryExceptionReason, cacheExceptionReason });
  const notarizationException = notarizationExceptionReason
    ? { scope: `stable-${plan.version}-only`, reason: notarizationExceptionReason.trim() }
    : null;
  const preCanaryException = preCanaryExceptionReason
    ? { scope: `stable-${plan.version}-only`, reason: preCanaryExceptionReason.trim() }
    : null;
  const cacheException = cacheExceptionReason
    ? { scope: `stable-${plan.version}-only`, reason: cacheExceptionReason.trim() }
    : null;
  if (!cacheException && typeof refresh !== "function") throw new Error("CDN cache refresh operation is unavailable");
  if (!cacheException && typeof readBack !== "function") throw new Error("CDN read-back operation is unavailable");
  if (!cacheException && typeof qiniu?.setCacheControl !== "function") throw new Error("Qiniu Cache-Control metadata operation is unavailable");
  const lockKey = promotionLockKey(plan.channel, plan.platform);
  if (dryRun) {
    return {
      dryRun: true,
      lockKey,
      channelKey: plan.channelManifest.key,
      overwrite: true,
      cacheControl: { conditional: true, value: CHANNEL_MANIFEST_CACHE_CONTROL, verifiedBeforeRefresh: true },
      refreshUrl: plan.channelManifest.url,
      readBack: { sha256: plan.manifest.sha256, size: plan.manifest.size },
    };
  }
  if (!cacheException && typeof qiniu.prepareCacheControl === "function") await qiniu.prepareCacheControl();

  const existingLock = await qiniu.stat(lockKey);
  if (existingLock) {
    throw new Error(`Promotion lock is held at ${lockKey}; putTime=${existingLock.putTime ?? "unknown"}. Inspect and use audited recover-lock if stale.`);
  }
  if (typeof qiniu.readContent !== "function") throw new Error("Qiniu content read-back operation is unavailable");
  const previousChannelContent = await qiniu.readContent(plan.channelManifest.key);
  const expectedPreviousChannelDigest = previousChannelContent === null
    ? null
    : metadataForBuffer(previousChannelContent, plan.channelManifest.key).sha256;
  const lockPayload = {
    version: plan.version,
    channel: plan.channel,
    platform: plan.platform,
    actor,
    acquiredAt: now().toISOString(),
    expectedPreviousChannelDigest,
    candidateDigest: plan.manifest.sha256,
  };
  const lockContent = `${JSON.stringify(lockPayload)}\n`;
  const lockMetadata = metadataForBuffer(lockContent, "promotion.lock");
  let channelMutated = false;
  let channelVerified = false;
  let lockOwnershipLost = false;
  onEvent({ type: "lock-acquire", key: lockKey });
  await qiniu.uploadContent(lockKey, lockContent, lockMetadata.mime, { overwrite: false });
  try {
    const acquired = await qiniu.stat(lockKey);
    if (!exactRemote(acquired, lockMetadata)) throw new Error(`Promotion lock acquisition could not be verified: ${lockKey}`);
    await verifyQiniuObjects([...plan.objects, plan.manifest], { qiniu });
    const ownedBeforeOverwrite = await qiniu.stat(lockKey);
    if (!exactRemote(ownedBeforeOverwrite, lockMetadata)) {
      lockOwnershipLost = true;
      throw new Error(`Promotion lock ownership changed before channel overwrite: ${lockKey}`);
    }
    const currentChannelContent = await qiniu.readContent(plan.channelManifest.key);
    const currentChannelDigest = currentChannelContent === null
      ? null
      : metadataForBuffer(currentChannelContent, plan.channelManifest.key).sha256;
    if (currentChannelDigest !== expectedPreviousChannelDigest) {
      throw new Error(`Channel manifest changed after lock acquisition; refusing overwrite: ${plan.channelManifest.key}`);
    }
    onEvent({ type: "channel-upload", key: plan.channelManifest.key });
    channelMutated = true;
    await qiniu.uploadContent(plan.channelManifest.key, plan.manifest.content, plan.manifest.mime, { overwrite: true });
    const channelRemote = await qiniu.stat(plan.channelManifest.key);
    if (!exactRemote(channelRemote, plan.manifest)) {
      throw new Error(`Qiniu stat mismatch for promoted channel manifest ${plan.channelManifest.key}`);
    }
    if (cacheException) {
      const result = { lockKey, channelKey: plan.channelManifest.key, channelObject: { size: channelRemote.size, etag: channelRemote.etag, verified: true }, lock: lockPayload, notarizationException, preCanaryException, cacheException };
      await onPromotionVerified(result);
      channelVerified = true;
      return result;
    }
    onEvent({ type: "channel-cache-control", key: plan.channelManifest.key, value: CHANNEL_MANIFEST_CACHE_CONTROL });
    const channelMetadata = await qiniu.setCacheControl(
      plan.channelManifest.key,
      CHANNEL_MANIFEST_CACHE_CONTROL,
      { size: channelRemote.size, etag: channelRemote.etag, putTime: channelRemote.putTime },
    );
    if (!exactRemote(channelMetadata, plan.manifest) || channelMetadata.cacheControl !== CHANNEL_MANIFEST_CACHE_CONTROL) {
      throw new Error(`Qiniu Cache-Control metadata mismatch for promoted channel manifest ${plan.channelManifest.key}`);
    }
    const cacheControl = {
      key: plan.channelManifest.key,
      value: channelMetadata.cacheControl,
      size: channelMetadata.size,
      etag: channelMetadata.etag,
      verified: true,
    };
    onEvent({ type: "cdn-refresh", url: plan.channelManifest.url });
    await refresh([plan.channelManifest.url]);
    onEvent({ type: "channel-readback", url: plan.channelManifest.url });
    const readBackResult = await readBack(plan.channelManifest.url, plan.manifest.sha256, { fetchImpl, expectedSize: plan.manifest.size });
    const result = { lockKey, channelKey: plan.channelManifest.key, cacheControl, readBack: readBackResult, lock: lockPayload, notarizationException, preCanaryException };
    await onPromotionVerified(result);
    channelVerified = true;
    return result;
  } finally {
    if (lockOwnershipLost || (channelMutated && !channelVerified)) {
      onEvent({ type: "lock-retained", key: lockKey });
    } else {
      onEvent({ type: "lock-release", key: lockKey });
      const ownedLock = await qiniu.stat(lockKey);
      if (exactRemote(ownedLock, lockMetadata)) await qiniu.delete(lockKey);
      else if (ownedLock) throw new Error(`Promotion lock ownership changed; refusing to delete ${lockKey}`);
    }
  }
}

export async function recoverPromotionLock({ channel, platform = "mac", qiniu, reason, actor = "manual", dryRun = false, now = () => new Date(), onAudit = () => {} }) {
  if (!reason || String(reason).trim().length < 10) {
    throw new Error("Lock recovery requires an explicit audited --reason of at least 10 characters");
  }
  const lockKey = promotionLockKey(channel, platform);
  const existing = await qiniu.stat(lockKey);
  if (!existing) throw new Error(`No promotion lock exists at ${lockKey}`);
  const audit = {
    action: "recover-promotion-lock",
    channel,
    platform,
    lockKey,
    actor,
    reason: String(reason).trim(),
    observedPutTime: existing.putTime ?? null,
    requestedAt: now().toISOString(),
  };
  if (!dryRun) await onAudit({ ...audit, status: "authorized" });
  if (!dryRun) {
    const current = await qiniu.stat(lockKey);
    if (!exactRemote(current, existing) || current?.putTime !== existing.putTime) {
      throw new Error(`Promotion lock changed after inspection; refusing to delete ${lockKey}`);
    }
    await qiniu.delete(lockKey);
    const afterDelete = await qiniu.stat(lockKey);
    if (afterDelete) throw new Error(`Promotion lock deletion could not be verified: ${lockKey}`);
    await onAudit({ ...audit, status: "completed", completedAt: now().toISOString() });
  }
  return { ...audit, dryRun };
}
