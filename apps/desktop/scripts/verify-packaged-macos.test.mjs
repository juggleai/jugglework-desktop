import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLocalVerificationRecord } from "./verify-packaged-macos.mjs";

const signature = {
  identifier: "com.juggleai.jugglework",
  teamIdentifier: "H7PDHSK3C7",
  hardenedRuntime: true,
};
const acceptedTrust = {
  notarization: { status: "accepted" },
  staple: { status: "validated" },
  gatekeeper: { status: "accepted" },
};
const artifacts = [
  { name: "app.zip", size: 1, sha256: "a".repeat(64), sha512: "zip", etag: "etag-zip" },
];
const manifest = { name: "latest-mac.yml", size: 2, sha256: "b".repeat(64), sha512: "manifest", etag: "etag-manifest" };
const receipt = {
  schema: "com.juggleai.jugglework.macos-notarization-receipt",
  schemaVersion: 1,
  producer: "electron-after-sign",
  version: "1.2.15",
  bundleIdentifier: "com.juggleai.jugglework",
  submissionId: "notary-submission",
  status: "accepted",
  staple: "validated",
};

describe("macOS local release verification evidence", () => {
  it("emits release evidence only with credentials and all trust gates", () => {
    const record = createLocalVerificationRecord({
      version: "1.2.15",
      architectures: ["arm64"],
      signature,
      trust: acceptedTrust,
      artifacts,
      manifest,
      notarizationReceipt: receipt,
      environment: {
        MACOS_NOTARIZE: "true",
        APPLE_API_KEY_PATH: "/private/notary-key",
        APPLE_API_KEY: "configured",
        APPLE_API_ISSUER: "configured",
      },
      verifiedAt: "2026-09-08T00:00:00.000Z",
    });
    assert.equal(record.releaseState, "release");
    assert.equal(record.credentialState, "available");
    assert.equal(record.identity.teamIdentifier, "H7PDHSK3C7");
    assert.deepEqual(record.artifacts, artifacts);
    assert.deepEqual(record.manifest, manifest);
    assert.equal(JSON.stringify(record).includes("/private/notary-key"), false);
  });

  it("emits candidate-only evidence when notarization credentials are absent", () => {
    const record = createLocalVerificationRecord({
      version: "1.2.15",
      architectures: ["arm64"],
      signature,
      trust: acceptedTrust,
      artifacts,
      manifest,
      notarizationReceipt: null,
      environment: {},
    });
    assert.equal(record.releaseState, "candidate");
    assert.equal(record.credentialState, "missing");
  });

  it("emits candidate-only evidence when any trust gate fails", () => {
    const record = createLocalVerificationRecord({
      version: "1.2.15",
      architectures: ["arm64"],
      signature,
      trust: { ...acceptedTrust, gatekeeper: { status: "unavailable" } },
      artifacts,
      manifest,
      notarizationReceipt: receipt,
      environment: {
        MACOS_NOTARIZE: "true",
        APPLE_API_KEY_PATH: "configured",
        APPLE_API_KEY: "configured",
        APPLE_API_ISSUER: "configured",
      },
    });
    assert.equal(record.releaseState, "candidate");
  });
});
