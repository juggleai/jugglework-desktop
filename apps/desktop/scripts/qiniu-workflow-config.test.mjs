import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parse } from "yaml";

const qiniuSource = readFileSync(new URL("../../../.github/workflows/qiniu-desktop-release.yml", import.meta.url), "utf8");
const stableSource = readFileSync(new URL("../../../.github/workflows/release-macos-aarch64.yml", import.meta.url), "utf8");

describe("Qiniu release workflow policy", () => {
  it("parses and serializes channel publication without cancellation", () => {
    const workflow = parse(qiniuSource);
    assert.deepEqual(workflow.permissions, { actions: "read", contents: "read" });
    assert.equal(workflow.concurrency.group, "qiniu-desktop-release-${{ inputs.channel }}-${{ inputs.platform }}");
    assert.equal(workflow.concurrency["cancel-in-progress"], false);
    assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
    assert.deepEqual(workflow.on.workflow_dispatch.inputs.platform.options, ["mac", "windows"]);
    assert.match(qiniuSource, /environment: qiniu-desktop-release/);
    assert.doesNotMatch(qiniuSource, /inputs\.ref/);
    assert.match(qiniuSource, /ref: dev/);
    assert.match(qiniuSource, /promote-channel/);
    assert.equal((qiniuSource.match(/QINIU_ACCESS_KEY: \$\{\{ secrets\.QINIU_ACCESS_KEY \}\}/g) ?? []).length, 4);
    assert.equal((qiniuSource.match(/QINIU_SECRET_KEY: \$\{\{ secrets\.QINIU_SECRET_KEY \}\}/g) ?? []).length, 4);
    assert.match(qiniuSource, /verify:mac-package/);
    assert.match(qiniuSource, /jugglework-mac-arm64-\$VERSION\.zip/);
    assert.match(qiniuSource, /qiniu-v\$VERSION-latest-mac\.yml/);
  });

  it("requires SignPath and aggregates the exact signed Windows matrix bytes", () => {
    const workflow = parse(qiniuSource);
    const windows = workflow.jobs["build-windows"];
    const aggregate = workflow.jobs["aggregate-windows"];
    const aggregateRuns = aggregate.steps.map((step) => step.run ?? "").join("\n");
    const signToolIndex = aggregate.steps.findIndex((step) => step.name === "Locate Windows SDK signtool");
    const verifyIndex = aggregate.steps.findIndex((step) => step.name === "Verify both signed Windows packages and post-sign blockmaps");
    const signToolRun = aggregate.steps[signToolIndex].run;
    const bundleRun = aggregate.steps.find((step) => step.name === "Stage signed release bundle and non-secret evidence").run;

    assert.equal(workflow.jobs["release-macos-arm64"].if, "inputs.platform == 'mac'");
    assert.equal(windows.if, "inputs.platform == 'windows'");
    assert.deepEqual(windows.strategy.matrix.include.map(({ arch, runner }) => ({ arch, runner })), [
      { arch: "arm64", runner: "windows-11-arm" },
      { arch: "x64", runner: "windows-2022" },
    ]);
    assert.equal(aggregate["runs-on"], "windows-2022");
    assert.deepEqual(aggregate.needs, ["resolve-windows-source", "build-windows"]);
    assert.match(qiniuSource, /JUGGLEWORK_WINDOWS_PUBLISHER_NAMES/);
    assert.match(qiniuSource, /signpath\/github-action-submit-signing-request@v2/);
    assert.match(qiniuSource, /apply-signpath-windows-artifact\.mjs/);
    assert.match(qiniuSource, /resources\/app-update\.yml/);
    assert.match(qiniuSource, /verify:windows-package/);
    assert.match(qiniuSource, /current Windows package verifier requires the stable\/windows updater feed/);
    assert.match(qiniuSource, /--platform windows --arch arm64,x64/);
    assert.match(qiniuSource, /upload-version/);
    assert.match(qiniuSource, /verify-cdn/);
    assert.match(qiniuSource, /verify-only/);
    assert.match(qiniuSource, /promote=true requires canary_json/);
    assert.ok(signToolIndex >= 0 && signToolIndex < verifyIndex);
    assert.match(signToolRun, /where\.exe signtool\.exe/);
    assert.match(signToolRun, /ProgramFiles\(x86\).*Windows Kits\/10\/bin/);
    assert.match(signToolRun, /PROCESSOR_ARCHITECTURE/);
    assert.match(signToolRun, /\[version\]::TryParse/);
    assert.match(signToolRun, /Sort-Object Version -Descending/);
    assert.match(signToolRun, /throw "Could not locate Windows SDK signtool\.exe/);
    assert.match(signToolRun, /JUGGLEWORK_SIGNTOOL=\$signTool.*GITHUB_ENV/);
    assert.match(bundleRun, /\$env:EVIDENCE/);
    assert.doesNotMatch(bundleRun, /\$env:CANARY\b|CANARY_JSON/);
    assert.doesNotMatch(qiniuSource, /unsigned Windows installer fallback/i);
    assert.doesNotMatch(aggregateRuns, /build:electron|electron-builder/);
  });

  it("does not publish desktop updater assets through GitHub", () => {
    assert.doesNotMatch(stableSource, /gh release upload.*jugglework-/);
    assert.doesNotMatch(stableSource, /publish-electron-assets/);
    assert.match(stableSource, /desktop updater publication is Qiniu-only/i);
  });
});
