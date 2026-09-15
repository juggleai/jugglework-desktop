import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";
import { assertWindowsReleaseVersion } from "./qiniu-release/constants.mjs";
import { inspectArtifact } from "./qiniu-release/metadata.mjs";

const ARCHITECTURES = ["arm64", "x64"];
const PE_MACHINE = { x64: 0x8664, arm64: 0xaa64 };
const WINDOWS_UPDATE_FEED = "https://downloads.jugglechat.cn/jugglework/releases/stable/windows";
const IMMUTABLE_RELEASE_ROOT = "https://downloads.jugglechat.cn/jugglework/releases";
const LOCAL_VERIFICATION_SCHEMA = "com.juggleai.jugglework.windows-local-verification";
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(message) {
  throw new Error(`[verify-packaged-windows] ${message}`);
}

function readArg(args, name) {
  const inline = args.find((entry) => entry.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1]?.trim() ?? "" : "";
}

function readRepeatedArg(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const entry = args[index];
    if (entry.startsWith(`${name}=`)) values.push(entry.slice(name.length + 1).trim());
    else if (entry === name) values.push(args[index + 1]?.trim() ?? "");
  }
  return values;
}

function normalizePublisherNames(values, source) {
  if (!Array.isArray(values)) fail(`${source} must be a JSON array or one publisher name`);
  if (values.length === 0 || values.some((value) => typeof value !== "string" || !value.trim())) {
    fail(`Expected publisher allowlist from ${source} must not be empty`);
  }
  const names = values.map((value) => value.trim());
  return [...new Set(names)];
}

export function expectedPublisherNames(args = process.argv.slice(2), environment = process.env) {
  const explicit = readRepeatedArg(args, "--publisher-name");
  if (explicit.length > 0) return normalizePublisherNames(explicit, "--publisher-name");

  const raw = String(environment.JUGGLEWORK_WINDOWS_PUBLISHER_NAMES ?? "").trim();
  if (!raw) fail("Pass --publisher-name or set non-empty JUGGLEWORK_WINDOWS_PUBLISHER_NAMES");
  if (!raw.startsWith("[")) return normalizePublisherNames([raw], "JUGGLEWORK_WINDOWS_PUBLISHER_NAMES");
  try {
    return normalizePublisherNames(JSON.parse(raw), "JUGGLEWORK_WINDOWS_PUBLISHER_NAMES");
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail(`JUGGLEWORK_WINDOWS_PUBLISHER_NAMES is not valid JSON: ${error.message}`);
    }
    throw error;
  }
}

export function readPeMachine(filePath) {
  const descriptor = openSync(filePath, "r");
  try {
    const dosHeader = Buffer.alloc(64);
    if (readSync(descriptor, dosHeader, 0, dosHeader.length, 0) !== dosHeader.length || dosHeader.toString("ascii", 0, 2) !== "MZ") {
      fail(`Invalid DOS header in PE executable: ${filePath}`);
    }
    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(6);
    if (readSync(descriptor, peHeader, 0, peHeader.length, peOffset) !== peHeader.length || peHeader.toString("binary", 0, 4) !== "PE\0\0") {
      fail(`Invalid PE header in executable: ${filePath}`);
    }
    return peHeader.readUInt16LE(4);
  } finally {
    closeSync(descriptor);
  }
}

export function verifyPeArchitecture(filePath, arch, inspectMachine = readPeMachine) {
  const expected = PE_MACHINE[arch];
  if (!expected) fail(`Unsupported Windows architecture: ${arch}`);
  const actual = inspectMachine(filePath);
  if (actual !== expected) {
    fail(`PE machine mismatch for ${arch}: expected 0x${expected.toString(16)}, found 0x${actual.toString(16)}`);
  }
  return { arch, machine: `0x${actual.toString(16)}` };
}

