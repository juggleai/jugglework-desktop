import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parse } from "yaml";

const config = parse(readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));
const installerInclude = readFileSync(new URL("../build/installer.nsh", import.meta.url), "utf8");
const macReleaseWrapper = readFileSync(new URL("./package-macos-release.mjs", import.meta.url), "utf8");

describe("Qiniu packaged updater configuration", () => {
  it("uses a platform-specific generic feed without a top-level publisher", () => {
    assert.equal(config.publish, undefined);
    assert.deepEqual(config.mac.publish, [{
      provider: "generic",
      url: "https://downloads.jugglechat.cn/jugglework/releases/stable/mac",
    }]);
    assert.deepEqual(config.linux.publish, [{
      provider: "generic",
      url: "https://downloads.jugglechat.cn/jugglework/releases/stable/linux",
    }]);
    assert.deepEqual(config.win.publish, [{
      provider: "generic",
      url: "https://downloads.jugglechat.cn/jugglework/releases/stable/windows",
    }]);
  });

  it("preserves ZIP and DMG updater inventory", () => {
    assert.deepEqual(config.mac.target, ["dmg", "zip"]);
    assert.equal(config.mac.notarize, false);
    assert.equal(config.dmg.sign, true);
  });

  it("packages the metadata filenames produced by prepare-sidecar on every target", () => {
    const triples = {
      mac: ["aarch64-apple-darwin", "x86_64-apple-darwin"],
      linux: ["aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"],
      win: ["aarch64-pc-windows-msvc", "x86_64-pc-windows-msvc"],
    };
    for (const [platform, targets] of Object.entries(triples)) {
      const resources = config[platform].extraResources.filter((entry) => entry.from === "resources/sidecars");
      assert.equal(resources.length, 1);
      assert.equal(resources[0].to, "sidecars");
      assert.deepEqual(resources[0].filter.filter((name) => name.startsWith("versions")).sort(),
        ["versions.json", ...targets.map((target) => `versions-${target}.json`)].sort());
    }
    const prepare = readFileSync(new URL("./prepare-sidecar.mjs", import.meta.url), "utf8");
    assert.ok(prepare.includes("`versions-${resolvedTargetTriple}.json`"));
  });

  it("excludes only the exact upstream Bun executable from default mac signing", () => {
    assert.equal(config.mac.sign, "scripts/electron-sign-macos.cjs");
    const ignores = config.mac.signIgnore.map((pattern) => new RegExp(pattern));
    const ignored = (suffix) => ignores.some((pattern) => pattern.test(`/tmp/JuggleWork.app/Contents/Resources/${suffix}`));
    assert.equal(ignored("toonFactoryV2/bun"), true);
    for (const suffix of ["toonFactoryV2", "toonFactoryV2/", "toonFactoryV2/bun-helper", "toonFactoryV2/bun/child", "toonFactoryV2/server/native.node", "sidecars/opencode"]) {
      assert.equal(ignored(suffix), false, suffix);
    }
  });

  it("passes an unprefixed certificate name to electron-builder while keeping the full helper identity", () => {
    assert.match(macReleaseWrapper, /CSC_NAME:\s*electronBuilderIdentity/);
    assert.match(macReleaseWrapper, /electronBuilderIdentity !== EXPECTED_CERTIFICATE_NAME/);
    assert.match(macReleaseWrapper, /JUGGLEWORK_COMPUTER_USE_CODESIGN_IDENTITY:[\s\S]*\|\| EXPECTED_IDENTITY/);
    assert.match(macReleaseWrapper, /replace\(\/\^Developer ID Application:/);
  });

  it("contains no active GitHub update publisher", () => {
    assert.doesNotMatch(JSON.stringify(config), /github\.com\/juggleai\/jugglework-desktop\/releases/);
  });

  it("pins the standard Windows installer and deployed registry identity", () => {
    assert.equal(config.nsis.script, null);
    assert.equal(config.nsis.guid, "6fbd4568-b529-5610-b7ba-24eb7d10b064");
    assert.equal(config.nsis.include, "build/installer.nsh");
  });

  it("migrates only the exact legacy 1.2.18 Windows installation", () => {
    assert.doesNotMatch(installerInclude, /!define\s+UNINSTALL_REGISTRY_KEY_2/);
    assert.match(installerInclude, /Uninstall\\JuggleWork/);
    assert.match(installerInclude, /\$R0 == "1\.2\.18"/);
    assert.match(installerInclude, /\$LOCALAPPDATA\\Programs\\JuggleWork/);
    assert.match(installerInclude, /\$R1 == \$R3/);
    assert.match(installerInclude, /\$R2 == \$R3/);
    assert.match(installerInclude, /UninstallString/);
    assert.match(installerInclude, /\$R5 == "1"/);
    assert.match(installerInclude, /FileExists.*JuggleWork\.exe/);
    assert.match(installerInclude, /FileExists.*uninstall\.exe/);
    assert.match(installerInclude, /WriteRegStr HKCU "\$\{INSTALL_REGISTRY_KEY\}" "InstallLocation"/);
    assert.match(installerInclude, /WriteRegStr HKCU "\$\{UNINSTALL_REGISTRY_KEY\}" "UninstallString"/);
    assert.match(installerInclude, /JuggleWorkLegacyMigrationBridge/);
    assert.match(installerInclude, /ReadRegStr \$R7 HKCU "\$\{UNINSTALL_REGISTRY_KEY\}" "DisplayVersion"/);
    assert.match(installerInclude, /\$R7 == ""/);
    assert.match(
      installerInclude,
      /WriteRegStr HKCU "\$\{INSTALL_REGISTRY_KEY\}" "JuggleWorkLegacyMigrationBridge"[\s\S]*WriteRegStr HKCU "\$\{INSTALL_REGISTRY_KEY\}" "InstallLocation"/,
    );
    assert.match(installerInclude, /!macro customInstall/);
    assert.match(installerInclude, /DeleteRegValue HKCU "\$\{INSTALL_REGISTRY_KEY\}" "JuggleWorkLegacyMigrationBridge"/);
  });
});
