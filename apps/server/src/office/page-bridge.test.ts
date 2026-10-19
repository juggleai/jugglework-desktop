import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OfficeDocumentSession } from "@jugglework/types/office";
import {
  prepareOfficePageSave,
  readOfficePageSelection,
} from "./page-bridge.js";

test("统一保存确认精确页面身份，桌面拒绝时不回退到直接保存", async () => {
  const previous = process.env.JUGGLEWORK_UI_CONTROL_DISCOVERY;
  const root = await mkdtemp(join(tmpdir(), "office-page-commit-"));
  const calls: unknown[] = [];
  let ready = true;
  let selected = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const route = new URL(request.url).pathname;
      expect(route).toBe(
        selected ? "/office/selection" : "/office/prepare-save",
      );
      expect(request.headers.get("authorization")).toBe("Bearer fixture");
      calls.push(await request.json());
      return Response.json(
        ready
          ? { ok: true, ...(selected ? { selection: { ranges: [] } } : {}) }
          : { ok: false, error: "页面已失效" },
        { status: ready ? 200 : 409 },
      );
    },
  });
  try {
    const path = join(root, "discovery.json");
    await writeFile(
      path,
      JSON.stringify({
        baseUrl: `http://127.0.0.1:${server.port}`,
        token: "fixture",
      }),
    );
    process.env.JUGGLEWORK_UI_CONTROL_DISCOVERY = path;
    const document = {
      workspaceId: "ws",
      documentId: "od",
      pageId: "generation",
      relativePath: "报告.docx",
    } as OfficeDocumentSession;
    await prepareOfficePageSave(document);
    await prepareOfficePageSave({ ...document, relativePath: "预算.xlsx" });
    await prepareOfficePageSave({ ...document, relativePath: "客户.CSV" });
    await prepareOfficePageSave({ ...document, relativePath: "汇报.pptx" });
    expect(calls).toEqual([
      { workspaceId: "ws", documentId: "od", pageId: "generation" },
      { workspaceId: "ws", documentId: "od", pageId: "generation" },
      { workspaceId: "ws", documentId: "od", pageId: "generation" },
      { workspaceId: "ws", documentId: "od", pageId: "generation" },
    ]);
    ready = false;
    await expect(prepareOfficePageSave(document)).rejects.toThrow("页面已失效");
    await expect(
      prepareOfficePageSave({ ...document, relativePath: "预算.xlsx" }),
    ).rejects.toThrow("页面已失效");
    await expect(
      prepareOfficePageSave({ ...document, relativePath: "汇报.pptx" }),
    ).rejects.toThrow("页面已失效");
    await prepareOfficePageSave({ ...document, relativePath: "导出.pdf" });
    expect(calls).toHaveLength(7);
    ready = true;
    selected = true;
    expect(await readOfficePageSelection(document)).toEqual({ ranges: [] });
    expect(calls.at(-1)).toEqual({
      workspaceId: "ws",
      documentId: "od",
      pageId: "generation",
    });
    ready = false;
    await expect(readOfficePageSelection(document)).rejects.toThrow(
      "页面已失效",
    );
    delete process.env.JUGGLEWORK_UI_CONTROL_DISCOVERY;
    expect(await readOfficePageSelection(document)).toBeNull();
  } finally {
    server.stop(true);
    if (previous === undefined)
      delete process.env.JUGGLEWORK_UI_CONTROL_DISCOVERY;
    else process.env.JUGGLEWORK_UI_CONTROL_DISCOVERY = previous;
    await rm(root, { recursive: true, force: true });
  }
});
