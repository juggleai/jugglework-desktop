import assert from "node:assert/strict";
import test from "node:test";

import { computerUseHelperInfoPlist } from "./computer-use-helper-plist.mjs";

test("Computer Use helper starts as a UI element so MCP instances never enter the Dock", () => {
  const plist = computerUseHelperInfoPlist();

  assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/);
  assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>com\.juggleai\.jugglework\.computer-use<\/string>/);
  assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>ComputerUse<\/string>/);
});

test("Computer Use helper plist preserves explicit build identities", () => {
  const plist = computerUseHelperInfoPlist({
    executableName: "CustomComputerUse",
    bundleIdentifier: "com.example.computer-use",
  });

  assert.match(plist, /<string>CustomComputerUse<\/string>/);
  assert.match(plist, /<string>com\.example\.computer-use<\/string>/);
});
