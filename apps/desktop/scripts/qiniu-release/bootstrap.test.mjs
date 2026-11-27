import assert from "node:assert/strict";
import test from "node:test";
import { usesNewReleaseOrigin } from "./constants.mjs";
import { assertBootstrap, WINDOWS_BOOTSTRAP } from "./bootstrap.mjs";

test("Windows new-origin selection requires stable >=1.2.42 and exactly both native architectures", () => {
  const plan = { version: "1.2.42", channel: "stable", platform: "windows", architectures: ["x64", "arm64"] };
  assert.equal(usesNewReleaseOrigin(plan), true);
  assert.equal(usesNewReleaseOrigin({ ...plan, version: "2.0.0" }), true);
  for (const overrides of [{ version: "1.2.41" }, { version: "1.2.42-alpha.1" }, { version: "v1.2.42" },
    { channel: "alpha" }, { platform: "linux" }, { architectures: ["x64"] }, { architectures: ["arm64"] },
    { architectures: ["arm64", "arm64"] }, { architectures: ["arm64", "x64", "universal"] }]) {
    const changed = { ...plan, ...overrides };
    assert.equal(usesNewReleaseOrigin(changed), false);
    assert.throws(() => assertBootstrap(changed, { bootstrap: WINDOWS_BOOTSTRAP, bucket: "jugglework" }));
  }
});
