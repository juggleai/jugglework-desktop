import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "electron-import-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const desktop = path.join(root, "apps/desktop");
  mkdirSync(path.join(desktop, "scripts"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  const script = path.join(desktop, "scripts/check-electron-runtime-imports.mjs");
  copyFileSync(new URL("./check-electron-runtime-imports.mjs", import.meta.url), script);
  const write = (relative, content) => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  write("apps/desktop/dist/runtime/desktop-remote-control.js", "export const desktopRemoteOperationResultSchema = { parse() {} };");
  return {
    write,
    run: (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" }),
  };
}

describe("Electron development and packaged runtime import checks", () => {
  it("checks a clean dev layout without any packaged server output", (t) => {
    const f = fixture(t);
    f.write("apps/server/dist/embedded.js", "export function startEmbeddedServer() {}");
    const result = f.run("--dev");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /apps\/server\/dist\/embedded\.js/);
  });

  it("does not consume a stale packaged copy in development", (t) => {
    const f = fixture(t);
    f.write("apps/server/dist/embedded.js", "export function startEmbeddedServer() {}");
    f.write("apps/desktop/server/dist/embedded.js", 'throw new Error("stale packaged server");');
    const result = f.run("--dev");
    assert.equal(result.status, 0, result.stderr);
  });

  it("does not let a packaged copy hide a missing dev build", (t) => {
    const f = fixture(t);
    f.write("apps/desktop/server/dist/embedded.js", "export function startEmbeddedServer() {}");
    const result = f.run("--dev");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /apps\/server\/dist\/embedded\.js/);
  });

  it("defaults to staged package validation without falling back to the dev server", (t) => {
    const f = fixture(t);
    f.write("apps/server/dist/embedded.js", "export function startEmbeddedServer() {}");
    assert.notEqual(f.run().status, 0);
    f.write("apps/desktop/server/dist/embedded.js", 'import "missing-packaged-runtime-dependency"; export function startEmbeddedServer() {}');
    const broken = f.run();
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /missing-packaged-runtime-dependency/);
    f.write("apps/desktop/server/dist/embedded.js", "export function startEmbeddedServer() {}");
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /apps\/desktop\/server\/dist\/embedded\.js/);
  });

  it("orders the dev check after server compilation and the package check after staging", () => {
    const dev = readFileSync(new URL("./electron-dev.mjs", import.meta.url), "utf8");
    assert.match(dev, /\["--filter", "jugglework-server", "build"\][\s\S]*"check-electron-runtime-imports\.mjs"\), "--dev"/);
    const build = readFileSync(new URL("./electron-build.mjs", import.meta.url), "utf8");
    assert.match(build, /cpSync\(serverDistDir,[\s\S]*"check-electron-runtime-imports\.mjs"/);
    assert.doesNotMatch(build, /"--dev"/);
  });
});
