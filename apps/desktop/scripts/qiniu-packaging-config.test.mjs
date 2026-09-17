import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parse } from "yaml";

const config = parse(readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));
const installerInclude = readFileSync(new URL("../build/installer.nsh", import.meta.url), "utf8");

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
