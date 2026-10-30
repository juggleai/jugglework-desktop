const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const {
  copyOfficeEngineResources,
  readOfficeEngineManifest,
} = require("./office-engine-resources.cjs");
const { signMacApplication } = require("./electron-sign-macos.cjs");

test("项目本地适配包可按 package 入口加载，Office 服务及格式定义完整", () => {
  const sdk = require("../resources/office-engine/wrapper");
  assert.equal(typeof sdk.OfficeDocsService, "function");
  assert.equal(typeof sdk.buildOfficeDocsHttpMcpConfig, "function");
  for (const extension of [".docx", ".csv", ".xlsx", ".pptx"])
    assert.ok(sdk.SUPPORTED_EXTENSIONS.includes(extension));
});

function fixture(t, platform) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-package-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDirectory = path.join(root, "source");
  const binary = `${platform}/${platform.startsWith("win32-") ? "editor_sdk.exe" : "editor_sdk"}`;
  const files = {
    [binary]: "native fixture",
    [`${platform}/.editor-sdk-version`]: "0.0.0.499",
    [`${platform}/tmp/private.txt`]: "runtime data",
    [`${platform}/editor_sdk.000.log`]: "runtime log",
    "other-platform/editor_sdk": "must not package",
    "wrapper/package.json": JSON.stringify({ version: "0.2.196-office.1" }),
    "wrapper/supported-extensions.cjs": "module.exports=['.docx']",
    "wrapper/scripts/editor-sdk-platforms.js": "module.exports={}",
  };
  for (const name of [
    "office-docs-service",
    "document-types",
    "engine-port-file",
    "editor-sdk-process-launcher",
  ])
    files[`wrapper/lib/common/${name}.js`] = "module.exports={}";
  for (const [file, value] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(sourceDirectory, file)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(sourceDirectory, file), value);
  }
  const manifest = {
    schema: 1,
    platform,
    wrapperVersion: "0.2.196-office.1",
    engineVersion: "0.0.0.499",
    binary,
    wrapper: "wrapper/lib/common/office-docs-service.js",
    sha256: createHash("sha256").update(files[binary]).digest("hex"),
  };
  fs.writeFileSync(
    path.join(sourceDirectory, "version.json"),
    JSON.stringify(manifest),
  );
  return {
    sourceDirectory,
    resourcesDirectory: path.join(root, "JuggleWork resources"),
    platform,
    manifest,
  };
}

for (const platform of ["darwin-arm64", "darwin-x64", "win32-x64"])
  test(`${platform} copies only its SDK outside ASAR, keeps side files and refreshes the hash after signing`, (t) => {
    const f = fixture(t, platform);
    fs.writeFileSync(
      path.join(f.sourceDirectory, platform, "runtime.dat"),
      "required runtime asset",
    );
    const result = copyOfficeEngineResources({
      ...f,
      signBinary(file) {
        fs.appendFileSync(file, "signed");
      },
    });
    assert.deepEqual(
      fs.readdirSync(result.directory).sort(),
      [platform, "version.json", "wrapper"].sort(),
    );
    assert.equal(
      fs.existsSync(path.join(result.directory, platform, "tmp")),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(result.directory, platform, "editor_sdk.000.log"),
      ),
      false,
    );
    assert.equal(
      fs.readFileSync(
        path.join(result.directory, platform, "runtime.dat"),
        "utf8",
      ),
      "required runtime asset",
    );
    assert.notEqual(result.manifest.sha256, f.manifest.sha256);
    assert.deepEqual(
      readOfficeEngineManifest(result.directory, platform),
      result.manifest,
    );
    assert.equal(
      fs.readFileSync(path.join(f.sourceDirectory, f.manifest.binary), "utf8"),
      "native fixture",
    );
    assert.throws(
      () => readOfficeEngineManifest(f.sourceDirectory, "other-platform"),
      /缺少.*Office SDK/,
    );
  });

