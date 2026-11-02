import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionSmokeFixture } from "./session-workbench-smoke-fixture.mjs";

test("SSE-only message, delta and busy stay out of every HTTP recovery model until commit", { timeout: 10000 }, async () => {
  const events = [];
  const fixture = await createSessionSmokeFixture("/synthetic", { eventFilter: (_host, event) => { events.push(event); return true; } });
  const controller = new AbortController();
  try {
    const stream = await fetch(`${fixture.origin}/workspace/smoke-workspace/opencode/event`, { signal: controller.signal });
    assert.ok(stream.ok);
    const phase = fixture.beginSseOnlyPhase();
    const read = async (route) => (await fetch(`${fixture.origin}/workspace/smoke-workspace/${route}`, { signal: AbortSignal.timeout(2000) })).json();
    const assertHidden = async () => {
      const snapshot = await read("sessions/smoke-session/snapshot");
      assert.equal(snapshot.item.status.type, "idle");
      assert.ok(!JSON.stringify(snapshot).includes(phase.messageId));
      assert.ok(!JSON.stringify(await read("sessions/smoke-session/messages")).includes(phase.messageId));
      assert.deepEqual((await read("session-runs")).items, []);
    };
    await assertHidden();
    assert.throws(() => fixture.commitSseOnlyPhase(), /incomplete/);
    fixture.sendSseOnlyDelta(phase.delta);
    await assertHidden();
    assert.throws(() => fixture.commitSseOnlyPhase(), /incomplete/);
    fixture.sendSseOnlyBusy();
    await assertHidden();
    assert.deepEqual(events.filter((event) => event.type !== "server.heartbeat").map((event) => event.type),
      ["message.updated", "message.part.updated", "message.part.delta", "session.status"]);
    assert.equal(events.find((event) => event.type === "message.part.delta").properties.delta, phase.delta);
    assert.deepEqual(events.find((event) => event.type === "session.status").properties.status, { type: "busy" });
    fixture.commitSseOnlyPhase();
    const snapshot = (await read("sessions/smoke-session/snapshot")).item;
    assert.equal(snapshot.status.type, "busy");
    assert.equal(snapshot.messages.find((message) => message.info.id === phase.messageId).parts[0].text, phase.text);
    assert.equal((await read("session-runs")).items.length, 1);
    fixture.finishSseOnlyPhase();
    assert.equal((await read("sessions/smoke-session/snapshot")).item.status.type, "idle");
  } finally { controller.abort(); await fixture.close(); }
});

test("drop-business filter affects only the file SSE wire; Main events and HTTP remain available", { timeout: 10000 }, async () => {
  const controller = new AbortController();
  const fixture = await createSessionSmokeFixture("/synthetic", {
    eventFilter: (host, event) => host !== "file" || ["server.connected", "server.heartbeat"].includes(event.type),
  });
  try {
    for (const host of ["main", "file"]) {
      await fetch(`${fixture.origin}/workspace/smoke-workspace/opencode/event`, {
        headers: host === "file" ? { authorization: "Bearer synthetic-fixture-only" } : {}, signal: controller.signal,
      });
    }
    assert.equal(fixture.connections, 2);
    const phase = fixture.beginSseOnlyPhase();
    fixture.sendSseOnlyDelta(phase.delta); fixture.sendSseOnlyBusy();
    assert.deepEqual(fixture.droppedEvents, ["message.updated", "message.part.updated", "message.part.delta", "session.status"].map((type) => ({ host: "file", type })));
    const response = await fetch(`${fixture.origin}/workspace/smoke-workspace/sessions/smoke-session/snapshot`, { signal: AbortSignal.timeout(2000) });
    assert.equal((await response.json()).item.status.type, "idle");
  } finally { controller.abort(); await fixture.close(); }
});
