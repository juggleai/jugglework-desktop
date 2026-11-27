import { DEFAULT_BUCKET, RELEASE_CDN_ORIGIN, channelManifestKey, publicUrl, usesNewReleaseOrigin } from "./constants.mjs";
import { STANDING_POLICY_SCOPE } from "./standing-policy.mjs";

export const BOOTSTRAP = "manual-transition-1.2.41";
export const WINDOWS_BOOTSTRAP = "manual-transition-windows-1.2.42";

export function requiresBootstrap(plan) {
  return plan.origin === RELEASE_CDN_ORIGIN && usesNewReleaseOrigin(plan)
    && ((plan.platform === "mac" && plan.version === "1.2.41")
      || (plan.platform === "windows" && plan.version === "1.2.42"));
}

export function assertBootstrap(plan, { bootstrap, bucket, standingPolicy, expectedPreviousChannelDigest }) {
  const mac = bootstrap === BOOTSTRAP && plan.platform === "mac" && plan.version === "1.2.41"
    && standingPolicy === STANDING_POLICY_SCOPE;
  const windows = bootstrap === WINDOWS_BOOTSTRAP && plan.platform === "windows" && plan.version === "1.2.42"
    && !standingPolicy;
  if ((!mac && !windows) || bucket !== DEFAULT_BUCKET
    || !usesNewReleaseOrigin(plan)
    || expectedPreviousChannelDigest !== undefined) throw new Error("Invalid manual-transition bootstrap coordinates or predecessor");
  const key = channelManifestKey("stable", plan.platform);
  return { mode: bootstrap, bucket: DEFAULT_BUCKET, key, url: publicUrl(key, RELEASE_CDN_ORIGIN) };
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
