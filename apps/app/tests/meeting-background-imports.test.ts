import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { importMeetingBackground, listImportedBackgrounds, readImportedBackgroundUrl, deleteImportedBackground } from "../src/react-app/domains/meeting/meeting-background-imports";

test("stores resized local photos, resolves them by ID, and deletes them", async () => {
  const url = "data:image/jpeg;base64,AAAA";
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: () => url };
  let closed = false;
  const globals = { indexedDB: new IDBFactory(), document: { createElement: () => canvas }, createImageBitmap: async () => ({ width: 2560, height: 1440, close() { closed = true; } }) };
  const previous = Object.keys(globals).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  try {
    for (const [k,v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { configurable: true, value: v });
    await expect(importMeetingBackground(new File(["<svg/>"], "drawing.svg", {type:"image/svg+xml"}))).rejects.toThrow();
    const item = await importMeetingBackground(new File(["sample"], "Room.png", {type:"image/png"}));
    expect(closed).toBe(true);
    expect([canvas.width, canvas.height]).toEqual([1280, 720]);
    expect(await listImportedBackgrounds()).toEqual([item]);
    expect(await readImportedBackgroundUrl(item.id)).toBe(url);
    await deleteImportedBackground(item.id);
    expect(await readImportedBackgroundUrl(item.id)).toBeNull();
  } finally {
    for (const [k,d] of previous) { if (d) Object.defineProperty(globalThis,k,d); else Reflect.deleteProperty(globalThis,k); }
  }
});
