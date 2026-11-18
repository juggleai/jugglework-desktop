import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// Meeting whiteboard scenes live under <userData>/whiteboards/<meetingId>/.
// Content stays in Excalidraw's own serializeAsJSON format so phase two can
// sync the same document without a migration.
export const WHITEBOARD_MAX_BYTES = 20 * 1024 * 1024;
const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

/** @param {unknown} value */
export function isSafeWhiteboardSegment(value) {
  return typeof value === "string" && SEGMENT.test(value);
}

function assertSegments(...values) {
  if (!values.every(isSafeWhiteboardSegment)) throw new Error("白板标识无效");
}

function assertScene(content) {
  if (typeof content !== "string") throw new Error("白板内容格式不正确");
  if (Buffer.byteLength(content, "utf8") > WHITEBOARD_MAX_BYTES) throw new Error("白板内容过大，无法保存");
  let parsed;
  try { parsed = JSON.parse(content); } catch { throw new Error("白板内容格式不正确"); }
  if (!parsed || parsed.type !== "excalidraw" || !Array.isArray(parsed.elements)) throw new Error("白板内容格式不正确");
}

async function writeAtomic(file, content) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, content, "utf8");
  await rename(temp, file);
}

/**
 * @param {{ root: string, randomId?: () => string }} options
 */
export function createWhiteboardStore({ root, randomId = () => `wb_${randomUUID().replaceAll("-", "")}` }) {
  const dir = (meetingId) => path.join(root, meetingId);
  const pointer = (meetingId) => path.join(dir(meetingId), "current.json");
  const sceneFile = (meetingId, whiteboardId) => path.join(dir(meetingId), `${whiteboardId}.excalidraw`);

  async function currentId(meetingId) {
    try {
      const value = JSON.parse(await readFile(pointer(meetingId), "utf8"))?.whiteboardId;
      return isSafeWhiteboardSegment(value) ? value : null;
    } catch { return null; }
  }

  return {
    /** Reuse the meeting's whiteboard so a reopened window restores its scene. */
    async open(meetingId) {
      assertSegments(meetingId);
      await mkdir(dir(meetingId), { recursive: true });
      let whiteboardId = await currentId(meetingId);
      if (!whiteboardId) {
        whiteboardId = randomId();
        assertSegments(whiteboardId);
        await writeAtomic(pointer(meetingId), JSON.stringify({ whiteboardId }));
        return { whiteboardId, scene: null };
      }
      let scene = null;
      try {
        const content = await readFile(sceneFile(meetingId, whiteboardId), "utf8");
        assertScene(content);
        scene = content;
      } catch { scene = null; }
      return { whiteboardId, scene };
    },
    /** Same contract as save(), for the synchronous pagehide flush. */
    saveSync(meetingId, whiteboardId, content) {
      assertSegments(meetingId, whiteboardId);
      let current = null;
      try { current = JSON.parse(readFileSync(pointer(meetingId), "utf8"))?.whiteboardId; } catch { current = null; }
      if (current !== whiteboardId) throw new Error("白板已失效，请重新打开");
      assertScene(content);
      const file = sceneFile(meetingId, whiteboardId);
      const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temp, content, "utf8");
      renameSync(temp, file);
    },
    async save(meetingId, whiteboardId, content) {
      assertSegments(meetingId, whiteboardId);
      if (await currentId(meetingId) !== whiteboardId) throw new Error("白板已失效，请重新打开");
      assertScene(content);
      await writeAtomic(sceneFile(meetingId, whiteboardId), content);
    },
  };
}
