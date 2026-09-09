const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const computerUseHelperAppName = "JuggleWork Computer Use.app";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}

function runJson(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${command} did not return valid JSON`);
  }
}

async function runWithRetry(command, args, attempts, baseDelayMs = 30_000) {
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.status === 0) return;
    if (attempt >= attempts) {
      throw new Error(`${command} ${args.join(" ")} failed with status ${result.status} after ${attempts} attempts`);
    }
    const delayMs = baseDelayMs * attempt;
    console.warn(
      `[electron-after-sign] ${command} ${args.join(" ")} failed with status ${result.status}; retrying in ${delayMs / 1000}s (attempt ${attempt}/${attempts}).`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required to notarize the Electron macOS app`);
  }
  return value;
}

function computerUseHelperPath(appPath) {
  return path.join(appPath, "Contents", "Resources", "helpers", computerUseHelperAppName);
}

function verifyComputerUseHelper(appPath, requireDistributionSignature) {
  const helperPath = computerUseHelperPath(appPath);
  if (!existsSync(helperPath)) {
    throw new Error(`Computer Use helper app is missing from packaged app: ${helperPath}`);
  }

  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", helperPath]);

  if (!requireDistributionSignature) return;
  const result = spawnSync("codesign", ["--display", "--verbose=4", helperPath], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`codesign --display failed for Computer Use helper with status ${result.status}`);
  }
  if (result.stderr.includes("Signature=adhoc")) {
    throw new Error("Computer Use helper app is ad-hoc signed; notarized builds require a Developer ID signature.");
  }
}

async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  if (process.env.MACOS_NOTARIZE !== "true") {
    console.warn("[electron-after-sign] MACOS_NOTARIZE is not true; skipping notarization.");
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  verifyComputerUseHelper(appPath, process.env.MACOS_NOTARIZE === "true");

  const notaryTempDir = mkdtempSync(path.join(tmpdir(), "jugglework-electron-notary-"));
  const notaryZipPath = path.join(notaryTempDir, `${context.packager.appInfo.productFilename}-notary.zip`);
  const keyPath = requireEnv("APPLE_API_KEY_PATH");
  const keyId = requireEnv("APPLE_API_KEY");
  const issuer = requireEnv("APPLE_API_ISSUER");

  try {
    run("ditto", ["-c", "-k", "--keepParent", appPath, notaryZipPath]);
    const submission = runJson("xcrun", [
      "notarytool",
      "submit",
      notaryZipPath,
      "--key",
      keyPath,
      "--key-id",
      keyId,
      "--issuer",
      issuer,
      "--wait",
      "--output-format",
      "json",
    ]);
    if (submission.status !== "Accepted" || typeof submission.id !== "string" || !submission.id) {
      throw new Error("Apple notarization submission was not accepted");
    }
    // Notarization tickets can take minutes to propagate to Apple's CDN after acceptance; stapler can transiently fail with status 65 ("CloudKit query failed").
    await runWithRetry("xcrun", ["stapler", "staple", appPath], 5);
    run("xcrun", ["stapler", "validate", appPath]);
    const receiptPath = path.join(context.appOutDir, "jugglework-notarization-receipt.json");
    writeFileSync(receiptPath, `${JSON.stringify({
      schema: "com.juggleai.jugglework.macos-notarization-receipt",
      schemaVersion: 1,
      producer: "electron-after-sign",
      version: context.packager.appInfo.version,
      bundleIdentifier: "com.juggleai.jugglework",
      submissionId: submission.id,
      status: "accepted",
      staple: "validated",
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } finally {
    rmSync(notaryTempDir, { recursive: true, force: true });
  }
}

module.exports = afterSign;
module.exports.default = afterSign;
module.exports.runWithRetry = runWithRetry;
module.exports.runJson = runJson;
