import { expect, test } from "bun:test";
import { registerNativeActionRoutes } from "../routes/native-actions.js";
import { matchRoute, type Route } from "../routes/registry.js";
import { NativeActionProposals, PROPOSAL_TTL_MS, RUNNING_STALE_MS } from "./proposals.js";
import { NativeActionsService } from "./service.js";
import { NativeActionTurns } from "./turns.js";

const scope = { baseUrl: "https://work.example.test", userId: "u1", organizationId: "org-a" };
const ref = "contact:abc:m2";

function setup() {
  let now = 1_000_000;
  const routes: Route[] = [];
  const turns = new NativeActionTurns();
  const requests: Array<{ op: string; params: unknown }> = [];
  const proposals = new NativeActionProposals(() => now);
  const service = new NativeActionsService(turns, async (input) => {
    requests.push({ op: input.op, params: input.params });
    return { preview: { kind: input.op, echo: input.params }, execution: { frozen: true, params: input.params } };
  }, proposals);
  registerNativeActionRoutes({
    routes, config: {} as any, service,
    jsonResponse: (data, status) => Response.json(data, { status }),
    readJsonBody: (request) => request.json(),
    resolveWorkspace: async () => ({ id: "local", workspaceType: "local" }) as any,
    resolveTurn: async (_w, sessionId, messageId) => sessionId === "s1" && messageId === "assistant-a" ? "user-a" : null,
  });
  turns.register("local", "s1", "user-a", scope);
  const call = async (method: string, path: string, body?: unknown) => {
    const route = matchRoute(routes, method, path.split("?")[0]!)!;
    const url = new URL(`http://localhost${path}`);
    const response = await route.handler({ url, params: route.params, request: new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) }) } as any);
    return { auth: route.auth, body: await response.json() as any };
  };
  const prepare = (kind: "calendar" | "meeting" | "im", args: unknown) => call("POST", `/workspace/local/native-actions/prepare/${kind}`, { sessionId: "s1", messageId: "assistant-a", args });
  const host = (id: string, verb: "claim" | "cancel" | "complete", extra: Record<string, unknown> = {}) =>
    call("POST", `/workspace/local/native-actions/proposals/${id}/${verb}`, { sessionId: "s1", ...extra });
  return { routes, requests, call, prepare, host, advance: (ms: number) => { now += ms; } };
}

test("preparing writes nothing and says so; the proposal is pending under the user turn", async () => {
  const f = setup();
  const { body } = await f.prepare("im", { to: ref, text: "明天十点开会" });
  expect(body).toMatchObject({ action: "im.send", state: "pending", turnId: "user-a", steps: [] });
  expect(body.note).toMatch(/Nothing has been written/);
  expect(body.execution).toBeUndefined();
  expect(f.requests).toEqual([{ op: "im.prepare", params: { to: ref, text: "明天十点开会" } }]);
});

test("confirm, cancel and receipts are host-only; the model's client token cannot confirm", async () => {
  const f = setup();
  const { body } = await f.prepare("im", { to: ref, text: "hi" });
  for (const verb of ["claim", "cancel", "complete"] as const)
    expect(matchRoute(f.routes, "POST", `/workspace/local/native-actions/proposals/${body.id}/${verb}`)!.auth).toBe("host");
  const status = await f.call("POST", "/workspace/local/native-actions/status", { sessionId: "s1", proposalId: body.id });
  expect(status.auth).toBe("client");
  // No model-facing argument can mark it confirmed.
  await expect(f.prepare("im", { to: ref, text: "hi", confirmed: true })).rejects.toThrow();
});

