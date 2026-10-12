import { expect, test } from "bun:test";

import { desktopFetch } from "../src/app/lib/desktop";

test("desktop fetch preserves a pasted image as multipart bytes across the IPC bridge", async () => {
  const image = new File([Uint8Array.of(0, 255, 42, 128)], "image.png", { type: "image/png" });
  const form = new FormData();
  form.append("file", image);
  form.append("path", "chat-attachments/session/image.png");

  const previousWindow = globalThis.window;
  const calls: unknown[][] = [];
  (globalThis as typeof globalThis & { window: Window }).window = {
    __JUGGLEWORK_ELECTRON__: {
      invokeDesktop: async (...args: unknown[]) => {
        calls.push(args);
        return { status: 200, statusText: "OK", headers: [["content-type", "application/json"]], body: '{"ok":true}' };
      },
    },
  } as unknown as Window;
  try {
    const response = await desktopFetch("http://127.0.0.1:54000/workspace/test/inbox", {
      method: "POST",
      headers: { Authorization: "Bearer test" },
      body: form,
    });
    expect(response.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const [command, url, init] = calls[0] as [string, string, { headers: Record<string, string>; body?: string; bodyBytes: Uint8Array }];
    expect(command).toBe("__fetch");
    expect(init.body).toBeUndefined();
    expect(init.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(init.headers.authorization).toBe("Bearer test");

    // Reconstruct exactly what Main sends to the worker, not just a mocked
    // success response. Boundary and binary payload must both survive.
    const workerRequest = new Request(url, {
      method: "POST",
      headers: init.headers,
      body: init.bodyBytes,
    });
    const received = await workerRequest.formData();
    const receivedFile = received.get("file") as File;
    // Bun's parsed multipart File may be detached; the request body itself
    // still contains the filename and original image bytes.
    expect(new TextDecoder().decode(init.bodyBytes)).toContain('filename="image.png"');
    expect(receivedFile.type).toBe("image/png");
    const marker = new TextEncoder().encode("Content-Type: image/png\r\n\r\n");
    const offset = init.bodyBytes.findIndex((_, index) => marker.every((byte, partIndex) => init.bodyBytes[index + partIndex] === byte));
    expect(offset).toBeGreaterThan(0);
    expect(init.bodyBytes.slice(offset + marker.length, offset + marker.length + image.size)).toEqual(Uint8Array.of(0, 255, 42, 128));
    expect(received.get("path")).toBe("chat-attachments/session/image.png");
  } finally {
    (globalThis as typeof globalThis & { window: Window | undefined }).window = previousWindow;
  }
});

test("desktop fetch preserves multipart when the caller passes a Request object", async () => {
  const form = new FormData();
  form.append("file", new File([Uint8Array.of(0, 255)], "image.png", { type: "image/png" }));
  const request = new Request("http://127.0.0.1:54000/workspace/test/inbox", { method: "POST", body: form });
  const previousWindow = globalThis.window;
  let forwarded: { headers: Record<string, string>; bodyBytes: Uint8Array } | undefined;
  (globalThis as typeof globalThis & { window: Window }).window = {
    __JUGGLEWORK_ELECTRON__: {
      invokeDesktop: async (_command: string, _url: string, init: typeof forwarded) => {
        forwarded = init;
        return { status: 200, statusText: "OK", headers: [], body: "" };
      },
    },
  } as unknown as Window;
  try {
    await desktopFetch(request);
    expect(forwarded?.headers["content-type"]).toBe(request.headers.get("content-type"));
    expect(forwarded?.bodyBytes.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(forwarded!.bodyBytes)).toContain('filename="image.png"');
  } finally {
    (globalThis as typeof globalThis & { window: Window | undefined }).window = previousWindow;
  }
});