function powershellAuthenticodeSignature(filePath) {
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    function Convert-Certificate($certificate) {
      if ($null -eq $certificate) { return $null }
      return [ordered]@{
        subject = [string]$certificate.Subject
        issuer = [string]$certificate.Issuer
        serialNumber = [string]$certificate.SerialNumber
        sha256Thumbprint = [string]$certificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256)
        notBefore = $certificate.NotBefore.ToUniversalTime().ToString('o')
        notAfter = $certificate.NotAfter.ToUniversalTime().ToString('o')
      }
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $env:JUGGLEWORK_AUTHENTICODE_FILE
    [ordered]@{
      status = [string]$signature.Status
      statusMessage = [string]$signature.StatusMessage
      signatureType = [string]$signature.SignatureType
      signerCertificate = Convert-Certificate $signature.SignerCertificate
      timeStamperCertificate = Convert-Certificate $signature.TimeStamperCertificate
    } | ConvertTo-Json -Compress -Depth 4
  `;
  const result = spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, JUGGLEWORK_AUTHENTICODE_FILE: filePath },
  });
  if (result.error) fail(`Unable to run Get-AuthenticodeSignature for ${filePath}: ${result.error.message}`);
  if (result.status !== 0) fail(`Get-AuthenticodeSignature failed for ${filePath}: ${result.stderr.trim()}`);
  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    fail(`Get-AuthenticodeSignature returned invalid JSON for ${filePath}: ${error.message}`);
  }
}

function signToolVerificationOutput(filePath) {
  const signTool = String(process.env.JUGGLEWORK_SIGNTOOL ?? "signtool.exe").trim();
  const result = spawnSync(signTool, ["verify", "/pa", "/all", "/v", filePath], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) fail(`Unable to run signtool verification for ${filePath}: ${result.error.message}`);
  if (result.status !== 0) fail(`signtool verification failed for ${filePath}: ${(result.stderr || result.stdout).trim()}`);
  return `${result.stdout}\n${result.stderr}`;
}

export function parseSignToolSignatureDetails(output, filePath = "<signtool output>") {
  const matches = [...String(output).matchAll(/^\s*Hash of file \(([^)]+)\):\s*[0-9a-f]+\s*$/gim)];
  if (matches.length !== 1 || !matches[0][1].trim()) {
    fail(`signtool did not return exactly one explicit Authenticode digest algorithm for ${filePath}`);
  }
  return { digestAlgorithm: matches[0][1].trim().toUpperCase() };
}

function signToolAuthenticodeSignatureDetails(filePath) {
  return parseSignToolSignatureDetails(signToolVerificationOutput(filePath), filePath);
}

function signToolAuthenticodeTimestamp(filePath, signature) {
  const output = signToolVerificationOutput(filePath);
  const matches = [...output.matchAll(/^\s*The signature is timestamped:\s*(.+?)\s*$/gim)];
  if (matches.length !== 1 || !Number.isFinite(Date.parse(matches[0][1]))) {
    fail(`signtool did not return exactly one parseable trusted signing time for ${filePath}`);
  }
  return {
    status: "trusted",
    authority: signature?.timeStamperCertificate?.subject,
    signedAt: new Date(matches[0][1]).toISOString(),
  };
}

function requiredSignerCertificate(certificate, filePath) {
  const requiredStrings = ["subject", "issuer", "serialNumber"];
  for (const field of requiredStrings) {
    if (typeof certificate?.[field] !== "string" || !certificate[field].trim()) {
      fail(`Authenticode signer certificate ${field} is missing for ${filePath}`);
    }
  }
  if (typeof certificate.sha256Thumbprint !== "string" || !/^[0-9a-f]{64}$/i.test(certificate.sha256Thumbprint)) {
    fail(`Authenticode signer certificate SHA-256 thumbprint is missing or invalid for ${filePath}`);
  }
  const notBefore = Date.parse(certificate.notBefore);
  const notAfter = Date.parse(certificate.notAfter);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || notBefore >= notAfter) {
    fail(`Authenticode signer certificate validity period is missing or invalid for ${filePath}`);
  }
  return {
    subject: certificate.subject,
    issuer: certificate.issuer,
    serialNumber: certificate.serialNumber,
    sha256Thumbprint: certificate.sha256Thumbprint.toUpperCase(),
    notBefore: new Date(notBefore).toISOString(),
    notAfter: new Date(notAfter).toISOString(),
  };
}

export function verifyAuthenticodeSignature(
  filePath,
  publisherNames,
  inspectSignature = powershellAuthenticodeSignature,
  inspectTimestamp = signToolAuthenticodeTimestamp,
  inspectSignatureDetails = signToolAuthenticodeSignatureDetails,
) {
  const signature = inspectSignature(filePath);
  if (signature?.status !== "Valid") {
    fail(`Authenticode status for ${filePath} must be Valid, found ${signature?.status || "<missing>"}`);
  }
  if (signature.signatureType !== "Authenticode") {
    fail(`Signature type for ${filePath} must be Authenticode, found ${signature.signatureType || "<missing>"}`);
  }
  const signerCertificate = requiredSignerCertificate(signature.signerCertificate, filePath);
  if (!signature.timeStamperCertificate || typeof signature.timeStamperCertificate.subject !== "string" || !signature.timeStamperCertificate.subject.trim()) {
    fail(`Authenticode timestamp certificate is missing for ${filePath}`);
  }
  if (!publisherNames.includes(signerCertificate.subject)) {
    fail(`Authenticode publisher is not allowlisted for ${filePath}: ${signerCertificate.subject}`);
  }
  const signatureDetails = inspectSignatureDetails(filePath, signature);
  if (signatureDetails?.digestAlgorithm !== "SHA256") {
    fail(`Authenticode digest algorithm for ${filePath} must be SHA256, found ${signatureDetails?.digestAlgorithm || "<missing>"}`);
  }
  const trustedTimestamp = inspectTimestamp(filePath, signature);
  if (trustedTimestamp?.status !== "trusted") {
    fail(`Authenticode timestamp status for ${filePath} must be trusted`);
  }
  if (trustedTimestamp.authority !== signature.timeStamperCertificate.subject) {
    fail(`Authenticode timestamp authority does not match the verified timestamp certificate for ${filePath}`);
  }
  if (typeof trustedTimestamp.signedAt !== "string" || !Number.isFinite(Date.parse(trustedTimestamp.signedAt))) {
    fail(`Authenticode trusted signing time is missing or invalid for ${filePath}`);
  }
  const signedAt = new Date(trustedTimestamp.signedAt).toISOString();
  if (Date.parse(signedAt) < Date.parse(signerCertificate.notBefore) || Date.parse(signedAt) > Date.parse(signerCertificate.notAfter)) {
    fail(`Authenticode trusted signing time is outside the signer certificate validity period for ${filePath}`);
  }
  return {
    ...signature,
    signerCertificate,
    digestAlgorithm: "SHA256",
    trustedTimestamp: {
      status: "trusted",
      authority: trustedTimestamp.authority,
      signedAt,
    },
  };
}

function filesRecursively(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name);
    return entry.isDirectory() ? filesRecursively(child) : entry.isFile() ? [child] : [];
  });
}

function findSingle(paths, label) {
  if (paths.length !== 1) fail(`Expected exactly one ${label}, found ${paths.length}`);
  return paths[0];
}

function readYaml(filePath, label) {
  try {
    return parseYaml(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Unable to read ${label} ${filePath}: ${error.message}`);
  }
}

