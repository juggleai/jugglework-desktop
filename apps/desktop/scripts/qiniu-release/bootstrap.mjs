import { DEFAULT_BUCKET, RELEASE_CDN_ORIGIN, channelManifestKey, publicUrl, usesNewReleaseOrigin } from "./constants.mjs";
import { STANDING_POLICY_SCOPE } from "./standing-policy.mjs";

export const BOOTSTRAP = "manual-transition-1.2.41";

export function assertBootstrap(plan, { bootstrap, bucket, standingPolicy, expectedPreviousChannelDigest }) {
  if (bootstrap !== BOOTSTRAP || bucket !== DEFAULT_BUCKET || plan.version !== "1.2.41"
    || !usesNewReleaseOrigin(plan) || standingPolicy !== STANDING_POLICY_SCOPE
    || expectedPreviousChannelDigest !== undefined) throw new Error("Invalid manual-transition bootstrap coordinates or predecessor");
  const key = channelManifestKey("stable", "mac");
  return { mode: BOOTSTRAP, bucket: DEFAULT_BUCKET, key, url: publicUrl(key, RELEASE_CDN_ORIGIN) };
}

export async function proveBootstrapAbsence({ key, url }, { qiniu, fetchImpl = globalThis.fetch, now }) {
  await qiniu.assertObjectAbsent(key);
  const response = await fetchImpl(url, { method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (response.status !== 404 || response.redirected) {
    await response.body?.cancel();
    throw new Error(`Bootstrap requires public HTTP 404; received ${response.status}`);
  }
  const body = await response.json();
  if (body?.error !== "Document not found") throw new Error("Bootstrap 404 does not prove Qiniu object absence");
  // Stat again after the CDN check; the subsequent upload is still insert-only.
  await qiniu.assertObjectAbsent(key);
  return { qiniu: "object_absent", httpStatus: 404, checkedAt: now().toISOString() };
}
