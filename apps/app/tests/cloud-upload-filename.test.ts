import { afterEach, expect, test } from "bun:test";
import { createJuggleWorkServerClient } from "../src/app/lib/jugglework-server";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("上传读取原件时优先保留中文文件名，不使用先出现的 ASCII 回退名", async () => {
  globalThis.fetch = (async () => new Response("office", { headers: {
    "Content-Disposition": `attachment; filename="__Word.docx"; filename*=UTF-8''${encodeURIComponent("测试Word.docx")}`,
  } })) as typeof fetch;
  const file = await createJuggleWorkServerClient({ baseUrl: "http://127.0.0.1:8787" })
    .downloadWorkspaceFile("ws", "测试Word.docx");
  expect(file.filename).toBe("测试Word.docx");
  expect(new TextDecoder().decode(file.data)).toBe("office");
});

test("扩展文件名编码损坏时仍可下载，回退名中的百分号保持原样", async () => {
  globalThis.fetch = (async () => new Response("office", { headers: {
    "Content-Disposition": `attachment; filename="100%.xlsx"; filename*=UTF-8''%invalid`,
  } })) as typeof fetch;
  const file = await createJuggleWorkServerClient({ baseUrl: "http://127.0.0.1:8787" })
    .downloadWorkspaceFile("ws", "100%.xlsx");
  expect(file.filename).toBe("100%.xlsx");
});