function publisherNamesFromConfig(value) {
  if (typeof value === "string") return [value.trim()];
  if (Array.isArray(value)) return value.map((entry) => String(entry ?? "").trim());
  return [];
}

export function verifyPackagedUpdateConfiguration(stagingDirectory, expectedPublishers) {
  const updateConfigPath = findSingle(
    filesRecursively(stagingDirectory).filter((filePath) => path.basename(filePath).toLowerCase() === "app-update.yml"),
    `packaged app-update.yml in ${stagingDirectory}`,
  );
  const config = readYaml(updateConfigPath, "packaged updater configuration");
  if (config?.provider !== "generic") fail(`${updateConfigPath} must use the generic provider`);
  if (config.url !== WINDOWS_UPDATE_FEED) {
    fail(`Expected Windows updater feed ${WINDOWS_UPDATE_FEED}, found ${config?.url || "<missing>"}`);
  }
  const configuredPublishers = publisherNamesFromConfig(config.publisherName);
  if (configuredPublishers.length === 0 || JSON.stringify(configuredPublishers) !== JSON.stringify(expectedPublishers)) {
    fail(`${updateConfigPath} publisherName must exactly match the expected publisher allowlist`);
  }
  return { path: updateConfigPath, provider: config.provider, url: config.url, publisherName: configuredPublishers };
}

