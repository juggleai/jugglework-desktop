import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishVideoArtifact, safeWorkspaceChild } from "./artifact-publisher.js";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });
const mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);

describe("publishVideoArtifact", () => {
  test("atomically publishes validated MP4 data", async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-video-")); roots.push(root);
    const artifact = await publishVideoArtifact({ response: new Response(mp4, { headers: { "content-type": "video/mp4" } }), workspaceRoot: root, jobId: "job-1", filename: "Demo", maxBytes: 100 });
    expect(artifact).toEqual({ path: "artifacts/demo-job-1.mp4", mimeType: "video/mp4", bytes: 12 });
    expect(new Uint8Array(await readFile(join(root, artifact.path)))).toEqual(mp4);
  });
  test("rejects traversal, MIME spoofing, and oversized results", async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-video-")); roots.push(root);
    expect(() => safeWorkspaceChild(root, "../escape.mp4")).toThrow();
    await expect(publishVideoArtifact({ response: new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } }), workspaceRoot: root, jobId: "job", maxBytes: 100 })).rejects.toThrow("video_result_invalid_signature");
    await expect(publishVideoArtifact({ response: new Response(mp4, { headers: { "content-type": "video/mp4" } }), workspaceRoot: root, jobId: "job", maxBytes: 4 })).rejects.toThrow("video_result_too_large");
  });
});
