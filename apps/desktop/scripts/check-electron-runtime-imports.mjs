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

// Development builds apps/server/dist, not the electron-builder staging copy.
// Packaging deliberately defaults to the staged copy to expose missing deps.
const serverUrl = new URL(process.argv.includes("--dev")
  ? "../../server/dist/embedded.js"
  : "../server/dist/embedded.js", import.meta.url).href;
const { startEmbeddedServer } = await import(serverUrl);
assert.equal(typeof startEmbeddedServer, "function");
console.log(`Electron embedded Server imports resolved from ${serverUrl}`);
