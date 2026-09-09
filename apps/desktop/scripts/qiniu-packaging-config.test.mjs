import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parse } from "yaml";

const config = parse(readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));

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
});
