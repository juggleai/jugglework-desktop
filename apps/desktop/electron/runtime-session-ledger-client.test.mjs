import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRuntimeSessionLedgerClient } from "./runtime-session-ledger-client.mjs";

describe("runtime session ledger client", () => {
  it("buffers early events, authenticates with Host Token and flushes after mapping", async () => {
    const calls = [];
    const client = createRuntimeSessionLedgerClient({
      getAccess: () => ({ baseUrl: "http://127.0.0.1:4096", hostToken: "host-secret" }),
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const event = { schemaVersion: 1, eventId: "event_1", occurredAt: 2, workspaceId: "ws_1", orgId: "org_1", runtimeKind: "codex",
      sessionId: "ses_1", threadId: "thr_1", turnId: "turn_1", type: "turn.started" };
    await client.accept(event);
    assert.equal(calls.length, 0);
    await client.register({ id: "ses_1", orgId: "org_1", workspaceId: "ws_1" });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.headers["X-JuggleWork-Host-Token"], "host-secret");
    assert.equal(JSON.stringify(calls).includes("host-secret"), true);
    assert.match(calls[1].url, /\/event$/);
  });
});