test("a proposal runs once: a second confirm, a cancel after claim, or a confirm after cancel are refused", async () => {
  const f = setup();
  const { body } = await f.prepare("im", { to: ref, text: "hi" });
  const claimed = await f.host(body.id, "claim");
  expect(claimed.body.execution).toEqual({ frozen: true, params: { to: ref, text: "hi" } });
  await expect(f.host(body.id, "claim")).rejects.toMatchObject({ status: 409, code: "native_action_proposal_used" });
  expect((await f.host(body.id, "cancel")).body.state).toBe("running");
  const done = await f.host(body.id, "complete", { steps: [{ name: "im.send", status: "succeeded" }] });
  expect(done.body.state).toBe("succeeded");
  await expect(f.host(body.id, "complete", { steps: [{ name: "im.send", status: "failed" }] })).rejects.toMatchObject({ code: "native_action_proposal_not_running" });

  const other = (await f.prepare("im", { to: ref, text: "bye" })).body;
  expect((await f.host(other.id, "cancel")).body.state).toBe("cancelled");
  await expect(f.host(other.id, "claim")).rejects.toMatchObject({ status: 409 });
});

test("an expired proposal cannot be confirmed; a run that never reports back becomes unknown", async () => {
  const f = setup();
  const { body } = await f.prepare("im", { to: ref, text: "hi" });
  f.advance(PROPOSAL_TTL_MS);
  await expect(f.host(body.id, "claim")).rejects.toMatchObject({ status: 410, code: "native_action_proposal_expired" });
  const next = (await f.prepare("im", { to: ref, text: "again" })).body;
  await f.host(next.id, "claim");
  f.advance(RUNNING_STALE_MS);
  const status = await f.call("POST", "/workspace/local/native-actions/status", { sessionId: "s1", proposalId: next.id });
  expect(status.body.state).toBe("unknown");
});

test("step receipts summarize to partial or unknown, never success", async () => {
  const f = setup();
  const run = async (steps: unknown[]) => {
    const { body } = await f.prepare("meeting", { title: "周会", immediate: true });
    await f.host(body.id, "claim");
    return (await f.host(body.id, "complete", { steps })).body.state;
  };
  expect(await run([{ name: "meeting.create", status: "succeeded" }, { name: "meeting.share", status: "failed" }])).toBe("partial");
  expect(await run([{ name: "meeting.create", status: "succeeded" }, { name: "meeting.share", status: "unknown" }])).toBe("unknown");
  expect(await run([{ name: "meeting.create", status: "failed" }, { name: "meeting.share", status: "skipped" }])).toBe("failed");
});

test("prepare validates times and refs before reaching the renderer", async () => {
  const f = setup();
  for (const args of [
    { title: "x", date: "2026-11-20" },
    { title: "x", date: "2026-11-20", allDay: true, startTime: "09:00" },
    { title: "x", date: "2026-11-20", startTime: "25:00", endTime: "26:00" },
    { title: "x", date: "2026-11-20", startTime: "09:00", endTime: "10:00", attendees: ["张三"] },
    { title: "x", date: "2026-11-20", startTime: "09:00", endTime: "10:00", organizationId: "org-b" },
  ]) await expect(f.prepare("calendar", args)).rejects.toThrow();
  for (const args of [
    { title: "x", immediate: false },
    { title: "x", immediate: true, date: "2026-11-20", startTime: "09:00" },
    { title: "x", immediate: true, notifyInvitees: true },
  ]) await expect(f.prepare("meeting", args)).rejects.toThrow();
  await expect(f.prepare("im", { to: "current-chat", text: "hi" })).rejects.toThrow();
  await expect(f.prepare("im", { to: ref, text: "   " })).rejects.toThrow();
  expect(f.requests).toEqual([]);
});

test("another session cannot read or confirm the proposal", async () => {
  const f = setup();
  const { body } = await f.prepare("im", { to: ref, text: "hi" });
  await expect(f.call("POST", `/workspace/local/native-actions/proposals/${body.id}/claim`, { sessionId: "s2" })).rejects.toMatchObject({ status: 404 });
  await expect(f.call("POST", "/workspace/local/native-actions/status", { sessionId: "s2", proposalId: body.id })).rejects.toMatchObject({ status: 404 });
  expect((await f.call("GET", "/workspace/local/native-actions/proposals?sessionId=s2")).body.items).toEqual([]);
});