test("Git LFS pointers and missing wrapper dependencies stop packaging before changing output", (t) => {
  const f = fixture(t, "darwin-arm64");
  fs.writeFileSync(
    path.join(f.sourceDirectory, f.manifest.binary),
    "version https://git-lfs.github.com/spec/v1\noid sha256:placeholder\nsize 123\n",
  );
  assert.throws(() => copyOfficeEngineResources(f), /Git LFS/);
  assert.equal(fs.existsSync(f.resourcesDirectory), false);
  fs.writeFileSync(
    path.join(f.sourceDirectory, f.manifest.binary),
    "native fixture",
  );
  fs.rmSync(
    path.join(
      f.sourceDirectory,
      "wrapper/lib/common/editor-sdk-process-launcher.js",
    ),
  );
  assert.throws(() => copyOfficeEngineResources(f), /ENOENT|缺少文件/);
});

test("macOS uses the selected app identity/keychain, records signed bytes before sealing the app and retains builder options", async (t) => {
  const f = fixture(t, "darwin-arm64");
  const app = path.join(f.resourcesDirectory, "JuggleWork.app");
  const resourcesDirectory = path.join(app, "Contents/Resources");
  copyOfficeEngineResources({ ...f, resourcesDirectory });
  const root = path.join(resourcesDirectory, "office-engine");
  const options = {
    app,
    identity: "selected-identity-hash",
    keychain: "/private/signing.keychain",
    ignore: (file) => file.includes("/office-engine/") || file.endsWith("/Contents/Resources/toonFactoryV2/bun"),
  };
  const executablePath = path.join(resourcesDirectory, "toonFactoryV2/bun");
  const steps = [];
  const toonDependencies = {
    signMediaTools() {
      steps.push("media-sign");
      return () => steps.push("media-verify");
    },
    verifyToonBundle(directory, target) {
      assert.equal(directory, path.dirname(executablePath));
      assert.deepEqual(target, { platform: "darwin", arch: "arm64" });
      steps.push("inventory");
      return { executablePath };
    },
    verifyBunSignature(file) {
      assert.equal(file, executablePath);
      steps.push("upstream-signature");
    },
  };
  let sealed = false;
  await signMacApplication(options, {
    ...toonDependencies,
    run(command, args) {
      steps.push("office-sign");
      assert.equal(command, "codesign");
      assert.equal(args[args.indexOf("--sign") + 1], options.identity);
      assert.equal(args[args.indexOf("--keychain") + 1], options.keychain);
      fs.appendFileSync(args.at(-1), "signed");
      return { status: 0 };
    },
    signApp(received) {
      steps.push("app-sign");
      assert.equal(received, options);
      assert.notEqual(
        readOfficeEngineManifest(root, f.platform).sha256,
        f.manifest.sha256,
      );
      sealed = true;
    },
  });
  assert.equal(sealed, true);
  assert.deepEqual(steps, ["inventory", "upstream-signature", "media-sign", "office-sign", "app-sign", "inventory", "media-verify"]);
  await assert.rejects(
    signMacApplication(options, {
      ...toonDependencies,
      run: () => ({ status: 1 }),
      signApp: () => assert.fail("不能封存签名失败的应用"),
    }),
    /签名失败/,
  );

  for (const boundary of ["verifyToonBundle", "verifyBunSignature"]) {
    await assert.rejects(signMacApplication(options, {
      ...toonDependencies,
      [boundary]: () => { throw new Error(`${boundary} rejected`); },
      run: () => assert.fail("must not sign anything before Bun passes"),
      signApp: () => assert.fail("must not seal an untrusted Bun"),
    }), new RegExp(`${boundary} rejected`));
  }
  await assert.rejects(signMacApplication({ ...options, ignore: () => false }, {
    ...toonDependencies,
    run: () => assert.fail("must preserve upstream Bun before signing"),
    signApp: () => assert.fail("must not seal a mutable Bun"),
  }), /must ignore exactly/);

  let signed = false;
  await assert.rejects(signMacApplication(options, {
    ...toonDependencies,
    verifyToonBundle(...args) {
      if (signed) throw new Error("Bundled Bun SHA-256 is not trusted");
      return toonDependencies.verifyToonBundle(...args);
    },
    run: () => ({ status: 0 }),
    signApp() { signed = true; },
  }), /Bundled Bun SHA-256 is not trusted/);
});
