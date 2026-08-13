import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { validateCodexImageInputs } from "./codex-image-input.mjs";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const part = (objectRef, overrides = {}) => ({ type: "attachment", attachment: { attachmentId: "img_1", kind: "image", name: "screen.png", mimeType: "image/png", sizeBytes: png.length, objectRef, ...overrides } });

describe("Codex image input", () => {
  it("accepts signed images in the controlled workspace inbox", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-image-workspace-"));
    const inbox = path.join(root, ".opencode", "jugglework", "inbox");
    await mkdir(inbox, { recursive: true });
    const image = path.join(inbox, "screen.png");
    await writeFile(image, png);
    assert.equal((await validateCodexImageInputs([part(image)], root)).get("img_1"), await realpath(image));
  });

  it("rejects MIME spoofing and symlink escapes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-image-boundary-"));
    const inbox = path.join(root, ".opencode", "jugglework", "inbox");
    await mkdir(inbox, { recursive: true });
    const spoof = path.join(inbox, "spoof.png");
    await writeFile(spoof, Buffer.alloc(png.length));
    await assert.rejects(validateCodexImageInputs([part(spoof)], root), /MIME type/);
    const outside = path.join(root, "outside.png");
    await writeFile(outside, png);
    const link = path.join(inbox, "link.png");
    await symlink(outside, link);
    await assert.rejects(validateCodexImageInputs([part(link)], root), /attachment inbox/);
  });
});
