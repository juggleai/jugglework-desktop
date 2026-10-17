import { describe, expect, test } from "bun:test";
import { isToonFactoryTransientSession } from "./sessions.js";
import {
  classifySessionVisibilityFamily,
  registerToonProjectSession,
  registerVisibleSession,
  resolveSessionVisibility,
  sessionMetadataVisibility,
  unregisterSession,
} from "../toon-factory/transient-session-registry.js";
import { filterToonFactoryTransientSse } from "../server.js";

describe("Toon Factory transient session visibility", () => {
  test("hides only explicitly tagged transient Toon Factory sessions", () => {
    expect(isToonFactoryTransientSession({ metadata: { kind: "toon-factory", transient: true, jobId: "job-1" } })).toBe(true);
    expect(isToonFactoryTransientSession({ metadata: { kind: "toon-factory", transient: false } })).toBe(false);
    expect(isToonFactoryTransientSession({ title: "[Transient Toon Factory] visible without metadata" })).toBe(false);
    expect(isToonFactoryTransientSession({ metadata: { kind: "automation", transient: true } })).toBe(false);
  });
  test("classifies only explicit or known Toon lineage without hiding absent ordinary parents", () => {
    expect(sessionMetadataVisibility({ metadata: { kind: "toon-factory", surface: "project-assistant", hidden: true } })).toBe("toon_project_assistant");
    expect(sessionMetadataVisibility({ metadata: { kind: "toon-factory", surface: "unknown" } })).toBe("toon_transient_generation");
    const family = classifySessionVisibilityFamily([
      { id: "normal", metadata: {} },
      { id: "project", metadata: { kind: "toon-factory", visibility: "toon_project_assistant" } },
      { id: "child", parentID: "project" },
      { id: "grandchild", parentID: "child" },
      { id: "orphan", parentID: "missing" },
    ]);
    expect(family.get("normal")).toBe("normal");
    expect(family.get("project")).toBe("toon_project_assistant");
    expect(family.get("child")).toBe("toon_project_subagent");
    expect(family.get("grandchild")).toBe("toon_project_subagent");
    expect(family.get("orphan")).toBe("normal");
  });
  test("authoritative resolution never promotes broken parent chains to normal", async () => {
    expect(await resolveSessionVisibility("ws", { id: "child", parentID: "missing" }, async () => null)).toBe("unknown");
    expect(await resolveSessionVisibility("ws", { id: "cycle", parentID: "cycle" }, async () => ({ id: "cycle", parentID: "cycle" }))).toBe("unknown");
    expect(await resolveSessionVisibility("ws", { id: "normal", parentID: "missing", metadata: { visibility: "normal" } }, async () => null)).toBe("unknown");
  });
  test("derives child visibility from authoritative parent lineage even when child metadata says normal", async () => {
    const records = new Map<string, unknown>([
      ["ordinary-root", { id: "ordinary-root", metadata: { visibility: "normal" } }],
      ["toon-root", { id: "toon-root", metadata: { kind: "toon-factory", visibility: "toon_project_assistant" } }],
    ]);
    const read = async (id: string) => records.get(id) ?? null;
    expect(await resolveSessionVisibility("ws", { id: "ordinary-child", parentID: "ordinary-root", metadata: { visibility: "normal" } }, read)).toBe("normal");
    expect(await resolveSessionVisibility("ws", { id: "toon-child", parentID: "toon-root", metadata: { visibility: "normal" } }, read)).toBe("toon_project_subagent");
  });
  test("prefers runtime lineage over stale registry and metadata classifications", async () => {
    registerVisibleSession("ws-runtime", "toon-child");
    registerVisibleSession("ws-runtime", "toon-root");
    try {
      const persistent = new Map([
        ["toon-root", "toon_project_assistant" as const],
        ["toon-child", "toon_project_subagent" as const],
      ]);
      expect(await resolveSessionVisibility(
        "ws-runtime",
        { id: "toon-child", parentID: "toon-root", metadata: { visibility: "normal" } },
        async () => null,
        (id) => persistent.get(id) ?? null,
      )).toBe("toon_project_subagent");
      expect(classifySessionVisibilityFamily(
        [{ id: "toon-root", metadata: { visibility: "normal" } }, { id: "toon-child", parentID: "toon-root", metadata: { visibility: "normal" } }],
        "ws-runtime",
        true,
        (id) => persistent.get(id) ?? null,
      ).get("toon-child")).toBe("toon_project_subagent");
    } finally {
      unregisterSession("ws-runtime", "toon-child");
      unregisterSession("ws-runtime", "toon-root");
    }
  });
  test("does not trust a cached normal parent over its Toon ancestor", async () => {
    registerVisibleSession("ws-deep", "middle");
    registerToonProjectSession("ws-deep", "root", "toon_project_assistant");
    try {
      const records = new Map<string, unknown>([
        ["middle", { id: "middle", parentID: "root", metadata: { visibility: "normal" } }],
        ["root", { id: "root", metadata: { visibility: "normal" } }],
      ]);
      expect(await resolveSessionVisibility(
        "ws-deep",
        { id: "child", parentID: "middle", metadata: { visibility: "normal" } },
        async (id) => records.get(id) ?? null,
      )).toBe("toon_project_subagent");
    } finally {
      unregisterSession("ws-deep", "middle");
      unregisterSession("ws-deep", "root");
    }
  });
  test("does not let normal metadata override a registered hidden family", async () => {
    registerToonProjectSession("ws-hidden", "project", "toon_project_assistant");
    try {
      expect(await resolveSessionVisibility(
        "ws-hidden",
        { id: "project", metadata: { visibility: "normal" } },
        async () => null,
      )).toBe("toon_project_assistant");
    } finally {
      unregisterSession("ws-hidden", "project");
    }
  });
});

test("filters mixed transient SSE frames across chunk boundaries", async () => {
  const encoder = new TextEncoder();
  const frames = [
    { type: "session.created", properties: { info: { id: "normal", metadata: {} } } },
    { type: "session.created", properties: { info: { id: "toon-hidden", metadata: { kind: "toon-factory", transient: true } } } },
    { type: "session.created", properties: { info: { id: "toon-project", metadata: { kind: "toon-factory", surface: "project-assistant", hidden: true } } } },
    { type: "session.created", properties: { info: { id: "toon-child", parentID: "toon-project", metadata: { visibility: "normal" } } } },
    { type: "message.updated", properties: { info: { id: "child-secret", sessionID: "toon-child", role: "assistant", text: "child secret output" } } },
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
  expect(output).not.toContain("toon-project");
  expect(output).not.toContain("toon-child");
  expect(output).not.toContain("child secret output");
  expect(output).toContain("server.connected");
});
