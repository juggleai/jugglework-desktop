import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  expectedPublisherNames,
  parseSignToolSignatureDetails,
  readPeMachine,
  verifyPackagedWindows,
} from "./verify-packaged-windows.mjs";
import { assertLocalVerification } from "./qiniu-release/evidence.mjs";
import { inspectArtifact } from "./qiniu-release/metadata.mjs";
import { inventoryToonFactoryBundle, sha256File, trustedBunForTarget } from "../electron/toonFactoryBundle.mjs";

const VERSION = "1.2.18";
const PUBLISHER = "CN=Example Publisher, O=Example Corp, C=US";
const FEED = "https://downloads.jugglechat.cn/jugglework/releases/stable/windows";
const SIGNED_AT = "2026-09-13T12:34:56.000Z";

function metadata(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return {
    size: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    sha512: createHash("sha512").update(buffer).digest("base64"),
  };
}

function pe(machine, marker) {
  const buffer = Buffer.alloc(512, marker);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.write("PE\0\0", 0x80, "binary");
  buffer.writeUInt16LE(machine, 0x84);
  return buffer;
}

const FIXTURE_BUN_RELEASE = {
  version: "1.3.14",
  repositoryUrl: "https://github.com/oven-sh/bun",
  releaseUrl: "https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14",
  shasumsUrl: "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/SHASUMS256.txt",
  targets: Object.fromEntries([
    ["arm64", 0xaa64],
    ["x64", 0x8664],
  ].map(([arch, machine]) => [`win32-${arch}`, {
    archiveName: `bun-windows-${arch}.zip`,
    archiveSha256: "a".repeat(64),
    binarySha256: createHash("sha256").update(pe(machine, 0x62)).digest("hex"),
  }])),
};

function signature(subject = PUBLISHER) {
  return {
    status: "Valid",
    statusMessage: "Signature verified.",
    signatureType: "Authenticode",
    signerCertificate: {
      subject,
      issuer: "CN=Example Issuing CA",
      serialNumber: "010203",
      sha256Thumbprint: "A".repeat(64),
      notBefore: "2026-01-01T00:00:00.000Z",
      notAfter: "2027-01-01T00:00:00.000Z",
    },
    timeStamperCertificate: {
      subject: "CN=Example Timestamp Authority",
      issuer: "CN=Example Timestamp Root",
      serialNumber: "040506",
      sha256Thumbprint: "B".repeat(64),
      notBefore: "2026-01-01T00:00:00.000Z",
      notAfter: "2036-01-01T00:00:00.000Z",
    },
  };
}

function writeManifest(filePath, value) {
  writeFileSync(filePath, stringifyYaml(value), "utf8");
}

function createToonFactoryBundle(resources, arch, machine) {
  const root = path.join(resources, "toonFactoryV2");
  for (const name of ["server", "web", "tools", "nodes", "skills"]) mkdirSync(path.join(root, name), { recursive: true });
  writeFileSync(path.join(root, "server", "jugglework.js"), "server");
  for (const name of ["web", "tools", "nodes", "skills"]) writeFileSync(path.join(root, name, "fixture.txt"), name);
  const executablePath = path.join(root, "bun.exe");
  writeFileSync(executablePath, pe(machine, 0x62));
  const trusted = trustedBunForTarget("win32", arch, FIXTURE_BUN_RELEASE);
  const files = inventoryToonFactoryBundle(root);
  writeFileSync(path.join(root, "build-manifest.json"), JSON.stringify({
    schemaVersion: 3,
    target: { platform: "win32", arch, executableName: "bun.exe", format: "pe" },
    bun: { version: "1.3.14", platform: "win32", arch, executableName: "bun.exe", format: "pe", bytes: statSync(executablePath).size, sha256: sha256File(executablePath), provenance: trusted.provenance },
    inventorySha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    files,
  }));
}

function createFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "jugglework-verify-windows-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = {};
  for (const [arch, machine, marker] of [["arm64", 0xaa64, 0x61], ["x64", 0x8664, 0x78]]) {
    const directory = path.join(root, arch);
    const resources = path.join(directory, `${arch}-unpacked`, "resources");
    mkdirSync(resources, { recursive: true });
    const name = `jugglework-win-${arch}-${VERSION}.exe`;
    const executable = pe(machine, marker);
    const blockmap = Buffer.from(`blockmap-${arch}`);
    const executablePath = path.join(directory, name);
    writeFileSync(executablePath, executable);
    writeFileSync(`${executablePath}.blockmap`, blockmap);
    writeManifest(path.join(directory, "latest.yml"), {
      version: VERSION,
      files: [{ url: name, ...metadata(executable) }],
      path: name,
      sha512: metadata(executable).sha512,
    });
    writeManifest(path.join(resources, "app-update.yml"), {
      provider: "generic",
      url: FEED,
      publisherName: [PUBLISHER],
    });
    createToonFactoryBundle(resources, arch, machine);
    artifacts[arch] = { directory, name, executable, blockmap, executablePath };
  }

  const mergedManifestPath = path.join(root, `qiniu-v${VERSION}-latest.yml`);
  const files = ["arm64", "x64"].map((arch) => ({
    url: `https://downloads.jugglechat.cn/jugglework/releases/v${VERSION}/windows/${arch}/${artifacts[arch].name}`,
    sha512: metadata(artifacts[arch].executable).sha512,
    size: artifacts[arch].executable.length,
  }));
  writeManifest(mergedManifestPath, {
    version: VERSION,
    files,
  });
  return { root, artifacts, mergedManifestPath };
}

