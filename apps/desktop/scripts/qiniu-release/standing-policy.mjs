import { assertStableVersion, compareSemver } from "./constants.mjs";

export const STANDING_POLICY_SCOPE = "stable-mac-arm64-standing-policy";
export const STANDING_POLICY_VERSION = 1;
export const STANDING_POLICY_MINIMUM_VERSION = "1.2.35";

export function assertStandingPolicyCoordinates(plan) {
  assertStableVersion(plan.version);
  // compareSemver uses numeric components: reject numbers outside its exact range.
  if (plan.version.split(".").some((part) => !Number.isSafeInteger(Number(part)))
    || compareSemver(plan.version, STANDING_POLICY_MINIMUM_VERSION) < 0
    || plan.channel !== "stable" || plan.platform !== "mac"
    || JSON.stringify(plan.architectures) !== '["arm64"]') {
    throw new Error("Standing policy requires exact stable/mac/arm64 version >= 1.2.35");
  }
}

export function assertStandingPolicy(plan, { standingPolicy, preCanaryExceptionReason, metadataExceptionReason,
  notarizationExceptionReason, cacheExceptionReason } = {}) {
  if (standingPolicy !== STANDING_POLICY_SCOPE) throw new Error("Explicit standing policy selection is required");
  assertStandingPolicyCoordinates(plan);
  if (notarizationExceptionReason || cacheExceptionReason) throw new Error("Standing policy cannot waive notarization or broader cache convergence");
  for (const reason of [preCanaryExceptionReason, metadataExceptionReason]) {
    if (typeof reason !== "string" || reason.trim().length < 20) throw new Error("Standing policy requires two independent explicit audited reasons");
  }
}

export function standingPolicyException(plan, reason) {
  return { scope: STANDING_POLICY_SCOPE, policyVersion: STANDING_POLICY_VERSION,
    minimumVersion: STANDING_POLICY_MINIMUM_VERSION, version: plan.version, channel: plan.channel,
    platform: plan.platform, architectures: [...plan.architectures], reason: reason.trim() };
}

export function standingPolicyEvidence(plan, evidence, options) {
  assertStandingPolicy(plan, options);
  if (!/^[a-f0-9]{40}$/.test(evidence.commit ?? "") || !/^[a-f0-9]{64}$/.test(plan.manifest.sha256 ?? "")) {
    throw new Error("Standing policy requires full source commit and immutable manifest digest");
  }
  return {
    releasePolicy: {
      scope: STANDING_POLICY_SCOPE, policyVersion: STANDING_POLICY_VERSION, minVersion: STANDING_POLICY_MINIMUM_VERSION,
      currentCoordinates: { version: plan.version, channel: plan.channel, platform: plan.platform,
        architecture: "arm64", commit: evidence.commit, immutableManifestDigest: plan.manifest.sha256,
        mutableManifestKey: plan.channelManifest.key },
      reasons: { canary: options.preCanaryExceptionReason.trim(), mutableCacheControl: options.metadataExceptionReason.trim() },
    },
    workflow: { authorization: "standing_policy", explicit: true,
      canary: evidence.canary == null ? "skipped_by_standing_policy" : "verified",
      mutableCacheControlMutation: "skipped_by_standing_policy", mutableCacheControlValidation: "skipped_by_standing_policy" },
  };
}

export function assertStandingPolicyException(plan, exception) {
  assertStandingPolicyCoordinates(plan);
  const expected = standingPolicyException(plan, exception?.reason ?? "");
  if (typeof exception?.reason !== "string" || exception.reason.trim().length < 20
    || Object.keys(expected).some((key) => JSON.stringify(exception[key]) !== JSON.stringify(expected[key]))) {
    throw new Error("Standing policy evidence scope, policy version, coordinates or audited reason mismatch");
  }
}
