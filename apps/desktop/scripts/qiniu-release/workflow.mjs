import { metadataForBuffer } from "./metadata.mjs";
import { promotionLockKey } from "./constants.mjs";
import { readBackDigest, verifyCdnObject } from "./cdn.mjs";
import { assertPromotionEvidence } from "./evidence.mjs";

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

export async function uploadVersion(plan, { qiniu, resume = false, dryRun = false, onEvent = () => {} }) {
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
  for (const object of objects) cdnChecks.push(await verifyObject(object, { fetchImpl }));
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
  onEvent = () => {},
} = {}) {
  assertPromotionEvidence(plan, evidence, { notarizationExceptionReason });
  const notarizationException = notarizationExceptionReason
    ? { scope: "stable-1.2.15-only", reason: notarizationExceptionReason.trim() }
    : null;
  if (typeof refresh !== "function") throw new Error("CDN cache refresh operation is unavailable");
  if (typeof readBack !== "function") throw new Error("CDN read-back operation is unavailable");
  const lockKey = promotionLockKey(plan.channel);
  if (dryRun) {
    return { dryRun: true, lockKey, channelKey: plan.channelManifest.key, overwrite: true };
  }

  const existingLock = await qiniu.stat(lockKey);
  if (existingLock) {
    throw new Error(`Promotion lock is held at ${lockKey}; putTime=${existingLock.putTime ?? "unknown"}. Inspect and use audited recover-lock if stale.`);
  }
  const lockContent = `${JSON.stringify({ version: plan.version, channel: plan.channel, actor, acquiredAt: now().toISOString() })}\n`;
  const lockMetadata = metadataForBuffer(lockContent, "promotion.lock");
  let channelMutated = false;
  let channelVerified = false;
  onEvent({ type: "lock-acquire", key: lockKey });
  await qiniu.uploadContent(lockKey, lockContent, lockMetadata.mime, { overwrite: false });
  try {
    const acquired = await qiniu.stat(lockKey);
    if (!exactRemote(acquired, lockMetadata)) throw new Error(`Promotion lock acquisition could not be verified: ${lockKey}`);
    await verifyQiniuObjects([...plan.objects, plan.manifest], { qiniu });
    onEvent({ type: "channel-upload", key: plan.channelManifest.key });
    await qiniu.uploadContent(plan.channelManifest.key, plan.manifest.content, plan.manifest.mime, { overwrite: true });
    channelMutated = true;
    const channelRemote = await qiniu.stat(plan.channelManifest.key);
    if (!exactRemote(channelRemote, plan.manifest)) {
      throw new Error(`Qiniu stat mismatch for promoted channel manifest ${plan.channelManifest.key}`);
    }
    onEvent({ type: "cdn-refresh", url: plan.channelManifest.url });
    await refresh([plan.channelManifest.url]);
    onEvent({ type: "channel-readback", url: plan.channelManifest.url });
    const readBackResult = await readBack(plan.channelManifest.url, plan.manifest.sha256, { fetchImpl, expectedSize: plan.manifest.size });
    channelVerified = true;
      return { lockKey, channelKey: plan.channelManifest.key, readBack: readBackResult, notarizationException };
  } finally {
    if (channelMutated && !channelVerified) {
      onEvent({ type: "lock-retained", key: lockKey });
    } else {
      onEvent({ type: "lock-release", key: lockKey });
      const ownedLock = await qiniu.stat(lockKey);
      if (exactRemote(ownedLock, lockMetadata)) await qiniu.delete(lockKey);
      else if (ownedLock) throw new Error(`Promotion lock ownership changed; refusing to delete ${lockKey}`);
    }
  }
}

export async function recoverPromotionLock({ channel, qiniu, reason, actor = "manual", dryRun = false, now = () => new Date(), onAudit = () => {} }) {
  if (!reason || String(reason).trim().length < 10) {
    throw new Error("Lock recovery requires an explicit audited --reason of at least 10 characters");
  }
  const lockKey = promotionLockKey(channel);
  const existing = await qiniu.stat(lockKey);
  if (!existing) throw new Error(`No promotion lock exists at ${lockKey}`);
  const audit = {
    action: "recover-promotion-lock",
    channel,
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
