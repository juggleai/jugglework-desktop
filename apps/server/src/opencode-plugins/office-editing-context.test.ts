import { expect, test } from "bun:test";
import { JuggleWorkExtensionsPreview } from "./jugglework-extensions-preview.js";

test("每轮使用实际顶层聊天身份和当前多格式模型，查询失败或缺少身份不沿用历史上下文", async () => {
  const previous = {
    url: process.env.JUGGLEWORK_SERVER_URL,
    token: process.env.JUGGLEWORK_SERVER_TOKEN,
  };
  const calls: string[] = [];
  let path = "客户.csv";
  let failed = false;
  let state = "ready";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/workspaces")
        return Response.json({ items: [{ id: "ws_B", path: "/workspace/B" }] });
      if (url.pathname === "/workspace/ws_B/office/current") {
        calls.push(url.searchParams.get("sessionId")!);
        if (failed)
          return Response.json(
            { error: { message: "unreachable" } },
            { status: 503 },
          );
        return Response.json({
          document: {
            documentId: "od_B",
            relativePath: path,
            state,
            engineFileId: `actual_${path}`,
            previewUrl: "private-preview-url",
            dirty: true,
          },
          selection: {
            kind: "sheet",
            data: { sheetId: "sheet_B", ranges: [] },
          },
        });
      }
      return Response.json({}, { status: 404 });
    },
  });
  process.env.JUGGLEWORK_SERVER_URL = `http://127.0.0.1:${server.port}`;
  process.env.JUGGLEWORK_SERVER_TOKEN = "fixture";
  try {
    const plugin = await JuggleWorkExtensionsPreview({
      directory: "/workspace/A",
      sessionID: "factory_A",
    });
    const prompt = async (
      input: unknown = { sessionID: "calling_B", directory: "/workspace/B" },
    ) => {
      const output = { system: [] as string[] };
      await plugin["experimental.chat.system.transform"](input, output);
      return output.system.find((text) =>
        text.includes("## Local Office editing"),
      )!;
    };
    for (const [name, kind] of [
      ["客户.csv", "sheet"],
      ["预算.xlsx", "sheet"],
      ["汇报.pptx", "slide"],
      ["报告.docx", "doc"],
    ]) {
      path = name!;
      const result = await prompt();
      expect(result).toContain(`"kind":"${kind}"`);
      expect(result).toContain(`actual_${path}`);
      expect(result).not.toContain("private-preview-url");
      expect(result).not.toContain("factory_A");
      expect(result).toContain("sheet_delete_dimension");
      expect(result).toContain("index:0");
      expect(result).toContain("index:1");
      expect(result).toContain("office.save_document");
    }
    expect(calls).toEqual(Array(4).fill("calling_B"));
    state = "error";
    const errorState = await prompt();
    expect(errorState).toContain('"engineFileId":null');
    expect(errorState).toContain('"selection":null');
    failed = true;
    const unavailable = await prompt();
    expect(unavailable).toContain("context: unknown");
    expect(unavailable).not.toContain("actual_");
    const count = calls.length;
    expect(await prompt({})).toContain("context: unknown");
    expect(calls).toHaveLength(count);
  } finally {
    server.stop(true);
    if (previous.url === undefined) delete process.env.JUGGLEWORK_SERVER_URL;
    else process.env.JUGGLEWORK_SERVER_URL = previous.url;
    if (previous.token === undefined)
      delete process.env.JUGGLEWORK_SERVER_TOKEN;
    else process.env.JUGGLEWORK_SERVER_TOKEN = previous.token;
  }
});
