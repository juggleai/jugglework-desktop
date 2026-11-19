import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWhiteboardStore, isSafeWhiteboardSegment, WHITEBOARD_MAX_BYTES } from "./whiteboard-store.mjs";

const scene = (text) => JSON.stringify({ type: "excalidraw", version: 2, source: "local", elements: [{ id: "a", text }], appState: {}, files: {} });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "jw-whiteboard-"));
  return { root, store: createWhiteboardStore({ root, randomId: () => "wb_fixed0001" }) };
}

test("safe segments reject traversal, separators and oversize ids", () => {
  for (const ok of ["m1", "abc_DEF-123", "x".repeat(128)]) assert.equal(isSafeWhiteboardSegment(ok), true, ok);
  for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", "a b", "x".repeat(129), 7, null, "名字"]) assert.equal(isSafeWhiteboardSegment(bad), false, String(bad));
});

test("opening a meeting without history creates and remembers a stable whiteboard id", async () => {
  const { root, store } = await fixture();
  const first = await store.open("meeting_1");
  assert.deepEqual(first, { whiteboardId: "wb_fixed0001", scene: null });
  const current = JSON.parse(await readFile(path.join(root, "meeting_1", "current.json"), "utf8"));
  assert.equal(current.whiteboardId, "wb_fixed0001");
  const again = createWhiteboardStore({ root, randomId: () => "wb_other" });
  assert.equal((await again.open("meeting_1")).whiteboardId, "wb_fixed0001");
});

test("save is atomic and reopening restores the latest scene", async () => {
  const { root, store } = await fixture();
  const { whiteboardId } = await store.open("meeting_1");
  await store.save("meeting_1", whiteboardId, scene("first"));
  await store.save("meeting_1", whiteboardId, scene("second"));
  assert.equal((await store.open("meeting_1")).scene, scene("second"));
  const files = await readdir(path.join(root, "meeting_1"));
  assert.deepEqual(files.sort(), ["current.json", `${whiteboardId}.excalidraw`]);
});

test("save rejects unsafe ids, wrong owner, oversize and non-excalidraw content", async () => {
  const { store } = await fixture();
  const { whiteboardId } = await store.open("meeting_1");
  await assert.rejects(store.save("../meeting", whiteboardId, scene("x")), /无效/);
  await assert.rejects(store.save("meeting_1", "wb/../x", scene("x")), /无效/);
  await assert.rejects(store.save("meeting_1", "wb_not_current", scene("x")), /已失效/);
  await assert.rejects(store.save("meeting_1", whiteboardId, "x".repeat(WHITEBOARD_MAX_BYTES + 1)), /过大/);
  await assert.rejects(store.save("meeting_1", whiteboardId, "{\"type\":\"other\"}"), /格式/);
  await assert.rejects(store.save("meeting_1", whiteboardId, "not json"), /格式/);
});

test("a corrupt current pointer or scene starts fresh instead of failing", async () => {
  const { root, store } = await fixture();
  await mkdir(path.join(root, "meeting_1"), { recursive: true });
  await writeFile(path.join(root, "meeting_1", "current.json"), "{broken");
  assert.equal((await store.open("meeting_1")).whiteboardId, "wb_fixed0001");
  await writeFile(path.join(root, "meeting_1", "current.json"), JSON.stringify({ whiteboardId: "../evil" }));
  assert.equal((await store.open("meeting_1")).whiteboardId, "wb_fixed0001");
});
