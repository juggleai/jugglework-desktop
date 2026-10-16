import { describe, expect, test } from "bun:test";
import { isToonFactoryTransientSession } from "./sessions.js";
import { filterToonFactoryTransientSse } from "../server.js";

describe("Toon Factory transient session visibility", () => {
  test("hides only explicitly tagged transient Toon Factory sessions", () => {
    expect(isToonFactoryTransientSession({ metadata: { kind: "toon-factory", transient: true, jobId: "job-1" } })).toBe(true);
    expect(isToonFactoryTransientSession({ metadata: { kind: "toon-factory", transient: false } })).toBe(false);
    expect(isToonFactoryTransientSession({ title: "[Transient Toon Factory] visible without metadata" })).toBe(false);
    expect(isToonFactoryTransientSession({ metadata: { kind: "automation", transient: true } })).toBe(false);
  });
});

test("filters mixed transient SSE frames across chunk boundaries", async () => {
  const encoder = new TextEncoder();
  const frames = [
    { type: "session.created", properties: { info: { id: "normal", metadata: {} } } },
    { type: "session.created", properties: { info: { id: "toon-hidden", metadata: { kind: "toon-factory", transient: true } } } },
    { type: "message.updated", properties: { info: { id: "secret", sessionID: "toon-hidden", role: "assistant", text: "secret output" } } },
    { type: "message.updated", properties: { info: { id: "unknown-secret", role: "assistant", text: "unknown secret output" } } },
    { type: "session.status", properties: { sessionID: "normal", status: { type: "busy" } } },
    { type: "server.connected", properties: {} },
    { type: "session.deleted", properties: { sessionID: "toon-hidden" } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames.slice(0, 47)));
      controller.enqueue(encoder.encode(frames.slice(47, 131)));
      controller.enqueue(encoder.encode(frames.slice(131)));
      controller.close();
    },
  });
  const filtered = filterToonFactoryTransientSse(new Response(source, { headers: { "content-type": "text/event-stream" } }));
  const output = await filtered.text();
  expect(output).toContain('"id":"normal"');
  expect(output).toContain('"sessionID":"normal"');
  expect(output).not.toContain("toon-hidden");
  expect(output).not.toContain("secret output");
  expect(output).not.toContain("unknown secret output");
  expect(output).toContain("server.connected");
});
