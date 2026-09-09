import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parse } from "yaml";

const qiniuSource = readFileSync(new URL("../../../.github/workflows/qiniu-desktop-release.yml", import.meta.url), "utf8");
const stableSource = readFileSync(new URL("../../../.github/workflows/release-macos-aarch64.yml", import.meta.url), "utf8");

describe("Qiniu release workflow policy", () => {
  it("parses and serializes channel publication without cancellation", () => {
    const workflow = parse(qiniuSource);
    assert.equal(workflow.concurrency.group, "qiniu-desktop-release-${{ inputs.channel }}-mac");
    assert.equal(workflow.concurrency["cancel-in-progress"], false);
    assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
    assert.match(qiniuSource, /environment: qiniu-desktop-release/);
    assert.doesNotMatch(qiniuSource, /inputs\.ref/);
    assert.match(qiniuSource, /ref: dev/);
    assert.match(qiniuSource, /promote-channel/);
    assert.match(qiniuSource, /verify:mac-package/);
    assert.match(qiniuSource, /jugglework-mac-arm64-\$VERSION\.zip/);
    assert.match(qiniuSource, /qiniu-v\$VERSION-latest-mac\.yml/);
  });

  it("does not publish desktop updater assets through GitHub", () => {
    assert.doesNotMatch(stableSource, /gh release upload.*jugglework-/);
    assert.doesNotMatch(stableSource, /publish-electron-assets/);
    assert.match(stableSource, /desktop updater publication is Qiniu-only/i);
  });
});