function options(fixture, overrides = {}) {
  return {
    version: VERSION,
    stagingDirectories: {
      arm64: fixture.artifacts.arm64.directory,
      x64: fixture.artifacts.x64.directory,
    },
    manifestPath: fixture.mergedManifestPath,
    publisherNames: [PUBLISHER],
    verifiedAt: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  return {
    inspectSignature: () => signature(),
    inspectSignatureDetails: () => ({ digestAlgorithm: "SHA256" }),
    inspectTimestamp: (_filePath, inspectedSignature) => ({
      status: "trusted",
      authority: inspectedSignature.timeStamperCertificate.subject,
      signedAt: SIGNED_AT,
    }),
    generateBlockmap: async (executablePath, outputPath) => {
      const arch = path.basename(executablePath).includes("arm64") ? "arm64" : "x64";
      writeFileSync(outputPath, `blockmap-${arch}`);
    },
    trustedBunRelease: FIXTURE_BUN_RELEASE,
    // These fixtures exercise installer trust independently of the unsupported media target gate.
    verifyMediaTools: () => ({ fixture: true }),
    ...overrides,
  };
}

describe("Windows packaged release verifier", () => {
  it("reads x64 and arm64 PE machine values", (t) => {
    const fixture = createFixture(t);
    assert.equal(readPeMachine(fixture.artifacts.x64.executablePath), 0x8664);
    assert.equal(readPeMachine(fixture.artifacts.arm64.executablePath), 0xaa64);
  });

  it("requires an explicit non-empty publisher allowlist without guessing", () => {
    assert.throws(() => expectedPublisherNames([], {}), /Pass --publisher-name/);
    assert.throws(
      () => expectedPublisherNames([], { JUGGLEWORK_WINDOWS_PUBLISHER_NAMES: "[]" }),
      /must not be empty/,
    );
    assert.deepEqual(
      expectedPublisherNames(["--publisher-name", PUBLISHER, `--publisher-name=${PUBLISHER} 2`], {}),
      [PUBLISHER, `${PUBLISHER} 2`],
    );
    assert.deepEqual(
      expectedPublisherNames([], { JUGGLEWORK_WINDOWS_PUBLISHER_NAMES: JSON.stringify([PUBLISHER]) }),
      [PUBLISHER],
    );
  });

  it("parses only an explicit signtool Authenticode file digest algorithm", () => {
    assert.deepEqual(
      parseSignToolSignatureDetails("Hash of file (sha256): ABCDEF0123456789", "fixture.exe"),
      { digestAlgorithm: "SHA256" },
    );
    assert.throws(
      () => parseSignToolSignatureDetails("Successfully verified: fixture.exe", "fixture.exe"),
      /exactly one explicit Authenticode digest algorithm/,
    );
    assert.throws(
      () => parseSignToolSignatureDetails("Hash of file (sha256): AA\nHash of file (sha256): BB", "fixture.exe"),
      /exactly one explicit Authenticode digest algorithm/,
    );
  });

  it("rejects non-stable versions", async (t) => {
    const fixture = createFixture(t);
    await assert.rejects(
      verifyPackagedWindows(options(fixture, { version: `${VERSION}-alpha.1` }), dependencies()),
      /stable x\.y\.z release version is required/,
    );
  });

  it("rejects Windows version 1.2.17", async (t) => {
    const fixture = createFixture(t);
    await assert.rejects(
      verifyPackagedWindows(options(fixture, { version: "1.2.17" }), dependencies()),
      /greater than 1\.2\.17/,
    );
  });

  it("verifies both signed staging directories and emits secret-free evidence", async (t) => {
    const fixture = createFixture(t);
    const output = path.join(fixture.root, "windows-local-verification.json");
    const result = await verifyPackagedWindows(
      options(fixture, { verificationOutput: output }),
      dependencies(),
    );

    assert.equal(result.ok, true);
    assert.equal(result.localVerification.result, "passed");
    assert.deepEqual(result.localVerification.architectures, ["arm64", "x64"]);
    assert.deepEqual(result.localVerification.approvedPublishers, [PUBLISHER]);
    assert.deepEqual(result.localVerification.packagedUpdater, {
      provider: "generic",
      feedUrl: FEED,
      publisherNames: [PUBLISHER],
    });
    assert.deepEqual(
      result.localVerification.artifacts.filter((artifact) => artifact.type === "exe").map((artifact) => artifact.peArchitecture),
      ["arm64", "x64"],
    );
    assert.deepEqual(result.architectureResults.map(({ arch, toonFactory }) => ({ arch, executable: toonFactory.executable })), [
      { arch: "arm64", executable: { platform: "win32", arch: "arm64", format: "pe" } },
      { arch: "x64", executable: { platform: "win32", arch: "x64", format: "pe" } },
    ]);
    assert.equal(result.localVerification.artifacts.filter((artifact) => artifact.type === "exe").every((artifact) => (
      artifact.authenticode.status === "valid"
      && artifact.authenticode.digestAlgorithm === "SHA256"
      && artifact.authenticode.publisher === PUBLISHER
      && artifact.authenticode.signerCertificate.subject === PUBLISHER
      && artifact.authenticode.signerCertificate.issuer === "CN=Example Issuing CA"
      && artifact.authenticode.signerCertificate.serialNumber === "010203"
      && artifact.authenticode.signerCertificate.sha256Thumbprint === "A".repeat(64)
      && artifact.authenticode.signerCertificate.notBefore === "2026-01-01T00:00:00.000Z"
      && artifact.authenticode.signerCertificate.notAfter === "2027-01-01T00:00:00.000Z"
      && artifact.authenticode.timestamp.status === "trusted"
      && artifact.authenticode.timestamp.authority === "CN=Example Timestamp Authority"
      && artifact.authenticode.timestamp.signedAt === SIGNED_AT
    )), true);
    assert.equal(result.localVerification.artifacts.filter((artifact) => artifact.type === "exe.blockmap").every((artifact) => (
      artifact.postSign.status === "verified"
      && artifact.postSign.executableName === artifact.name.replace(/\.blockmap$/, "")
    )), true);
    assert.equal(result.localVerification.artifacts.length, 4);
    assert.deepEqual(result.localVerification.manifest, {
      name: path.basename(fixture.mergedManifestPath),
      ...metadata(readFileSync(fixture.mergedManifestPath)),
      etag: result.localVerification.manifest.etag,
      mime: result.localVerification.manifest.mime,
    });
    assert.equal(result.localVerification.releaseState, "release");
    const evidenceText = readFileSync(output, "utf8");
    assert.deepEqual(JSON.parse(evidenceText), result.localVerification);
    assert.doesNotMatch(evidenceText, /password|token|private.?key/i);
  });

  it("blocks real Windows media verification until a native recipe exists", async (t) => {
    const fixture = createFixture(t);
    await assert.rejects(verifyPackagedWindows(options(fixture), dependencies({ verifyMediaTools: undefined })), /Unsupported native target win32/);
  });

  it("rejects a wrong PE machine", async (t) => {
    const fixture = createFixture(t);
    await assert.rejects(
      verifyPackagedWindows(options(fixture), dependencies({ inspectMachine: () => 0x8664 })),
      /PE machine mismatch for arm64/,
    );
  });

  it("rejects invalid, unallowlisted, or untimestamped Authenticode signatures", async (t) => {
    const fixture = createFixture(t);
    await assert.rejects(
      verifyPackagedWindows(options(fixture), dependencies({ inspectSignature: () => ({ ...signature(), status: "NotSigned" }) })),
      /must be Valid/,
    );
    await assert.rejects(
      verifyPackagedWindows(options(fixture), dependencies({ inspectSignature: () => ({ ...signature(), signatureType: "Catalog" }) })),
      /must be Authenticode/,
    );
    await assert.rejects(
      verifyPackagedWindows(options(fixture), dependencies({ inspectSignature: () => signature("CN=Wrong Publisher") })),
      /not allowlisted/,
    );
    await assert.rejects(
      verifyPackagedWindows(options(fixture), dependencies({ inspectSignature: () => ({ ...signature(), timeStamperCertificate: null }) })),
      /timestamp certificate is missing/,
    );
    await assert.rejects(
      verifyPackagedWindows(options(fixture), dependencies({ inspectTimestamp: () => null })),
      /timestamp status.*trusted/,
    );
    await assert.rejects(
      verifyPackagedWindows(options(fixture), dependencies({
        inspectTimestamp: () => ({ status: "trusted", authority: "CN=Wrong Timestamp Authority", signedAt: SIGNED_AT }),
      })),
      /timestamp authority does not match/,
    );
    await assert.rejects(
      verifyPackagedWindows(options(fixture), dependencies({
        inspectTimestamp: (_filePath, inspectedSignature) => ({
          status: "trusted",
          authority: inspectedSignature.timeStamperCertificate.subject,
          signedAt: "not-a-time",
        }),
      })),
      /signing time is missing or invalid/,
    );
    await assert.rejects(
      verifyPackagedWindows(options(fixture), dependencies({
        inspectTimestamp: (_filePath, inspectedSignature) => ({
          status: "trusted",
          authority: inspectedSignature.timeStamperCertificate.subject,
          signedAt: "2027-01-01T00:00:00.001Z",
        }),
      })),
      /outside the signer certificate validity period/,
    );
  });

  it("rejects missing signer identity fields and non-SHA256 Authenticode digests", async (t) => {
    const fixture = createFixture(t);
    for (const field of ["subject", "issuer", "serialNumber", "sha256Thumbprint", "notBefore", "notAfter"]) {
      const incomplete = signature();
      delete incomplete.signerCertificate[field];
      await assert.rejects(
        verifyPackagedWindows(options(fixture), dependencies({ inspectSignature: () => incomplete })),
        /signer certificate/,
      );
    }
    await assert.rejects(
      verifyPackagedWindows(options(fixture), dependencies({
        inspectSignatureDetails: () => ({ digestAlgorithm: "SHA1" }),
      })),
      /digest algorithm.*must be SHA256/,
    );
    await assert.rejects(
      verifyPackagedWindows(options(fixture), dependencies({ inspectSignatureDetails: () => null })),
      /digest algorithm.*<missing>/,
    );
  });

  it("rejects different allowlisted publishers across architectures", async (t) => {
    const fixture = createFixture(t);
    const secondPublisher = "CN=Second Publisher, O=Example Corp, C=US";
    for (const arch of ["arm64", "x64"]) {
      writeManifest(path.join(fixture.artifacts[arch].directory, `${arch}-unpacked`, "resources", "app-update.yml"), {
        provider: "generic",
        url: FEED,
        publisherName: [PUBLISHER, secondPublisher],
      });
    }
    await assert.rejects(
      verifyPackagedWindows(
        options(fixture, { publisherNames: [PUBLISHER, secondPublisher] }),
        dependencies({
          inspectSignature: (filePath) => signature(filePath.includes("x64") ? secondPublisher : PUBLISHER),
        }),
      ),
      /must have the same Authenticode publisher/,
    );
  });

  it("rejects a blockmap that is not byte-identical to a fresh blockmap", async (t) => {
    const fixture = createFixture(t);
    await assert.rejects(
      verifyPackagedWindows(options(fixture), dependencies({
        generateBlockmap: async (_executablePath, outputPath) => writeFileSync(outputPath, "different"),
      })),
      /Published blockmap differs/,
    );
  });

  it("rejects stale per-architecture metadata and incorrect merged architecture URLs", async (t) => {
    const fixture = createFixture(t);
    const latestPath = path.join(fixture.artifacts.arm64.directory, "latest.yml");
    writeManifest(latestPath, {
      version: VERSION,
      files: [{ url: fixture.artifacts.arm64.name, size: 1, sha512: "stale" }],
      path: fixture.artifacts.arm64.name,
      sha512: "stale",
    });
    await assert.rejects(verifyPackagedWindows(options(fixture), dependencies()), /latest\.yml size or SHA-512/);

    const fresh = createFixture(t);
    const manifest = parseYaml(readFileSync(fresh.mergedManifestPath, "utf8"));
    manifest.files[0].url = manifest.files[0].url.replace("/arm64/", "/x64/");
    writeManifest(fresh.mergedManifestPath, manifest);
    await assert.rejects(verifyPackagedWindows(options(fresh), dependencies()), /unexpected or duplicate architecture URL/);

    const staleMerged = createFixture(t);
    const staleManifest = parseYaml(readFileSync(staleMerged.mergedManifestPath, "utf8"));
    staleManifest.files[0].size = 1;
    writeManifest(staleMerged.mergedManifestPath, staleManifest);
    await assert.rejects(verifyPackagedWindows(options(staleMerged), dependencies()), /Merged Qiniu manifest size or SHA-512/);

    for (const field of ["path", "sha512", "arch", "architecture", "primary", "primaryArch", "primaryArchitecture", "defaultArch"]) {
      const biased = createFixture(t);
      const biasedManifest = parseYaml(readFileSync(biased.mergedManifestPath, "utf8"));
      biasedManifest[field] = field === "sha512" ? metadata(biased.artifacts.arm64.executable).sha512 : "arm64";
      writeManifest(biased.mergedManifestPath, biasedManifest);
      await assert.rejects(verifyPackagedWindows(options(biased), dependencies()), /unsupported or architecture-biased top-level field/);
    }

    const fileSelector = createFixture(t);
    const fileSelectorManifest = parseYaml(readFileSync(fileSelector.mergedManifestPath, "utf8"));
    fileSelectorManifest.files[0].arch = "arm64";
    writeManifest(fileSelector.mergedManifestPath, fileSelectorManifest);
    await assert.rejects(verifyPackagedWindows(options(fileSelector), dependencies()), /unsupported or architecture selector field/);
  });

  it("emits output accepted directly by qiniu release evidence validation", async (t) => {
    const fixture = createFixture(t);
    const result = await verifyPackagedWindows(options(fixture), dependencies());
    const objects = [];
    for (const arch of ["arm64", "x64"]) {
      const executable = fixture.artifacts[arch];
      objects.push({
        arch,
        type: "exe",
        name: executable.name,
        ...await inspectArtifact(executable.executablePath),
      }, {
        arch,
        type: "exe.blockmap",
        name: `${executable.name}.blockmap`,
        ...await inspectArtifact(`${executable.executablePath}.blockmap`),
      });
    }
    const plan = {
      version: VERSION,
      channel: "stable",
      platform: "windows",
      architectures: ["arm64", "x64"],
      objects,
      manifest: await inspectArtifact(fixture.mergedManifestPath),
    };

    assert.equal(assertLocalVerification(plan, result.localVerification), result.localVerification);
  });

  it("requires packaged publisherName to exactly match the verifier allowlist", async (t) => {
    const fixture = createFixture(t);
    const updateConfig = path.join(fixture.artifacts.arm64.directory, "arm64-unpacked", "resources", "app-update.yml");
    writeManifest(updateConfig, { provider: "generic", url: FEED });
    await assert.rejects(
      verifyPackagedWindows(options(fixture), dependencies()),
      /publisherName must exactly match/,
    );

    const fresh = createFixture(t);
    const freshUpdateConfig = path.join(fresh.artifacts.arm64.directory, "arm64-unpacked", "resources", "app-update.yml");
    writeManifest(freshUpdateConfig, { provider: "generic", url: "https://example.test/windows", publisherName: [PUBLISHER] });
    await assert.rejects(
      verifyPackagedWindows(options(fresh), dependencies()),
      /Expected Windows updater feed/,
    );
  });
});

it("Office 系统关联只声明候选应用，不覆盖 Windows 默认应用，四种格式与 macOS 一致", () => {
  const config = parseYaml(readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  assert.equal(config.fileAssociations, undefined, "通用关联宏会覆盖 Windows 扩展名默认 ProgID");
  assert.deepEqual(config.mac.fileAssociations.map((item) => item.ext).sort(), ["csv", "docx", "pptx", "xlsx"]);
  assert.equal(config.mac.fileAssociations.every((item) => item.rank === "Alternate" && item.role === "Editor"), true);
  const source = readFileSync(new URL("../build/installer.nsh", import.meta.url), "utf8");
  for (const ext of ["csv", "docx", "pptx", "xlsx"]) {
    assert.ok(source.includes(`!insertmacro JuggleWorkOfficeCandidate "${ext}"`));
    assert.ok(source.includes(`!insertmacro JuggleWorkRemoveOfficeCandidate "${ext}"`));
  }
  const writes = source.split("\n").filter((line) => /^\s*(WriteReg|DeleteReg)/.test(line) && line.includes("Software\\Classes"));
  assert.ok(writes.length > 0);
  assert.equal(writes.every((line) => line.includes("OpenWithProgids") || line.includes("Software\\Classes\\JuggleWork.Office.")), true);
  assert.ok(source.includes('${If} $R8 =='));
});
