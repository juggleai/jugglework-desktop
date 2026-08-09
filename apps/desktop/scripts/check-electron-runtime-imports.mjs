import assert from "node:assert/strict";

const contractUrl = new URL("../dist/runtime/desktop-remote-control.js", import.meta.url).href;

assert.match(
  contractUrl,
  /\/apps\/desktop\/dist\/runtime\/desktop-remote-control\.js$/,
  `Electron must resolve the compiled desktop remote-control contract, received ${contractUrl}`,
);
assert.doesNotMatch(contractUrl, /\/src\/|\.ts$/);

const { desktopRemoteOperationResultSchema } = await import(
  contractUrl
);
assert.equal(typeof desktopRemoteOperationResultSchema?.parse, "function");

console.log(`Electron runtime contract resolved to ${contractUrl}`);
