import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function asset(relativePath) {
  return path.join(repoRoot, relativePath);
}

function pngSize(relativePath) {
  const bytes = readFileSync(asset(relativePath));
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function sha256(relativePath) {
  return createHash("sha256").update(readFileSync(asset(relativePath))).digest("hex");
}

function icoSizes(relativePath) {
  const bytes = readFileSync(asset(relativePath));
  assert.equal(bytes.readUInt16LE(0), 0);
  assert.equal(bytes.readUInt16LE(2), 1);
  const count = bytes.readUInt16LE(4);
  return Array.from({ length: count }, (_, index) => {
    const entry = 6 + index * 16;
    const width = bytes.readUInt8(entry);
    const height = bytes.readUInt8(entry + 1);
    return [width || 256, height || 256];
  });
}

test("JuggleWork marks: transparent web logo, white-background package icons", () => {
  // The web/UI mark is the transparent variant (safe on dark surfaces and
  // composites to the white mark on white plates). Desktop app icons and the
  // installer logo intentionally use the opaque white-background mark.
  const web = "apps/app/public/jugglework-logo.png";
  const desktop = "apps/desktop/resources/icons/icon.png";
  const installer = "apps/installer/assets/jugglework-logo.png";
  const whiteSource = "jugglework-logo.png";
  const transparentSource = "jugglework-logo-transparent.png";

  for (const target of [web, desktop, installer, whiteSource, transparentSource]) {
    assert.deepEqual(pngSize(target), [1024, 1024]);
  }
  assert.equal(sha256(web), sha256(transparentSource));
  assert.equal(sha256(desktop), sha256(whiteSource));
  assert.equal(sha256(installer), sha256(whiteSource));
});

test("web, macOS, Windows, and Linux assets have the required formats and sizes", () => {
  assert.deepEqual(pngSize("apps/app/public/favicon-16x16.png"), [16, 16]);
  assert.deepEqual(pngSize("apps/app/public/favicon-32x32.png"), [32, 32]);
  assert.deepEqual(pngSize("apps/app/public/apple-touch-icon.png"), [180, 180]);
  assert.equal(
    readFileSync(asset("apps/desktop/resources/icons/icon.icns")).subarray(0, 4).toString("ascii"),
    "icns",
  );
  assert.deepEqual(icoSizes("apps/desktop/resources/icons/icon.ico"), [
    [16, 16],
    [24, 24],
    [32, 32],
    [48, 48],
    [64, 64],
    [128, 128],
    [256, 256],
  ]);
});

test("development icon remains distinct while using the formal W mark assets", () => {
  assert.deepEqual(pngSize("apps/desktop/resources/icons/dev/icon.png"), [1024, 1024]);
  assert.deepEqual(pngSize("apps/desktop/resources/icons/dev/128x128.png"), [128, 128]);
  assert.deepEqual(pngSize("apps/desktop/resources/icons/dev/128x128@2x.png"), [256, 256]);
  assert.deepEqual(pngSize("apps/desktop/resources/icons/dev/32x32.png"), [32, 32]);
  assert.notEqual(
    sha256("apps/desktop/resources/icons/dev/icon.png"),
    sha256("apps/desktop/resources/icons/icon.png"),
  );
  assert.equal(
    readFileSync(asset("apps/desktop/resources/icons/dev/icon-dev.icns"))
      .subarray(0, 4)
      .toString("ascii"),
    "icns",
  );
});

test("JuggleWork artwork is referenced consistently", () => {
  const appSources = [
    "apps/app/index.html",
    "apps/app/src/app/constants.ts",
    "apps/app/src/app/extensions.ts",
    "apps/app/src/react-app/domains/session/chat/session-page.tsx",
    "apps/installer/src/ui-html.ts",
  ]
    .map((relativePath) => readFileSync(asset(relativePath), "utf8"))
    .join("\n");
  assert.match(appSources, /jugglework-logo\.png/);
});
