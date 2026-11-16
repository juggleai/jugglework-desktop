import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  EXPECTED_OPENCODE_PLUGIN_BUNDLES,
  verifyOpenCodePluginBundles,
} from "./verify-opencode-plugin-bundles.mjs";

const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixture(source = 'import fs from "node:fs"; export default fs;\n') {
  const directory = mkdtempSync(path.join(tmpdir(), "jugglework-plugin-bundles-"));
  fixtures.push(directory);
  for (const fileName of EXPECTED_OPENCODE_PLUGIN_BUNDLES) {
    writeFileSync(path.join(directory, fileName), source);
  }
  return directory;
}

test("accepts self-contained plugin bundles", () => {
  const result = verifyOpenCodePluginBundles(fixture());
  assert.equal(result.verified.length, EXPECTED_OPENCODE_PLUGIN_BUNDLES.length);
});

test("rejects a transpiled plugin that still needs package dependencies", () => {
  const directory = fixture();
  writeFileSync(
    path.join(directory, "jugglework-extensions-preview.js"),
    'import { z } from "zod"; export default z;\n',
  );
  assert.throws(
    () => verifyOpenCodePluginBundles(directory),
    /not self-contained; bare imports: zod/,
  );
});

test("rejects an incomplete plugin directory", () => {
  const directory = fixture();
  rmSync(path.join(directory, "jugglework-confirmation-gate.js"));
  assert.throws(() => verifyOpenCodePluginBundles(directory), /plugin bundle is missing/);
});

test("rejects a bundle whose shared chunk was not packaged", () => {
  const directory = fixture();
  writeFileSync(
    path.join(directory, "jugglework-extensions-preview.js"),
    'import "./missing-shared-chunk.js"; export default {};\n',
  );
  assert.throws(
    () => verifyOpenCodePluginBundles(directory),
    /references missing bundled chunk/,
  );
});

test("accepts and verifies a referenced shared chunk", () => {
  const directory = fixture();
  writeFileSync(path.join(directory, "shared.js"), 'import fs from "node:fs"; export default fs;\n');
  writeFileSync(path.join(directory, "jugglework-extensions-preview.js"), 'import shared from "./shared.js"; export default shared;\n');
  const result = verifyOpenCodePluginBundles(directory);
  assert.equal(result.directory, ".");
  assert.ok(result.verified.some((entry) => entry.fileName === "shared.js"));
});

test("rejects stale unreferenced JavaScript output", () => {
  const directory = fixture();
  writeFileSync(path.join(directory, "stale-tsc-output.js"), 'import { z } from "zod"; export default z;\n');
  assert.throws(() => verifyOpenCodePluginBundles(directory), /unreferenced JavaScript: stale-tsc-output\.js/);
});

test("rejects source maps and source map references", () => {
  const withMap = fixture();
  writeFileSync(path.join(withMap, "jugglework-extensions-preview.js.map"), "{}");
  assert.throws(() => verifyOpenCodePluginBundles(withMap), /contain source maps/);

  const withReference = fixture();
  writeFileSync(path.join(withReference, "jugglework-extensions-preview.js"), 'export default {};\n//# sourceMappingURL=plugin.js.map\n');
  assert.throws(() => verifyOpenCodePluginBundles(withReference), /contains a source map reference/);
});

test("rejects path traversal and dependencies that cannot be statically verified", () => {
  const traversal = fixture();
  writeFileSync(path.join(traversal, "jugglework-extensions-preview.js"), 'import "../outside.js"; export default {};\n');
  assert.throws(() => verifyOpenCodePluginBundles(traversal), /escapes the bundle directory/);

  const dynamic = fixture();
  writeFileSync(path.join(dynamic, "jugglework-extensions-preview.js"), 'const dependency = "./shared.js"; export default import(dependency);\n');
  assert.throws(() => verifyOpenCodePluginBundles(dynamic), /cannot be statically verified/);
});

test("rejects unknown node-prefixed specifiers", () => {
  const directory = fixture();
  writeFileSync(path.join(directory, "jugglework-extensions-preview.js"), 'import invalid from "node:not-a-real-builtin"; export default invalid;\n');
  assert.throws(() => verifyOpenCodePluginBundles(directory), /bare imports: node:not-a-real-builtin/);
});
