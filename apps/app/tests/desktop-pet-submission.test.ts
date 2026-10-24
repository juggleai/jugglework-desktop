import { expect, test } from "bun:test";
import { claimSessionSubmission } from "../src/react-app/domains/session/sync/submission-guard";
import { submitSessionDraft } from "../src/react-app/domains/session/sync/draft-submission";
import type { Client, ComposerDraft } from "../src/app/types";
import type { JuggleWorkServerClient } from "../src/app/lib/jugglework-server";
import { clearQueuedSessionDrafts } from "../src/react-app/domains/session/surface/queued-draft-cleanup";
import { useComposerStateStore } from "../src/react-app/domains/session/surface/composer-state-store";
import { submitPetFollowUp } from "../src/react-app/domains/pet/pet-submission";

// 与原会话、宠物后台队列相同的完整入口；测试替身仅替换目标项目的网络服务。
async function submitSessionText(input: {client: Client; host: JuggleWorkServerClient; workspaceId: string; sessionId: string; text: string; model: {providerID:string;modelID:string}|null; variant:string|null; runtimeKey: undefined; isCurrent:()=>boolean}) {
  return submitSessionDraft({ ...input, draft: { text: input.text, parts: [{ type: "text", text: input.text }], attachments: [], mode: "prompt" }, endpoint: null, workspaceRoot: "/target", prepare: async()=>({model:input.model,variant:input.variant}), cloudSubmit: async ({send,validateBeforeSend})=> {if (validateBeforeSend && !await validateBeforeSend()) return {outcome:"cancelled",reason:"context_changed"}; const result=await send(); return result === false ? {outcome:"cancelled",reason:"context_changed"} : {outcome:"sent",bypassed:true};}, validateGeneration:()=>true });
}

test("shared text sender preserves explicit original task, model and environment names", async () => {
  const requests: unknown[] = [];
  const client = { session: { promptAsync: async (request: unknown) => { requests.push(request); return {}; } } } as unknown as Client;
  const host = { baseUrl: "https://test-pet.invalid", listUserEnvKeys: async () => ({ keys: ["JUGGLE_TEST_KEY"] }) } as unknown as JuggleWorkServerClient;
  await submitSessionText({ client, host, workspaceId: "other-project", sessionId: "original-root", text: "继续跟进", model: { providerID: "p", modelID: "m" }, variant: "high", runtimeKey: undefined, isCurrent: () => true });
  expect(requests[0]).toMatchObject({ sessionID: "original-root", model: { providerID: "p", modelID: "m" }, variant: "high", parts: [{ type: "text", text: "继续跟进" }], system: expect.stringContaining("JUGGLE_TEST_KEY") });
  expect(await submitSessionText({ client, host, workspaceId: "other-project", sessionId: "original-root", text: "old", model: null, variant: null, runtimeKey: undefined, isCurrent: () => false })).toMatchObject({outcome:"cancelled"});
  expect(requests.length).toBe(1);
});
test("main and pet entry points cannot prepare the same task twice", () => {
  const release = claimSessionSubmission("workspace", "root");
  expect(() => claimSessionSubmission("workspace", "root")).toThrow("正在发送");
  const other = claimSessionSubmission("workspace", "another-root"); other(); release();
  const retry = claimSessionSubmission("workspace", "root"); retry();
});
test("stopping removes queued follow-ups but preserves the user's unsent composer draft", () => {
  const store = useComposerStateStore.getState();
  store.setDraft("pet-stop-root", "unsent local draft");
  store.appendQueuedDraft("pet-stop-root", { text: "queued", mode: "prompt", parts: [{ type: "text", text: "queued" }], attachments: [] });
  clearQueuedSessionDrafts({} as JuggleWorkServerClient, "workspace", "pet-stop-root");
  expect(useComposerStateStore.getState().queuedDrafts["pet-stop-root"]).toBeUndefined();
  expect(useComposerStateStore.getState().sessions["pet-stop-root"]?.draft).toBe("unsent local draft");
  store.clearSession("pet-stop-root");
});

test("idle pet submissions stay behind an existing blocked FIFO head", async () => {
  const sessionId = "pet-blocked-fifo", store = useComposerStateStore.getState();
  const draft = (text: string): ComposerDraft => ({ text, parts: [{ type: "text", text }], attachments: [], mode: "prompt" });
  const old = store.appendQueuedDraft(sessionId, draft("first"));
  store.removeQueuedDraft(sessionId, old.id);
  store.restoreQueuedDraft(sessionId, { ...old, petWorkspaceId: "project", petBlockedReason: "发送结果待确认" });
  let sent = 0;
  try {
    const result = await submitPetFollowUp({ workspaceId: "project", sessionId, draft: draft("second"), active: false, queueOnBusy: true, send: async () => { sent++; } });
    expect(result.delivery).toBe("queued"); expect(sent).toBe(0);
    expect(useComposerStateStore.getState().queuedDrafts[sessionId]?.map((item) => item.draft.text)).toEqual(["first", "second"]);
    expect(useComposerStateStore.getState().queuedDrafts[sessionId]?.[0]?.petBlockedReason).toBe("发送结果待确认");
    store.removeQueuedDraft(sessionId, old.id);
    await submitPetFollowUp({ workspaceId: "project", sessionId, draft: draft("third"), active: false, queueOnBusy: true, send: async () => { sent++; } });
    expect(useComposerStateStore.getState().queuedDrafts[sessionId]?.map((item) => item.draft.text)).toEqual(["second", "third"]);
    expect(sent).toBe(0);
  } finally { store.clearSession(sessionId); }
});

