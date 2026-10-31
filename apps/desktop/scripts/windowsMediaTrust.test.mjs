import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { windowsMediaImports } from "../electron/windowsMediaTrust.mjs";
import { requireMediaTarget } from "../electron/mediaTools.mjs";

test("Windows targets are explicit and ARM is not an x64 fallback", () => {
  for (const arch of ["x64", "arm64"]) requireMediaTarget({ platform: "win32", arch });
  assert.throws(() => requireMediaTarget({ platform: "win32", arch: "ia32" }), /Unsupported/);
  assert.throws(() => requireMediaTarget({ platform: "linux", arch: "x64" }), /Unsupported/);
});

test("PE import parser rejects foreign libraries, delay imports and truncation", () => {
  const root = mkdtempSync(path.join(tmpdir(), "media-pe-")), file = path.join(root, "test.exe");
  try {
    const b = Buffer.alloc(1024);
    b.write("MZ"); b.writeUInt32LE(64, 60); b.write("PE\0\0", 64, "binary");
    b.writeUInt16LE(1, 70); b.writeUInt16LE(240, 84); b.writeUInt16LE(0x20b, 88);
    b.writeUInt32LE(0x1000, 208); b.writeUInt32LE(40, 212);
    b.writeUInt32LE(0x1000, 340); b.writeUInt32LE(512, 344); b.writeUInt32LE(512, 348);
    b.writeUInt32LE(0x1040, 524); b.write("KERNEL32.dll\0", 576);
    writeFileSync(file, b); assert.deepEqual(windowsMediaImports(file), ["kernel32.dll"]);
    b.fill(0, 576, 704); b.write("libwinpthread-1.dll\0", 576);
    writeFileSync(file, b); assert.throws(() => windowsMediaImports(file), /Non-system/);
    b.fill(0, 576, 704); b.write("KERNEL32.dll\0", 576); b.writeUInt32LE(1, 304);
    writeFileSync(file, b); assert.throws(() => windowsMediaImports(file), /Invalid/);
    writeFileSync(file, b.subarray(0, 65)); assert.throws(() => windowsMediaImports(file), /Invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
