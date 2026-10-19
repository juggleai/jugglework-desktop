import { expect, test } from "bun:test";
import { JuggleWorkExtensionsPreview } from "./jugglework-extensions-preview.js";

test("Office 语义查询和保存使用调用聊天身份，不使用窗口焦点且拒绝替代保存路径", async () => {
  const previous = {
    url: process.env.JUGGLEWORK_SERVER_URL,
    token: process.env.JUGGLEWORK_SERVER_TOKEN,
  };
  const saved: unknown[] = [];
  const sessions: string[] = [];
  const calls: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/workspaces")
        return Response.json({ items: [{ id: "ws_A", path: "/workspace/A" }, { id: "ws_B", path: "/workspace/B" }] });
      if (url.pathname === "/workspace/ws_B/office/current") {
        sessions.push(url.searchParams.get("sessionId")!);
        return Response.json({
          document: {
            documentId: "od_B",
            state: "ready",
            engineFileId: "real_B",
          },
        });
      }
      if (url.pathname === "/workspace/ws_B/office/save-for-actor") {
        saved.push(await request.json());
        return Response.json({
          document: { documentId: "od_B", dirty: false },
        });
      }
      if (url.pathname === "/workspace/ws_B/office/tools") {
        sessions.push(url.searchParams.get("sessionId")!);
        return Response.json({
          tool: {
            name: url.searchParams.get("name"),
            inputSchema: { type: "object" },
          },
        });
      }
      if (url.pathname === "/workspace/ws_B/office/call") {
        calls.push(await request.json());
        return Response.json({ output: { message: "Dimension deleted" } });
      }
      return Response.json({}, { status: 404 });
    },
  });
  process.env.JUGGLEWORK_SERVER_URL = `http://127.0.0.1:${server.port}`;
  process.env.JUGGLEWORK_SERVER_TOKEN = "test-office-token";
  try {
    const plugin = await JuggleWorkExtensionsPreview({
      directory: "/workspace/A",
      sessionID: "factory_A",
    });
    const context = { directory: "/workspace/B", worktree: "/", sessionID: "calling_B", messageID: "msg_B" };
    const current = JSON.parse(
      await plugin.tool.jugglework_query.execute(
        { id: "office.current_document" },
        context,
      ),
    );
    expect(current.result).toMatchObject({
      workspaceId: "ws_B",
      document: { engineFileId: "real_B" },
    });
    const savedResult = JSON.parse(
      await plugin.tool.jugglework_execute.execute(
        { id: "office.save_document" },
        context,
      ),
    );
    expect(savedResult.ok).toBe(true);
    expect(saved).toEqual([{ sessionId: "calling_B", messageId: "msg_B" }]);
    expect(sessions).toEqual(["calling_B"]);
    await expect(
      plugin.tool.jugglework_execute.execute(
        { id: "office.save_document", args: { file_path: "/wrong.docx" } },
        context,
      ),
    ).rejects.toThrow("does not accept");
    expect(saved).toHaveLength(1);
    const schema = JSON.parse(
      await plugin.tool.jugglework_query.execute(
        { id: "office.tools", args: { name: "sheet_delete_dimension" } },
        context,
      ),
    );
    expect(schema.result.tool.name).toBe("sheet_delete_dimension");
    const edited = JSON.parse(
      await plugin.tool.jugglework_execute.execute(
        {
          id: "office.call",
          args: {
            name: "sheet_delete_dimension",
            args: {
              sheet_id: "sheet_B",
              dimension_type: "row",
              index: 0,
              count: 1,
            },
          },
        },
        { ...context, messageID: "msg_B" },
      ),
    );
    expect(edited.ok).toBe(true);
    expect(calls).toEqual([
      {
        sessionId: "calling_B",
        messageId: "msg_B",
        name: "sheet_delete_dimension",
        args: {
          sheet_id: "sheet_B",
          dimension_type: "row",
          index: 0,
          count: 1,
        },
      },
    ]);
    await expect(
      plugin.tool.jugglework_execute.execute(
        { id: "office.call", args: { name: "sheet_get_sheet_info", args: {} } },
        { ...context, messageID: undefined },
      ),
    ).rejects.toThrow("message");
  } finally {
    server.stop(true);
    if (previous.url === undefined) delete process.env.JUGGLEWORK_SERVER_URL;
    else process.env.JUGGLEWORK_SERVER_URL = previous.url;
    if (previous.token === undefined)
      delete process.env.JUGGLEWORK_SERVER_TOKEN;
    else process.env.JUGGLEWORK_SERVER_TOKEN = previous.token;
  }
});
