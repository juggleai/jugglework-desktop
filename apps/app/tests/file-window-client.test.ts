import { expect, test } from "bun:test";
import { createJuggleWorkServerClient } from "../src/app/lib/jugglework-server";
import { loadWorkspaceFile } from "../src/react-app/domains/session/files/file-content";

test("tokenless file-window client reads preview bytes and Office JSON through Main IPC", async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const calls: string[] = [];
  const bytes = Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0, 255);
  (globalThis as typeof globalThis & { window: Window }).window = {
    __JUGGLEWORK_ELECTRON__: {
      invokeDesktop: async (command: string, url: string, init: { headers: Record<string, string> }) => {
        expect(command).toBe("__fetch");
        expect(new Headers(init.headers).has("authorization")).toBe(false);
        expect(new URL(url).searchParams.has("token")).toBe(false);
        calls.push(url);
        const raw = url.includes("/files/raw?");
        const value = url.includes("/files/stat?")
          ? { exists: true, kind: "file", size: bytes.length, updatedAt: 123 }
          : { document: { documentId: "od_A" } };
        return { status: 200, statusText: "OK",
          headers: [["content-type", raw ? "application/pdf" : "application/json"]],
          body: raw ? bytes.buffer : JSON.stringify(value) };
      },
    },
  } as unknown as Window;
  globalThis.fetch = (() => { throw new Error("preview must use Main IPC"); }) as typeof fetch;
  try {
    const client = createJuggleWorkServerClient({ baseUrl: "http://127.0.0.1:1234" });
    const file = await loadWorkspaceFile(client, "ws", "report.pdf");
    expect(file.presentation).toBe("pdf");
    expect(new Uint8Array(file.bytes)).toEqual(bytes);
    expect((await client.openOfficeDocument("ws", "ses", "report.docx")).document.documentId).toBe("od_A");
    expect((await client.getOfficeDocument("ws", "od_A")).document.documentId).toBe("od_A");
    expect(calls).toHaveLength(4);
  } finally {
    (globalThis as typeof globalThis & { window: Window | undefined }).window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});
