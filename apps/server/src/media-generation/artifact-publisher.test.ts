import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existingVideoArtifact, publishVideoArtifact, readValidatedVideoArtifact, safeWorkspaceChild } from "./artifact-publisher.js";

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
  test("reads only a validated regular artifact inside its workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-video-")); roots.push(root);
    await mkdir(join(root, "artifacts"));
    await writeFile(join(root, "artifacts", "safe.mp4"), mp4);
    const artifact = { path: "artifacts/safe.mp4", mimeType: "video/mp4", bytes: mp4.byteLength };
    expect(await readValidatedVideoArtifact({ workspaceRoot: root, artifact, maxBytes: 100 })).toEqual(mp4);
    await expect(readValidatedVideoArtifact({ workspaceRoot: root, artifact: { ...artifact, path: join(root, "artifacts", "safe.mp4") }, maxBytes: 100 })).rejects.toThrow("invalid_video_artifact_path");
    await expect(readValidatedVideoArtifact({ workspaceRoot: root, artifact: { ...artifact, bytes: mp4.byteLength + 1 }, maxBytes: 100 })).rejects.toThrow("invalid_video_artifact");
    await writeFile(join(root, "artifacts", "spoof.mp4"), new Uint8Array(mp4.byteLength));
    await expect(readValidatedVideoArtifact({ workspaceRoot: root, artifact: { ...artifact, path: "artifacts/spoof.mp4" }, maxBytes: 100 })).rejects.toThrow("invalid_video_artifact_signature");
    if (process.platform !== "win32") {
      const outside = await mkdtemp(join(tmpdir(), "jugglework-video-outside-")); roots.push(outside);
      await writeFile(join(outside, "outside.mp4"), mp4);
      await symlink(join(outside, "outside.mp4"), join(root, "artifacts", "linked.mp4"));
      await expect(readValidatedVideoArtifact({ workspaceRoot: root, artifact: { ...artifact, path: "artifacts/linked.mp4" }, maxBytes: 100 })).rejects.toThrow("invalid_video_artifact");
    }
  });

  test("keeps reading the opened artifact when its path is replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-video-")); roots.push(root);
    const artifacts = join(root, "artifacts");
    const path = join(artifacts, "jugglework-video-job.mp4");
    await mkdir(artifacts);
    await writeFile(path, mp4);
    const probe = await open(path, "r");
    const prototype = Object.getPrototypeOf(probe) as { readFile: (...args: unknown[]) => Promise<Buffer> };
    await probe.close();
    const originalReadFile = prototype.readFile;
    let replaced = false;
    prototype.readFile = async function (...args: unknown[]) {
      if (!replaced) {
        replaced = true;
        await rename(path, `${path}.opened`);
        await writeFile(path, new Uint8Array(mp4.byteLength));
      }
      return originalReadFile.apply(this, args);
    };
    try {
      expect(await existingVideoArtifact({ workspaceRoot: root, jobId: "job", maxBytes: 100 })).toEqual({
        path: "artifacts/jugglework-video-job.mp4", mimeType: "video/mp4", bytes: mp4.byteLength,
      });
      expect(replaced).toBe(true);
    } finally {
      prototype.readFile = originalReadFile;
    }
  });
});
