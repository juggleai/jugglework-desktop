import { createServer } from "node:http";
import { once } from "node:events";

/** In-memory protocol fixture. No engine, provider, credentials, filesystem or DB. */
export async function createSessionSmokeFixture(root, { eventFilter = () => true, onAbort = async () => undefined } = {}) {
  const workspaceId = "smoke-workspace", sessionId = "smoke-session";
  const session = { id: sessionId, title: "Isolated smoke", directory: root, version: "1", time: { created: Date.now(), updated: Date.now() } };
  const model = { id: "synthetic", providerID: "fixture", name: "Synthetic fixture", family: "fixture", status: "active", release_date: "2026-01-01",
    capabilities: { temperature: false, reasoning: false, attachment: false, toolcall: true, input: { text: true }, output: { text: true } },
    cost: { input: 0, output: 0 }, limit: { context: 32000, output: 4096 }, variants: {} };
  const providers = { all: [{ id: "fixture", name: "Fixture", source: "config", models: { synthetic: model } }], connected: ["fixture"], default: { fixture: "synthetic" } };
  let messages = [], run = null, permissions = [], questions = [], sequence = 0;
  const streams = new Map(), requests = [], starts = [], replies = [], aborts = [], droppedEvents = [];
  let sseOnlyPhase = null;
  const emit = (type, properties) => {
    const event = { type, properties };
    for (const [res, host] of streams) {
      if (!eventFilter(host, event)) { droppedEvents.push({ host, type }); continue; }
      res.write(`id: ${++sequence}\ndata: ${JSON.stringify({ workspaceId, payload: event })}\n\n`);
    }
  };
  const addMessage = (text, role = "assistant", broadcast = true, messageId) => {
    const id = messageId ?? `msg_fixture_${messages.length}`;
    const info = { id, sessionID: sessionId, role, time: { created: Date.now(), ...(role === "assistant" ? { completed: Date.now() } : {}) },
      ...(role === "user" ? { agent: "build", model: { providerID: "fixture", modelID: "synthetic" } }
        : { parentID: messages.at(-1)?.info.id ?? "seed", providerID: "fixture", modelID: "synthetic", mode: "build", agent: "build", path: { cwd: root, root }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" }) };
    const part = { id: `prt_${id}`, sessionID: sessionId, messageID: id, type: "text", text };
    messages.push({ info, parts: [part] });
    if (broadcast) { emit("message.updated", { info }); emit("message.part.updated", { part }); }
  };
  addMessage("fixture-initial-message", "user", false);
  const makeRun = () => ({ workspaceId, sessionId, runId: `run_${Date.now()}`, generation: starts.length + 1, origin: "local-renderer", startCommandCorrelationId: null,
    abortCommandCorrelationId: null, status: "running", observedActive: true, startedAt: Date.now(), updatedAt: Date.now(), activeObservedAt: Date.now(), abortRequestedAt: null });
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    const url = new URL(req.url, "http://fixture"), p = url.pathname;
    const host = req.headers.authorization ? "file" : "main";
    requests.push({ method: req.method, path: p, host });
    const json = (data, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    try {
      if (p.endsWith("/opencode/event")) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        streams.set(res, host);
        res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
        req.on("close", () => streams.delete(res)); return;
      }
      let body = "";
      for await (const chunk of req) { body += chunk; if (body.length > 100000) throw new Error("Oversized fixture request"); }
      const input = body ? JSON.parse(body) : {};
      if (p === "/workspaces") return json({ items: [{ id: workspaceId, path: root, workspaceType: "local" }] });
      if (p.endsWith("/files/stat")) return json({ exists: true, kind: "file", size: 20, updatedAt: 1 });
      if (p.endsWith("/files/raw")) { res.writeHead(200, { "content-type": "text/plain" }); res.end("Synthetic file preview"); return; }
      if (p.endsWith("/snapshot") && !p.includes("/interactions/")) return json({ item: { session, messages, todos: [], status: { type: run ? "busy" : "idle" } } });
      if (p.endsWith(`/sessions/${sessionId}`)) return json({ item: session });
      if (p.endsWith("/messages")) return json({ items: messages });
      if (p.endsWith("/session-runs")) return json({ items: run ? [run] : [] });
      if (p.endsWith("/permission-mode")) return json({ state: null, grants: [], supported: false, profileVersion: null });
      if (p.endsWith("/interactions/snapshot")) return json({ item: { snapshotStartedAt: Date.now(), rootSessionId: sessionId, includeDescendants: true, permissions, questions } });
      if (p.endsWith("/opencode/provider")) return json(providers);
      if (p.endsWith("/opencode/agent")) return json(["build", "team/reviewer"].map((name) => ({ name, mode: "primary", native: name === "build", hidden: false })));
      if (p.endsWith("/runs/start")) {
        starts.push({ host, input });
        if (run) return json({ error: "Session is busy", code: "session_busy" }, 409);
        run = makeRun();
        for (const part of input.prompt.parts) if (part.type === "text" && !part.synthetic) addMessage(part.text, "user", true, input.prompt.messageID);
        emit("session.status", { sessionID: sessionId, status: { type: "busy" } });
        addMessage(`fixture-answer-${starts.length}`);
        return json({ disposition: "started", run });
      }
      if (p.endsWith("/abort")) {
        const previous = run;
        const observation = await onAbort({ host, path: p, run: previous });
        aborts.push({ host, path: p, observation }); run = null;
        emit("session.status", { sessionID: sessionId, status: { type: "idle" } });
        emit("session.idle", { sessionID: sessionId });
        return json({ run: previous, abortRequested: true });
      }
      if (p.endsWith("/permission/reply") || p.endsWith("/question/reply")) {
        const kind = p.endsWith("/permission/reply") ? "permission" : "question";
        const id = p.split("/").at(-3), target = p.split("/").at(-5);
        replies.push({ host, kind, id, target, input });
        if (kind === "permission") permissions = permissions.filter((it) => it.id !== id);
        else questions = questions.filter((it) => it.id !== id);
        emit(`${kind}.replied`, { sessionID: target, requestID: id, response: "once", answers: [["Smoke answer"]] });
        return json({ interactionId: id, status: "resolved" });
      }
      // Nonessential main-only inventories are empty, never real services.
      if (p.endsWith("/keys")) return json({ keys: [] });
      if (/\/(?:models|deliveries|skills|commands|plugins)$/.test(p)) return json({ items: [], models: [] });
      return json({ error: "Unimplemented synthetic route", code: "fixture_not_found" }, 404);
    } catch (error) { json({ error: error.message }, 500); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const heartbeat = setInterval(() => emit("server.heartbeat", {}), 1000);
  return {
    origin: `http://127.0.0.1:${server.address().port}`, requests, starts, replies, aborts, droppedEvents,
    get connections() { return streams.size; },
    // Pending state is absent from all HTTP read models, including active runs.
    beginSseOnlyPhase() {
      if (sseOnlyPhase || run) throw new Error("SSE-only phase requires an idle fixture");
      const messageId = "msg_sse_only", prefix = "fixture-sse-only-message", delta = "-delta-only";
      const info = { id: messageId, sessionID: sessionId, role: "assistant", time: { created: Date.now() },
        parentID: messages.at(-1).info.id, providerID: "fixture", modelID: "synthetic", mode: "build", agent: "build",
        path: { cwd: root, root }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
      const part = { id: "prt_sse_only", sessionID: sessionId, messageID: messageId, type: "text", text: prefix };
      sseOnlyPhase = { info, part, run: makeRun(), deltaSent: false, busySent: false };
      emit("message.updated", { info }); emit("message.part.updated", { part });
      return { messageId, prefix, delta, text: prefix + delta };
    },
    sendSseOnlyDelta(delta) {
      if (!sseOnlyPhase || sseOnlyPhase.deltaSent) throw new Error("SSE-only delta phase unavailable");
      sseOnlyPhase.deltaSent = true;
      sseOnlyPhase.part.text += delta;
      emit("message.part.delta", { sessionID: sessionId, messageID: sseOnlyPhase.info.id, partID: sseOnlyPhase.part.id, field: "text", delta });
    },
    sendSseOnlyBusy() {
      if (!sseOnlyPhase || sseOnlyPhase.busySent) throw new Error("SSE-only busy phase unavailable");
      sseOnlyPhase.busySent = true;
      emit("session.status", { sessionID: sessionId, status: { type: "busy" } });
    },
    commitSseOnlyPhase() {
      if (!sseOnlyPhase?.deltaSent || !sseOnlyPhase.busySent) throw new Error("SSE-only phase incomplete");
      messages.push({ info: sseOnlyPhase.info, parts: [sseOnlyPhase.part] });
      run = sseOnlyPhase.run;
      sseOnlyPhase = null;
    },
    finishSseOnlyPhase() {
      if (sseOnlyPhase || !run) throw new Error("SSE-only phase must commit before finishing");
      const message = messages.at(-1);
      message.info.time.completed = Date.now(); message.info.finish = "stop";
      run = null;
      emit("message.updated", { info: message.info });
      emit("session.status", { sessionID: sessionId, status: { type: "idle" } });
      emit("session.idle", { sessionID: sessionId });
    },
    hiddenBusy() { run = makeRun(); },
    childInteraction(kind) {
      const child = `new-${kind}-child`;
      const item = { id: `smoke-${kind}`, sessionID: child, protocol: "legacy", targetSessionId: child, parentSessionId: sessionId, rootSessionId: sessionId, ancestryPath: [sessionId, child],
        ...(kind === "permission" ? { permission: "read", patterns: ["smoke-permission-path"], always: [], metadata: {} }
          : { questions: [{ id: "smoke-question-id", question: "smoke-child-question", header: "Smoke question", options: [{ label: "Smoke answer", description: "Synthetic answer" }], custom: false }] }) };
      if (kind === "permission") permissions = [item]; else questions = [item];
      // Child never existed at mount. Its first event can precede ancestry proof.
      emit("session.created", { info: { ...session, id: child, parentID: sessionId } });
      emit(`${kind}.asked`, item);
    },
    disconnectAndAddSnapshotMessage() {
      for (const res of streams.keys()) res.end(); streams.clear();
      addMessage("fixture-offline-snapshot-only", "assistant", false);
    },
    async close() {
      clearInterval(heartbeat);
      for (const res of streams.keys()) res.destroy(); streams.clear();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
