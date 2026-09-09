import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parse } from "yaml";

const qiniuSource = readFileSync(new URL("../../../.github/workflows/qiniu-desktop-release.yml", import.meta.url), "utf8");
const alphaSource = readFileSync(new URL("../../../.github/workflows/alpha-macos-aarch64.yml", import.meta.url), "utf8");
const stableSource = readFileSync(new URL("../../../.github/workflows/release-macos-aarch64.yml", import.meta.url), "utf8");
const bridgeSource = readFileSync(new URL("../../../.github/workflows/github-desktop-bridge.yml", import.meta.url), "utf8");

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

  it("keeps legacy Alpha publication manual and explicitly confirmed", () => {
    const workflow = parse(alphaSource);
    assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
    assert.match(alphaSource, /confirm_legacy_bridge/);
    assert.match(alphaSource, /PUBLISH_LEGACY_ALPHA_BRIDGE/);
  });

  it("isolates the one-time GitHub stable bridge from routine release builds", () => {
    assert.doesNotMatch(stableSource, /gh release upload.*jugglework-/);
    assert.match(stableSource, /Keep the v1\.2\.15 bridge as GitHub's legacy updater `latest`/);
    const workflow = parse(bridgeSource);
    assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
    assert.match(bridgeSource, /PUBLISH_V1_2_15_GITHUB_BRIDGE/);
    assert.match(bridgeSource, /ref: dev/);
    assert.match(bridgeSource, /qiniu-desktop-stable-1\.2\.15-/);
    assert.match(bridgeSource, /verify-github-bridge-bundle\.mjs/);
    assert.doesNotMatch(bridgeSource, /--clobber/);
    assert.match(bridgeSource, /gh release download v1\.2\.15/);
    assert.match(bridgeSource, /cmp "\$RUNNER_TEMP\/bridge\/\$name"/);
    assert.match(bridgeSource, /--record-release-id/);
    assert.match(bridgeSource, /gh release edit v1\.2\.15.*--latest/);
  });
});
