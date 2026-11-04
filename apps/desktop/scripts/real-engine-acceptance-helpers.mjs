import assert from "node:assert/strict";

/** A pre-cleanup EOF/read/parse error stays observable even when polling succeeds. */
export function streamHealth() {
  let failure;
  return {
    fail(error) { failure ??= error instanceof Error ? error : new Error(String(error)); },
    check() { if (failure) throw failure; },
  };
}

export async function consumeSse(body, signal, accept, health) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (!signal.aborted) throw Error("Server SSE EOF before cleanup");
        return;
      }
      pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let end;
      while ((end = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 2);
        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (data) accept(JSON.parse(data));
      }
    }
  } catch (error) {
    if (!signal.aborted) health.fail(error);
  } finally { reader.releaseLock(); }
}

export function isTerminalEvent(event) {
  const info = event.properties?.info;
  return event.type === "session.idle"
    || (event.type === "session.status" && event.properties?.status?.type === "idle")
    || (event.type === "message.updated" && info?.role === "assistant" && (info.finish || info.time?.completed));
}

/** Match the current user message, its assistant parentID, and ordered SSE only. */
export function roundSseEvidence(events, { startIndex, sessionId, prompt, answer, abortIndex }) {
  const indexed = events.slice(startIndex).map((event, offset) => ({ event, index: startIndex + offset }));
  const userPart = indexed.find(({ event: e }) => e.type === "message.part.updated"
    && e.properties?.part?.sessionID === sessionId && e.properties.part.type === "text" && e.properties.part.text === prompt);
  const userMessageId = userPart?.event.properties.part.messageID;
  if (!userMessageId || !indexed.some(({ event: e }) => e.type === "message.updated"
    && e.properties?.info?.id === userMessageId && e.properties.info.sessionID === sessionId && e.properties.info.role === "user")) return;
  const busy = indexed.find(({ event: e }) => e.type === "session.status" && e.properties?.sessionID === sessionId && e.properties.status?.type === "busy");
  if (!busy) return;
  if (abortIndex !== undefined) {
    if (busy.index >= abortIndex) return;
    const idle = indexed.find(({ event: e, index }) => index >= abortIndex && index > busy.index && e.properties?.sessionID === sessionId
      && (e.type === "session.idle" || (e.type === "session.status" && e.properties.status?.type === "idle")));
    return idle && { userMessageId, busyIndex: busy.index, abortIndex, idleIndex: idle.index };
  }
  const final = indexed.find(({ event: e, index }) => index > busy.index && e.type === "message.updated"
    && e.properties?.info?.sessionID === sessionId && e.properties.info.role === "assistant"
    && e.properties.info.parentID === userMessageId && e.properties.info.finish === "stop" && e.properties.info.time?.completed);
  if (!final) return;
  const assistantMessageId = final.event.properties.info.id;
  const text = indexed.some(({ event: e, index }) => index > busy.index && index < final.index && e.type === "message.part.updated"
    && e.properties?.part?.messageID === assistantMessageId && e.properties.part.sessionID === sessionId
    && e.properties.part.type === "text" && e.properties.part.text === answer);
  const idle = indexed.find(({ event: e, index }) => index > final.index && e.properties?.sessionID === sessionId
    && (e.type === "session.idle" || (e.type === "session.status" && e.properties.status?.type === "idle")));
  return text && idle && { userMessageId, assistantMessageId, busyIndex: busy.index, finalIndex: final.index, idleIndex: idle.index };
}

/** Probe the original detached group after exit, then kill only that group. */
export function reapProcessGroup(pid, send = process.kill.bind(process)) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1, "invalid child process group");
  try { send(-pid, 0); }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
  try { send(-pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
  return true;
}