test("an idle task without queued messages uses the original send entry", async () => {
  let sent = 0;
  const result = await submitPetFollowUp({ workspaceId: "project", sessionId: "pet-empty-fifo", draft: { text: "now", parts: [{ type: "text", text: "now" }], attachments: [], mode: "prompt" }, active: false, queueOnBusy: true, send: async () => { sent++; } });
  expect(result.delivery).toBe("sent"); expect(sent).toBe(1);
});

test("browser and Electron transport losses after POST stay unconfirmed without automatic retry", async () => {
  for (const error of [new Error("fetch failed"), new TypeError("Failed to fetch"), new Error("net::ERR_CONNECTION_RESET"), new TypeError("Load failed"), Object.assign(new Error("request failed"), { cause: { code: "ECONNRESET" } }), { status: 503, message: "unavailable" }]) {
    let requests = 0;
    const client = { session: { promptAsync: async () => { requests++; throw error; } } } as unknown as Client;
    const host = { baseUrl: "https://test-pet-unknown.invalid", listUserEnvKeys: async () => ({ keys: [] }) } as unknown as JuggleWorkServerClient;
    await expect(submitSessionText({ client, host, workspaceId: "project", sessionId: "root", text: "work", model: null, variant: null, runtimeKey: undefined, isCurrent: () => true })).rejects.toThrow("结果待确认");
    expect(requests).toBe(1);
  }
});

test("explicit request rejection remains an ordinary editable failure", async () => {
  const client = { session: { promptAsync: async () => ({ error: { status: 400, message: "invalid model" } }) } } as unknown as Client;
  const host = { baseUrl: "https://test-pet-rejected.invalid", listUserEnvKeys: async () => ({ keys: [] }) } as unknown as JuggleWorkServerClient;
  await expect(submitSessionText({ client, host, workspaceId: "project", sessionId: "root", text: "work", model: null, variant: null, runtimeKey: undefined, isCurrent: () => true })).rejects.toThrow("invalid model");
});

test("background FIFO sends the complete complex draft to its pinned project", async () => {
  const requests: any[] = [];
  const draft: ComposerDraft = { text: "file + pasted context", mode: "prompt", attachments: [], parts: [{type:"paste",label:"context",text:"preserved pasted text"},{type:"file",path:"reference.txt"},{type:"capability",kind:"cloud-mcp",name:"calendar",prompt:"preserved cloud capability"}] };
  let gated = false;
  const result = await submitSessionDraft({ draft, sessionId:"pinned-complex", workspaceId:"background", workspaceRoot:"/background-project", endpoint:null,
    client:{session:{promptAsync:async (request:unknown)=>{requests.push(request);return {};}}} as unknown as Client,
    host:{baseUrl:"complex",listUserEnvKeys:async()=>({keys:[]})} as unknown as JuggleWorkServerClient,
    isCurrent:()=>true, prepare:async()=>({model:{providerID:"p",modelID:"m"},variant:null}), validateGeneration:()=>true,
    cloudSubmit:async ({skipGate,send})=>{gated=!skipGate;await send();return {outcome:"sent"};},
  });
  expect(result.outcome).toBe("sent"); expect(gated).toBe(true);
  expect(requests[0]).toMatchObject({sessionID:"pinned-complex",parts:[{type:"text",text:"preserved pasted text"},{type:"file",url:"file:///background-project/reference.txt"},{type:"text",text:"preserved cloud capability"}]});
});

test("shared delivery preserves presentation turn identity and the source file MIME type", async () => {
  const requests: unknown[] = [];
  const result = await submitSessionDraft({
    draft: { text: "create slides", mode: "prompt", attachments: [], parts: [{ type: "text", text: "create slides" }, { type: "file", path: "source.pptx" }] },
    sessionId: "presentation-turn", workspaceId: "project", workspaceRoot: "/project", endpoint: null,
    submission: { delivery: "start", messageID: "msg_presentation_stable", intent: "presentation-creation" },
    client: { session: { promptAsync: async (request: unknown) => { requests.push(request); return {}; } } } as unknown as Client,
    host: { baseUrl: "presentation-turn", listUserEnvKeys: async () => ({ keys: [] }) } as unknown as JuggleWorkServerClient,
    isCurrent: () => true, prepare: async () => ({ model: null, variant: null }), validateGeneration: () => true,
    cloudSubmit: async ({ send }) => { await send(); return { outcome: "sent" }; },
  });
  expect(result.outcome).toBe("sent");
  expect(requests[0]).toMatchObject({
    sessionID: "presentation-turn", messageID: "msg_presentation_stable",
    parts: [{ type: "text", text: "create slides" }, { type: "file", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", url: "file:///project/source.pptx" }],
  });
});

test("provider mutation during async preparation cancels delivery and releases the shared claim", async () => {
  let valid = true, sent = 0;
  const input = {draft:{text:"generate",parts:[{type:"text",text:"generate"}],attachments:[],mode:"prompt"} as ComposerDraft,sessionId:"generation-race",workspaceId:"project",workspaceRoot:"/project",endpoint:null,
    client:{session:{promptAsync:async()=>{sent++;return {};}}} as unknown as Client,
    host:{baseUrl:"generation-race",listUserEnvKeys:async()=>{valid=false;return {keys:[]};}} as unknown as JuggleWorkServerClient,
    isCurrent:()=>true,prepare:async()=>({model:null,variant:null}),validateGeneration:()=>valid,
    cloudSubmit:async ({send}:any)=> await send() === false ? {outcome:"cancelled" as const,reason:"context_changed" as const} : {outcome:"sent" as const},
  };
  expect(await submitSessionDraft(input)).toMatchObject({outcome:"cancelled"}); expect(sent).toBe(0);
  const release = claimSessionSubmission("project","generation-race"); release();
});
