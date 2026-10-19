const { spawnSync } = require("node:child_process");

// Bun 1.3.14's pinned macOS binaries are upstream-signed, not ad-hoc signed.
const requirement = '=anchor apple generic and identifier "bun" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "7FRXF46ZSN"';

function verifyMacBunSignature(executablePath, run = spawnSync) {
  const verify = run("codesign", ["--verify", "--strict", "--verbose=2", "--test-requirement", requirement, executablePath], { encoding: "utf8" });
  if (verify.error || verify.status !== 0) {
    throw new Error(`Bundled Bun Apple Developer ID signature verification failed: ${verify.error?.message || verify.stderr?.trim() || verify.status}`);
  }
  const details = run("codesign", ["--display", "--verbose=4", executablePath], { encoding: "utf8" });
  if (details.error || details.status !== 0) {
    throw new Error(`Unable to inspect bundled Bun signature: ${details.error?.message || details.stderr?.trim() || details.status}`);
  }
  const output = `${details.stdout || ""}\n${details.stderr || ""}`;
  const teamIdentifier = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  if (teamIdentifier !== "7FRXF46ZSN" || /^Signature=adhoc$/m.test(output)
    || !/^Authority=Developer ID Application:/m.test(output)
    || !/^CodeDirectory .*flags=.*\bruntime\b/m.test(output)
    || !/^Timestamp=\S.+$/m.test(output)) {
    throw new Error("Bundled Bun must retain its upstream Developer ID, hardened runtime, and secure timestamp; ad-hoc or re-signed Bun is not release-compatible");
  }
  return { executableSigned: true, teamIdentifier, hardenedRuntime: true, secureTimestamp: true };
}

module.exports = { verifyMacBunSignature };