function verifyStagingManifest(manifestPath, { arch, version, executableName, metadata }) {
  const manifest = readYaml(manifestPath, `${arch} staging manifest`);
  if (manifest?.version !== version) fail(`${arch} latest.yml version must be ${version}`);
  if (!Array.isArray(manifest.files) || manifest.files.length !== 1) {
    fail(`${arch} latest.yml must contain exactly one EXE`);
  }
  const file = manifest.files[0];
  if (file?.url !== executableName || manifest.path !== executableName) {
    fail(`${arch} latest.yml must reference ${executableName}`);
  }
  if (file.size !== metadata.size || file.sha512 !== metadata.sha512 || manifest.sha512 !== metadata.sha512) {
    fail(`${arch} latest.yml size or SHA-512 does not match ${executableName}`);
  }
  return manifest;
}

function expectedArtifactUrl(version, arch, name) {
  return `${IMMUTABLE_RELEASE_ROOT}/v${version}/windows/${arch}/${name}`;
}

function verifyMergedManifest(manifestPath, version, artifactsByArch) {
  const manifest = readYaml(manifestPath, "merged Qiniu manifest");
  if (manifest?.version !== version) fail(`Merged Qiniu manifest version must be ${version}`);
  const unexpectedTopLevelField = Object.keys(manifest).find((field) => !["version", "files", "releaseDate"].includes(field));
  if (unexpectedTopLevelField) {
    fail(`Merged Qiniu manifest has an unsupported or architecture-biased top-level field: ${unexpectedTopLevelField}`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== ARCHITECTURES.length) {
    fail("Merged Qiniu manifest must contain one EXE URL for each Windows architecture");
  }
  const expected = ARCHITECTURES.map((arch) => {
    const artifact = artifactsByArch[arch];
    return {
      arch,
      url: expectedArtifactUrl(version, arch, artifact.name),
      size: artifact.metadata.size,
      sha512: artifact.metadata.sha512,
    };
  });
  const seen = new Set();
  for (const file of manifest.files) {
    const unexpectedFileField = Object.keys(file ?? {}).find((field) => !["url", "sha512", "size"].includes(field));
    if (unexpectedFileField) {
      fail(`Merged Qiniu manifest files must not use unsupported or architecture selector field: ${unexpectedFileField}`);
    }
    const match = expected.find((item) => item.url === file?.url);
    if (!match || seen.has(match.arch)) fail(`Merged Qiniu manifest has an unexpected or duplicate architecture URL: ${file?.url || "<missing>"}`);
    if (file.size !== match.size || file.sha512 !== match.sha512) {
      fail(`Merged Qiniu manifest size or SHA-512 mismatch for ${match.arch}`);
    }
    seen.add(match.arch);
  }
  return manifest;
}

async function regenerateBlockmap(executablePath, outputPath) {
  const require = createRequire(import.meta.url);
  const electronBuilderEntry = require.resolve("electron-builder");
  const electronBuilderRequire = createRequire(electronBuilderEntry);
  const { buildBlockMap } = electronBuilderRequire("app-builder-lib/out/targets/blockmap/blockmap.js");
  await buildBlockMap(executablePath, "gzip", outputPath);
}

async function verifyPublishedBlockmap(executablePath, blockmapPath, generateBlockmap) {
  const directory = mkdtempSync(path.join(tmpdir(), "jugglework-windows-blockmap-"));
  const regeneratedPath = path.join(directory, path.basename(blockmapPath));
  try {
    await generateBlockmap(executablePath, regeneratedPath);
    if (!existsSync(regeneratedPath)) fail(`Blockmap regeneration did not create ${regeneratedPath}`);
    if (!readFileSync(regeneratedPath).equals(readFileSync(blockmapPath))) {
      fail(`Published blockmap differs from a fresh blockmap for ${path.basename(executablePath)}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function createWindowsLocalVerificationRecord({
  version,
  publisherNames,
  architectureResults,
  manifest,
  manifestMetadata,
  verifiedAt = new Date().toISOString(),
}) {
  return {
    schema: LOCAL_VERIFICATION_SCHEMA,
    schemaVersion: 1,
    producer: "verify-packaged-windows",
    result: "passed",
    version,
    platform: "windows",
    architectures: ARCHITECTURES,
    verifiedAt,
    releaseState: "release",
    approvedPublishers: publisherNames,
    packagedUpdater: {
      provider: architectureResults[0]?.updater.provider,
      feedUrl: architectureResults[0]?.updater.url,
      publisherNames,
    },
    artifacts: architectureResults.flatMap(({ arch, pe, signature, executable, blockmap }) => [
      {
        arch,
        type: "exe",
        name: executable.name,
        ...executable.metadata,
        peArchitecture: pe.arch,
        authenticode: {
          status: "valid",
          digestAlgorithm: signature.digestAlgorithm,
          publisher: signature.signerCertificate.subject,
          signerCertificate: signature.signerCertificate,
          timestamp: signature.trustedTimestamp,
        },
      },
      {
        arch,
        type: "exe.blockmap",
        name: blockmap.name,
        ...blockmap.metadata,
        postSign: {
          status: "verified",
          executableName: executable.name,
          executableSha256: executable.metadata.sha256,
        },
      },
    ]),
    manifest: { name: path.basename(manifest), ...manifestMetadata },
  };
}

export async function verifyPackagedWindows(options, dependencies = {}) {
  const inspect = dependencies.inspectArtifact ?? inspectArtifact;
  const inspectSignature = dependencies.inspectSignature ?? powershellAuthenticodeSignature;
  const inspectTimestamp = dependencies.inspectTimestamp ?? signToolAuthenticodeTimestamp;
  const inspectSignatureDetails = dependencies.inspectSignatureDetails ?? signToolAuthenticodeSignatureDetails;
  const inspectMachine = dependencies.inspectMachine ?? readPeMachine;
  const generateBlockmap = dependencies.generateBlockmap ?? regenerateBlockmap;
  const version = String(options.version ?? "").trim();
  if (!STABLE_VERSION.test(version)) fail(`A stable x.y.z release version is required, found ${version || "<empty>"}`);
  try {
    assertWindowsReleaseVersion(version);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const publisherNames = normalizePublisherNames(options.publisherNames, "expected publisher allowlist");
  const architectureResults = [];
  for (const arch of ARCHITECTURES) {
    const stagingDirectory = path.resolve(options.stagingDirectories?.[arch] ?? "");
    if (!options.stagingDirectories?.[arch] || !existsSync(stagingDirectory)) {
      fail(`Missing ${arch} staging directory: ${stagingDirectory}`);
    }
    const executableName = `jugglework-win-${arch}-${version}.exe`;
    const executablePath = findSingle(
      filesRecursively(stagingDirectory).filter((filePath) => path.basename(filePath) === executableName),
      `${arch} final installer ${executableName}`,
    );
    const blockmapPath = `${executablePath}.blockmap`;
    if (!existsSync(blockmapPath) || !statSync(blockmapPath).isFile()) fail(`Missing published blockmap: ${blockmapPath}`);
    const latestPath = path.join(stagingDirectory, "latest.yml");
    if (!existsSync(latestPath)) fail(`Missing ${arch} staging latest.yml: ${latestPath}`);

    const pe = verifyPeArchitecture(executablePath, arch, inspectMachine);
    const signature = verifyAuthenticodeSignature(
      executablePath,
      publisherNames,
      inspectSignature,
      inspectTimestamp,
      inspectSignatureDetails,
    );
    const metadata = await inspect(executablePath);
    const blockmapMetadata = await inspect(blockmapPath);
    await verifyPublishedBlockmap(executablePath, blockmapPath, generateBlockmap);
    const latest = verifyStagingManifest(latestPath, { arch, version, executableName, metadata });
    const updater = verifyPackagedUpdateConfiguration(stagingDirectory, publisherNames);
    architectureResults.push({
      arch,
      stagingDirectory,
      pe,
      signature,
      updater,
      latest,
      latestPath,
      executable: { path: executablePath, name: executableName, metadata },
      blockmap: { path: blockmapPath, name: path.basename(blockmapPath), metadata: blockmapMetadata },
    });
  }

  const signerSubjects = new Set(architectureResults.map((result) => result.signature.signerCertificate.subject));
  if (signerSubjects.size !== 1) fail("x64 and arm64 installers must have the same Authenticode publisher");
  const artifactsByArch = Object.fromEntries(architectureResults.map((result) => [result.arch, result.executable]));
  const manifestPath = path.resolve(options.manifestPath);
  if (!existsSync(manifestPath)) fail(`Merged Qiniu manifest not found: ${manifestPath}`);
  const manifest = verifyMergedManifest(manifestPath, version, artifactsByArch);
  const manifestMetadata = await inspect(manifestPath);
  const localVerification = createWindowsLocalVerificationRecord({
    version,
    publisherNames,
    architectureResults,
    manifest: manifestPath,
    manifestMetadata,
    verifiedAt: options.verifiedAt,
  });
  if (options.verificationOutput) {
    const outputPath = path.resolve(options.verificationOutput);
    writeFileSync(outputPath, `${JSON.stringify(localVerification, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  return { ok: true, version, publisherNames, manifest, architectureResults, localVerification };
}

export async function main(args = process.argv.slice(2), environment = process.env) {
  if (process.platform !== "win32") fail("Packaged Windows verification must run on Windows");
  const version = readArg(args, "--version");
  const stagingRoot = readArg(args, "--staging-root") || readArg(args, "--dist");
  const x64Directory = readArg(args, "--x64-dir") || (stagingRoot ? path.join(stagingRoot, "x64") : "");
  const arm64Directory = readArg(args, "--arm64-dir") || (stagingRoot ? path.join(stagingRoot, "arm64") : "");
  if (!x64Directory || !arm64Directory) fail("Pass --staging-root or both --x64-dir and --arm64-dir");
  const manifestPath = readArg(args, "--manifest") || (stagingRoot && version ? path.join(stagingRoot, `qiniu-v${version}-latest.yml`) : "");
  if (!manifestPath) fail("Pass --manifest (or --staging-root with --version)");
  const verificationOutput = readArg(args, "--verification-output");
  if (!verificationOutput) fail("Pass --verification-output for windows-local-verification JSON");
  const result = await verifyPackagedWindows({
    version,
    stagingDirectories: { x64: x64Directory, arm64: arm64Directory },
    manifestPath,
    publisherNames: expectedPublisherNames(args, environment),
    verificationOutput,
  });
  process.stdout.write(`${JSON.stringify({
    ok: result.ok,
    version: result.version,
    publisherNames: result.publisherNames,
    verificationOutput: path.resolve(verificationOutput),
    localVerification: result.localVerification,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
