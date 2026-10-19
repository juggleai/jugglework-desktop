import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequire } from "node:module";

import { createLocalVerificationRecord } from "./verify-packaged-macos.mjs";
const { verifyMacBunSignature } = createRequire(import.meta.url)("./macos-bun-signature.cjs");

describe("upstream macOS Bun signature gate", () => {
  const executable = "/tmp/JuggleWork.app/Contents/Resources/toonFactoryV2/bun";
  const details = [
    "Identifier=bun",
    "CodeDirectory v=20500 flags=0x10000(runtime)",
    "Authority=Developer ID Application: Jarred Sumner (7FRXF46ZSN)",
    "Authority=Developer ID Certification Authority",
    "Authority=Apple Root CA",
    "TeamIdentifier=7FRXF46ZSN",
    "Timestamp=May 13, 2026 at 06:55:32",
  ].join("\n");

  function runner(output = details, status = 0) {
    return (command, args, options) => {
      assert.equal(command, "codesign");
      assert.equal(args.at(-1), executable);
      assert.equal(options.encoding, "utf8");
      if (args.includes("--verify")) {
        assert.ok(args.includes("--strict"));
        const requirement = args[args.indexOf("--test-requirement") + 1];
        assert.match(requirement, /^=anchor apple generic/);
        assert.ok(requirement.includes("certificate 1[field.1.2.840.113635.100.6.2.6] exists"));
        assert.ok(requirement.includes("certificate leaf[field.1.2.840.113635.100.6.1.13] exists"));
        assert.ok(requirement.includes('certificate leaf[subject.OU] = "7FRXF46ZSN"'));
        assert.ok(requirement.includes('identifier "bun"'));
        return { status, stdout: "", stderr: "signature requirement" };
      }
      assert.ok(args.includes("--display"));
      return { status: 0, stdout: "", stderr: output };
    };
  }

  it("requires cryptographic Apple Developer ID trust, upstream Team, hardened runtime, and secure timestamp", () => {
    assert.deepEqual(verifyMacBunSignature(executable, runner()), {
      executableSigned: true, teamIdentifier: "7FRXF46ZSN", hardenedRuntime: true, secureTimestamp: true,
    });
  });

  it("rejects unsigned, untrusted, ad-hoc, re-signed, untimestamped, and non-hardened binaries", () => {
    assert.throws(() => verifyMacBunSignature(executable, runner(details, 1)), /Apple Developer ID signature verification failed/);
    for (const output of [
      `${details}\nSignature=adhoc`,
      details.replace("TeamIdentifier=7FRXF46ZSN", "TeamIdentifier=not set"),
      details.replace("TeamIdentifier=7FRXF46ZSN", "TeamIdentifier=H7PDHSK3C7"),
      details.replace(/^Authority=Developer ID Application:.*$/m, ""),
      details.replace(/^Timestamp=.*$/m, ""),
      details.replace("flags=0x10000(runtime)", "flags=0x2(adhoc)"),
    ]) {
      assert.throws(() => verifyMacBunSignature(executable, runner(output)), /must retain its upstream/);
    }
  });

  it("fails closed when codesign cannot run or inspect the signature", () => {
    assert.throws(() => verifyMacBunSignature(executable, () => ({ error: new Error("ENOENT") })), /verification failed.*ENOENT/);
    assert.throws(() => verifyMacBunSignature(executable, (_command, args) => args.includes("--verify")
      ? { status: 0 } : { status: 1, stderr: "inspection failed" }), /Unable to inspect.*inspection failed/);
  });
});

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
const acceptedDmgTrust = {
  signature: { status: "accepted", teamIdentifier: "H7PDHSK3C7" },
  notarization: { status: "accepted" },
  staple: { status: "validated" },
  gatekeeper: { status: "accepted" },
  image: { status: "verified" },
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
const dmgReceipt = {
  schema: "com.juggleai.jugglework.macos-dmg-notarization-receipt",
  schemaVersion: 1,
  producer: "finalize-macos-artifacts",
  version: "1.2.15",
  teamIdentifier: "H7PDHSK3C7",
  submissionId: "dmg-notary-submission",
  status: "accepted",
  staple: "validated",
  gatekeeper: "accepted",
};

describe("macOS local release verification evidence", () => {
  it("emits release evidence only with credentials and all trust gates", () => {
    const record = createLocalVerificationRecord({
      version: "1.2.15",
      architectures: ["arm64"],
      signature,
      trust: acceptedTrust,
      dmgTrust: acceptedDmgTrust,
      artifacts,
      manifest,
      notarizationReceipt: receipt,
      dmgNotarizationReceipt: dmgReceipt,
      environment: {
        MACOS_NOTARIZE: "true",
        APPLE_NOTARY_KEYCHAIN_PROFILE: "local-profile",
      },
      verifiedAt: "2026-09-08T00:00:00.000Z",
    });
    assert.equal(record.releaseState, "release");
    assert.equal(record.credentialState, "available");
    assert.equal(record.identity.teamIdentifier, "H7PDHSK3C7");
    assert.deepEqual(record.artifacts, artifacts);
    assert.deepEqual(record.manifest, manifest);
    assert.equal(JSON.stringify(record).includes("local-profile"), false);
    assert.equal(record.dmg.notarization.submissionId, "dmg-notary-submission");
  });

  it("emits candidate-only evidence when notarization credentials are absent", () => {
    const record = createLocalVerificationRecord({
      version: "1.2.15",
      architectures: ["arm64"],
      signature,
      trust: acceptedTrust,
      dmgTrust: acceptedDmgTrust,
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
      dmgTrust: acceptedDmgTrust,
      artifacts,
      manifest,
      notarizationReceipt: receipt,
      dmgNotarizationReceipt: dmgReceipt,
      environment: {
        MACOS_NOTARIZE: "true",
        APPLE_API_KEY_PATH: "configured",
        APPLE_API_KEY: "configured",
        APPLE_API_ISSUER: "configured",
      },
    });
    assert.equal(record.releaseState, "candidate");
  });

  it("emits candidate-only evidence when the outer DMG is not notarized", () => {
    const record = createLocalVerificationRecord({
      version: "1.2.15",
      architectures: ["arm64"],
      signature,
      trust: acceptedTrust,
      dmgTrust: { ...acceptedDmgTrust, staple: { status: "unavailable" } },
      artifacts,
      manifest,
      notarizationReceipt: receipt,
      dmgNotarizationReceipt: dmgReceipt,
      environment: { MACOS_NOTARIZE: "true", JUGGLEWORK_NOTARY_PROFILE: "configured" },
    });
    assert.equal(record.releaseState, "candidate");
  });
});
