import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { authorizeConversationModel, fileWindowSessionEvent, projectConversationResponse, readFileWindowDesktopConfig, validateFileWindowConversationOptions } from "./file-window-conversation.mjs";
import { authorizeFileWindowFetch, fetchFileWindowResponse } from "./file-window-fetch.mjs";
import { createManagedRuntimeSseClient } from "./managed-runtime-sse-client.mjs";

const entry = () => ({ workspaceId: "ws", sessionId: "ses", workspaceRoot: "/project", tabs: [], conversation: { desktopConfig: {} } });
const access = { baseUrl: "http://127.0.0.1:1234", clientToken: "main-secret" };
const url = (route) => `${access.baseUrl}/workspace/ws/${route}`;
const post = (body) => ({ method: "POST", body: JSON.stringify(body) });
const prompt = () => ({ origin: "local-renderer", startCommandCorrelationId: "correlation", prompt: {
  parts: [{ type: "text", text: "hello" }], model: { providerID: "provider", modelID: "model" }, officeSelectionRefs: [], officeInstructions: [],
} });
const own = { workspaceId: "ws", sessionId: "ses", runId: "run" };
const interaction = { id: "permission", sessionID: "ses", targetSessionId: "ses", rootSessionId: "ses", parentSessionId: null, ancestryPath: ["ses"], protocol: "v2" };
const providers = (id = "provider", source = "api", models = ["model"]) => ({ all: [{ id, source, models: Object.fromEntries(models.map((id) => [id, { id }])) }], connected: [id], default: {} });

test("文件窗口选区只能使用 Main 投递的当前文档引用，发送与校验/释放使用同一身份边界", () => {
  const e = { ...entry(), tabs: [{ path: "report.docx", documentId: "doc" }], officeReferences: new Map([["ref", "doc"]]) };
  const input = prompt();
  input.prompt.officeSelectionRefs = ["ref"];
  input.prompt.officeInstructions = [{ instructionId: "instruction", text: "润色正文", bindingState: "bound", referenceIds: ["ref"] }];
  input.prompt.parts[0].metadata = { officeSelectionGroup: { instruction: { text: "润色正文" },
    references: [{ locator: { kind: "doc-text" }, preview: { name: "report.docx", path: "report.docx", range: "0–2", text: "正文" } }] } };
  assert.equal(authorizeFileWindowFetch(e, access, url("sessions/ses/runs/start"), post(input)).conversation.kind, "start");
  for (const action of ["validate", "release"]) {
    assert.equal(authorizeFileWindowFetch(e, access, url(`office/selection-references/${action}`), post({ sessionId: "ses", referenceIds: ["ref"] })).conversation.kind, "office-references");
    assert.throws(() => authorizeFileWindowFetch(e, access, url(`office/selection-references/${action}`), post({ sessionId: "foreign", referenceIds: ["ref"] })));
    assert.throws(() => authorizeFileWindowFetch(e, access, url(`office/selection-references/${action}`), post({ sessionId: "ses", referenceIds: ["forged"] })));
  }
  for (const patch of [{ officeSelectionRefs: ["forged"] }, { officeInstructions: [] },
    { officeInstructions: [{ ...input.prompt.officeInstructions[0], referenceIds: ["forged"] }] },
    { officeInstructions: [{ ...input.prompt.officeInstructions[0], locator: { begin: 0, end: 5 } }] }])
    assert.throws(() => authorizeFileWindowFetch(e, access, url("sessions/ses/runs/start"), post({ ...input, prompt: { ...input.prompt, ...patch } })));
  for (const metadata of [{ arbitrary: true }, { officeSelectionGroup: { ...input.prompt.parts[0].metadata.officeSelectionGroup,
    references: [{ locator: { kind: "doc-text", ranges: [{ begin: 0, end: 2 }] }, preview: { name: "report.docx", range: "0–2", text: "正文" } }] } }])
    assert.throws(() => authorizeFileWindowFetch(e, access, url("sessions/ses/runs/start"), post({ ...input, prompt: { ...input.prompt, parts: [{ type: "text", text: "正文", metadata }] } })));
  e.tabs = [];
  assert.throws(() => authorizeFileWindowFetch(e, access, url("sessions/ses/runs/start"), post(input)));
});

test("open seed accepts only exact model/agent/variant data, including explicit default agent and variant", () => {
  const value = { model: { providerID: "provider", modelID: "model/with/slash" }, agent: "plan", variant: "high" };
  assert.deepEqual(validateFileWindowConversationOptions(value), value);
  assert.deepEqual(validateFileWindowConversationOptions({ model: null, agent: null, variant: null }), { model: null, agent: null, variant: null });
  assert.deepEqual(validateFileWindowConversationOptions(undefined), {});
  for (const invalid of [null, [], { token: "synthetic-canary" }, { desktopConfig: {} }, { model: { ...value.model, token: "synthetic-canary" } }, { model: { providerID: "", modelID: "model" } }, { agent: {} }, { variant: "high\n" }])
    assert.throws(() => validateFileWindowConversationOptions(invalid));
});

test("first-open seed and prompt preserve namespaced agents and opaque variant keys, while IDs stay strict", () => {
  for (const name of ["team/reviewer", "team/code reviewer", "high effort", " high effort ", " ", "评审/代码", "a".repeat(256)]) {
    const seed = { agent: name, variant: name };
    assert.deepEqual(validateFileWindowConversationOptions(seed), seed);
    const input = prompt();
    Object.assign(input.prompt, seed);
    const request = authorizeFileWindowFetch(entry(), access, url("sessions/ses/runs/start"), post(input));
    assert.equal(JSON.parse(request.init.body.toString()).prompt.agent, name);
    assert.equal(JSON.parse(request.init.body.toString()).prompt.variant, name);
  }
  for (const name of ["", "a".repeat(257), "a\nb", "a\tb", "a\u0000b", "a\u007fb", 1, false, {}, []]) {
    for (const key of ["agent", "variant"]) {
      assert.throws(() => validateFileWindowConversationOptions({ [key]: name }));
      const input = prompt();
      input.prompt[key] = name;
      assert.throws(() => authorizeFileWindowFetch(entry(), access, url("sessions/ses/runs/start"), post(input)));
    }
  }
  for (const id of ["team/reviewer", "with space", "with\\slash", "with?query", "with#hash"]) {
    const input = prompt();
    input.prompt.messageID = id;
    assert.throws(() => authorizeFileWindowFetch(entry(), access, url("sessions/ses/runs/start"), post(input)));
    assert.throws(() => authorizeFileWindowFetch({ ...entry(), sessionId: id }, access, url(`sessions/${encodeURIComponent(id)}/snapshot`)));
    assert.throws(() => authorizeFileWindowFetch(entry(), access, url(`sessions/ses/runs/${encodeURIComponent(id)}/abort`), post({ abortCommandCorrelationId: null })));
  }
});

async function httpFixture(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { baseUrl: `http://127.0.0.1:${address.port}`, async close() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  } };
}

test("trusted policy supply preserves restrictions, accepts explicit no-policy, and fails closed without a cache", async () => {
  let source;
  /** @type {unknown} */
  let result = { allowCustomProviders: false, allowedModels: ["provider/model"], clientToken: "secret" };
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, executeJavaScript: async (script) => { source = script; return result; } } };
  const config = await readFileWindowDesktopConfig(window, { baseUrl: "https://work.example/" });
  assert.deepEqual(config, { allowCustomProviders: false, allowedModels: ["provider/model"] });
  assert.match(source, /jugglework.den.desktopConfig:https:\/\/work.example::/);
  assert.doesNotMatch(source, /authToken/);
  result = {};
  assert.deepEqual(await readFileWindowDesktopConfig(window, { baseUrl: "https://work.example" }), {});
  result = null;
  assert.equal(await readFileWindowDesktopConfig(window, { baseUrl: "https://work.example" }), null);
});

// Execute only Den's pure URL helpers as the compatibility oracle. Main never
// imports App modules, and the test does not initialize App settings/storage.
function appDenBaseUrlResolver() {
  const source = readFileSync(new URL("../../app/src/app/lib/den.ts", import.meta.url), "utf8");
  const declarations = ["DEN_CONTROL_PLANE_PATH", "DEN_API_BASE_PATH", "LEGACY_DEN_API_BASE_PATH"].map((name) => {
    const line = source.match(new RegExp(`(?:export )?const ${name} = [^\\n]+`));
    assert.ok(line, name);
    return line[0].replace(/^export /, "");
  });
  const helpers = ["normalizeDenBaseUrl", "stripDenApiBasePath", "ensureDenApiBasePath", "resolveDenBaseUrls"].map((name) => {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, name);
    const end = source.indexOf("\n}", start);
    assert.notEqual(end, -1, name);
    return source.slice(start, end + 2);
  });
  const { transpileModule } = createRequire(new URL("../../server/package.json", import.meta.url))("typescript");
  const { outputText } = transpileModule([...declarations, 'const DEFAULT_DEN_BASE_URL = "https://fallback.example";', ...helpers, "resolveDenBaseUrls;"].join("\n"), {});
  return vm.runInNewContext(outputText, { URL });
}

const resolveAppDenBaseUrls = appDenBaseUrlResolver();
for (const prefix of ["", "/deployment/nested", "/deployment/jwork"]) {
  for (const suffix of ["", "/", "/jwork", "/jwork/", "/jwork/api", "/jwork/api///", "/api/den", "/JWORK", "/JWORK/API", "/API/DEN"]) {
    const baseUrl = `https://work.example${prefix}${suffix}`;
    test(`policy cache normalization matches App Den rules: ${baseUrl}`, async () => {
      const { baseUrl: cacheBase } = resolveAppDenBaseUrls(baseUrl);
      const policy = { allowCustomProviders: false, allowedModels: ["provider/model"] };
      const storage = new Map([
        ["jugglework.den.activeOrgId", "org-current"],
        [`jugglework.den.desktopConfig:${cacheBase}::org-current`, JSON.stringify(policy)],
        [`jugglework.den.desktopConfig:${cacheBase}::org-other`, "{}"],
      ]);
      const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false,
        executeJavaScript: async (script) => vm.runInNewContext(script, { localStorage: { getItem: (key) => storage.get(key) ?? null } }),
      } };
      assert.deepEqual(await readFileWindowDesktopConfig(window, { baseUrl }), policy);
      storage.delete(`jugglework.den.desktopConfig:${cacheBase}::org-current`);
      assert.equal(await readFileWindowDesktopConfig(window, { baseUrl }), null);
    });
  }
}

test("finite App route allowlist rejects foreign context, extra headers/queries, shell, media, commands and forged Office refs", () => {
  const e = entry();
  for (const route of ["sessions/ses", "sessions/ses/snapshot?limit=100", "sessions/ses/messages", "session-runs", "sessions/ses/permission-mode", "sessions/ses/interactions/snapshot?includeDescendants=true", "opencode/provider?directory=%2Fproject", "opencode/agent"]) {
    authorizeFileWindowFetch(e, access, url(route));
  }
  authorizeFileWindowFetch(e, access, url("sessions/ses/runs/start"), post(prompt()));
  /** @type {Array<[string, object]>} */
  const cases = [
    [url("sessions/foreign/snapshot"), {}], [url("sessions/ses/snapshot?directory=/other"), {}],
    [url("sessions/ses/messages?limit=1&limit=2"), {}], [url("opencode/provider?workspace=other"), {}],
    [url("opencode/provider?wrong=%2Fproject"), {}], [url("opencode/provider"), { headers: { "x-opencode-directory": "/other" } }],
    [url("opencode/config"), {}], [url("opencode/event"), {}], [url("opencode/session/ses/shell"), post({ command: "ls" })],
    [url("sessions/ses/permission-mode"), post({ mode: "auto" })], [url("sessions/ses/fork"), post({})],
    [url("sessions/ses/runs/start"), post({ ...prompt(), origin: "remote-control" })],
    [url("sessions/ses/runs/start"), post({ ...prompt(), whenBusy: "steer" })],
  ];
  for (const extra of [{ tools: { shell: true } }, { command: "ls" }, { officeSelectionRefs: ["forged"] }, { officeInstructions: [{ selectionRef: "forged" }] },
    { parts: [{ type: "file", url: "data:image/png;base64,a" }] }, { parts: [{ type: "agent", name: "agent" }] }, { parts: [{ type: "subtask", prompt: "hi" }] }]) {
    cases.push([url("sessions/ses/runs/start"), post({ ...prompt(), prompt: { ...prompt().prompt, ...extra } })]);
  }
  for (const [target, init] of cases) assert.throws(() => authorizeFileWindowFetch(e, access, target, init));
  assert.equal(authorizeFileWindowFetch({ ...e, local: true }, access, url("sessions/ses/snapshot"), {}).conversation.kind, "snapshot");
  for (const context of [{ ...e, conversation: undefined }, { ...e, local: true, conversation: undefined }, { ...e, workspaceId: "rem_remote" }])
    assert.throws(() => authorizeFileWindowFetch(context, access, url("sessions/ses/snapshot")));
});

test("real HTTP mutation ownership checks reject cross-session runs and permission/question IDs before POST", async () => {
  let mutations = 0;
  let foreign = true;
  const http = await httpFixture((request, response) => {
    response.setHeader("content-type", "application/json");
    assert.equal(request.headers.authorization, "Bearer main-secret");
    if (request.method === "POST") {
      mutations++;
      response.end(JSON.stringify(request.url.includes("/runs/") ? { run: own } : { interactionId: request.url.includes("/question/") ? "question" : "permission", status: "resolved" }));
    } else if (request.url.endsWith("/session-runs")) response.end(JSON.stringify({ items: [{ ...own, ...(foreign ? { sessionId: "other" } : {}) }] }));
    else response.end(JSON.stringify({ item: { rootSessionId: "ses", includeDescendants: true, permissions: [{ ...interaction, ...(foreign ? { sessionID: "other", targetSessionId: "other" } : {}) }],
      questions: [{ ...interaction, id: "question", ...(foreign ? { sessionID: "other", targetSessionId: "other" } : {}) }] } }));
  });
  try {
    const routes = [
      ["sessions/ses/runs/run/abort", { abortCommandCorrelationId: null }],
      ["sessions/ses/interactions/permission/permission/reply", { origin: "local-renderer", commandCorrelationId: null, response: "allow_once" }],
      ["sessions/ses/interactions/question/question/reply", { origin: "local-renderer", commandCorrelationId: null, answers: [{ questionId: "q", values: ["yes"] }] }],
    ];
    for (const [route, body] of routes) await assert.rejects(fetchFileWindowResponse(entry(), { ...access, baseUrl: http.baseUrl }, `${http.baseUrl}/workspace/ws/${route}`, post(body), fetch));
    assert.equal(mutations, 0);
    foreign = false;
    for (const [route, body] of routes) assert.equal((await fetchFileWindowResponse(entry(), { ...access, baseUrl: http.baseUrl }, `${http.baseUrl}/workspace/ws/${route}`, post(body), fetch)).status, 200);
    assert.equal(mutations, 3);
  } finally { await http.close(); }
});

test("response projection filters runs/interactions and strips provider/agent credentials and error headers", async () => {
  const call = async (route, value, options) => {
    const response = await fetchFileWindowResponse(entry(), access, url(route), {}, async () => Response.json(value, options));
    const text = Buffer.from(response.body).toString();
    assert.doesNotMatch(JSON.stringify(response), /provider-secret|header-secret/);
    assert.doesNotMatch(text, /provider-secret|header-secret|foreign/);
    return JSON.parse(text);
  };
  assert.deepEqual(await call("session-runs", { items: [own, { ...own, sessionId: "foreign" }] }), { items: [own] });
  const interactions = await call("sessions/ses/interactions/snapshot?includeDescendants=true", { item: { rootSessionId: "ses", includeDescendants: true, permissions: [interaction, { ...interaction, sessionID: "foreign" }], questions: [] } });
  assert.equal(interactions.item.permissions.length, 1);
  assert.equal(interactions.item.includeDescendants, true);
  const providers = await call("opencode/provider", { all: [{ id: "provider", name: "Provider", key: "provider-secret", options: { apiKey: "provider-secret" }, models: { model: { id: "model", name: "Model", api: { url: "https://provider-secret" }, headers: { Authorization: "provider-secret" }, variants: { high: { unknownCredential: "provider-secret" } } } } }], connected: ["provider"], default: {} });
  assert.deepEqual(providers.all[0].models.model.variants, { high: {} });
  assert.deepEqual(await call("opencode/agent", [{ name: "build", mode: "primary", prompt: "provider-secret", options: { secret: "provider-secret" } }]), [{ name: "build", mode: "primary" }]);
  await call("sessions/ses/snapshot", { message: "provider-secret", code: "provider_failed" }, { status: 502, headers: { "x-debug": "header-secret" } });
  await assert.rejects(fetchFileWindowResponse(entry(), access, url("sessions/ses/snapshot"), {}, async () => Response.json({ item: { session: { id: "foreign" }, messages: [] } })));
  await assert.rejects(fetchFileWindowResponse(entry(), access, url("opencode/provider"), {}, async () => new Response("provider-secret invalid JSON")), (error) => !String(error).includes("provider-secret"));
});

test("real HTTP snapshot/messages/start preserve existing contracts and force busy rejection", async () => {
  const message = { info: { id: "message", sessionID: "ses", role: "user" }, parts: [{ id: "part", sessionID: "ses", type: "text", text: "hello" }] };
  /** @type {any} */
  let started;
  const http = await httpFixture(async (request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("x-provider-secret", "private");
    if (request.url.endsWith("/opencode/provider")) { response.end(JSON.stringify(providers("provider", "api", ["vendor/model"]))); return; }
    if (request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      started = JSON.parse(Buffer.concat(chunks).toString());
      response.end(JSON.stringify({ disposition: "started", run: own }));
    } else response.end(JSON.stringify(request.url.endsWith("/messages") ? { items: [message] }
      : { item: { session: { id: "ses" }, messages: [message], todos: [], status: { type: "idle" } } }));
  });
  try {
    for (const route of ["snapshot", "messages"]) {
      const result = await fetchFileWindowResponse(entry(), { ...access, baseUrl: http.baseUrl }, `${http.baseUrl}/workspace/ws/sessions/ses/${route}`, {}, fetch);
      const value = JSON.parse(Buffer.from(result.body).toString());
      assert.deepEqual(route === "snapshot" ? value.item.messages : value.items, [message]);
      assert.deepEqual(result.headers, [["content-type", "application/json"]]);
    }
    const input = prompt();
    const seed = validateFileWindowConversationOptions({ model: { providerID: "provider", modelID: "vendor/model" }, agent: "team/reviewer", variant: "high effort" });
    Object.assign(input.prompt, seed);
    const result = await fetchFileWindowResponse(entry(), { ...access, baseUrl: http.baseUrl }, `${http.baseUrl}/workspace/ws/sessions/ses/runs/start`, post(input), fetch);
    assert.equal(JSON.parse(Buffer.from(result.body).toString()).disposition, "started");
    assert.equal(started.whenBusy, "reject");
    assert.equal(started.origin, "local-renderer");
    assert.equal(started.prompt.model.modelID, "vendor/model");
    assert.equal(started.prompt.agent, seed.agent);
    assert.equal(started.prompt.variant, seed.variant);
  } finally { await http.close(); }
});

test("Main model policy shares App rules and uses live availability/source on every start", async () => {
  const e = entry();
  e.conversation.desktopConfig = { allowedModels: ["provider/model"], allowCustomProviders: false, allowZenModel: false };
  const model = { providerID: "provider", modelID: "model" };
  authorizeConversationModel(e, model, providers());
  for (const [choice, catalog] of [
    [undefined, providers()], [model, { ...providers(), connected: [] }],
    [{ ...model, modelID: "missing" }, providers()], [model, providers("provider", "config")],
    [{ providerID: "opencode", modelID: "model" }, providers("opencode", "config")],
  ]) assert.throws(() => authorizeConversationModel(e, choice, catalog));
  e.conversation.desktopConfig = { allowedModels: ["unrelated/model"], allowCustomProviders: true };
  authorizeConversationModel(e, model, providers("provider", "config"));
  assert.throws(() => authorizeConversationModel(e, model, providers("provider", "api")));
  for (const id of ["jugglework", "lpr_org"]) authorizeConversationModel(e, { ...model, providerID: id }, providers(id, "config"));

  let posts = 0;
  let reads = 0;
  let source = "api";
  e.conversation.desktopConfig = { allowedModels: ["provider/model"], allowCustomProviders: false };
  const fetcher = async (target, init) => {
    if (init.method === "GET") { reads++; assert.match(target, /\/opencode\/provider$/); return Response.json(providers("provider", source)); }
    posts++; return Response.json({ run: own });
  };
  await fetchFileWindowResponse(e, access, url("sessions/ses/runs/start"), post(prompt()), fetcher);
  source = "config";
  await assert.rejects(fetchFileWindowResponse(e, access, url("sessions/ses/runs/start"), post(prompt()), fetcher));
  assert.equal(reads, 2); assert.equal(posts, 1);
});

test("descendant replies require a fresh owned snapshot and SSE trusts only its verified paths", async () => {
  const e = entry();
  const child = { ...interaction, sessionID: "child", targetSessionId: "child", parentSessionId: "ses", ancestryPath: ["ses", "child"] };
  const event = { type: "permission.v2.asked", properties: { id: "permission", sessionID: "child", rootSessionId: "ses", ancestryPath: ["ses", "child"], parentSessionId: "ses" } };
  assert.equal(fileWindowSessionEvent(e, event), null);
  let valid = true;
  let posts = 0;
  const fetcher = async (target, init) => {
    if (init.method === "GET") {
      assert.match(target, /\/sessions\/ses\/interactions\/snapshot\?includeDescendants=true$/);
      return Response.json({ item: { rootSessionId: "ses", includeDescendants: true, permissions: [{ ...child, ...(valid ? {} : { ancestryPath: ["foreign", "child"] }) }], questions: [] } });
    }
    assert.match(target, /\/sessions\/child\/interactions\/permission\/permission\/reply$/);
    posts++; return Response.json({ interactionId: "permission", status: "resolved" });
  };
  const target = url("sessions/child/interactions/permission/permission/reply");
  const body = post({ origin: "local-renderer", commandCorrelationId: null, response: "allow_once" });
  await fetchFileWindowResponse(e, access, target, body, fetcher);
  assert.ok(fileWindowSessionEvent(e, event));
  assert.equal(fileWindowSessionEvent(e, { ...event, properties: { ...event.properties, targetSessionId: "other" } }), null);
  assert.equal(fileWindowSessionEvent(e, { ...event, properties: { ...event.properties, rootSessionId: "other" } }), null);
  valid = false;
  await assert.rejects(fetchFileWindowResponse(e, access, target, body, fetcher));
  assert.equal(posts, 1);
  assert.equal(fileWindowSessionEvent(e, event), null);

  for (const forged of [
    { rootSessionId: "other" }, { targetSessionId: "other" }, { sessionID: "other" },
    { parentSessionId: "other" }, { ancestryPath: ["ses", "child", "child"] }, { ancestryPath: ["child"] },
  ]) {
    const value = projectConversationResponse(e, { kind: "interactions" }, { item: { rootSessionId: "ses", includeDescendants: true, permissions: [{ ...child, ...forged }], questions: [] } });
    assert.deepEqual(value.item.permissions, []);
  }
  projectConversationResponse(e, { kind: "interactions" }, { item: { rootSessionId: "ses", includeDescendants: true, permissions: [child], questions: [] } });
  assert.ok(fileWindowSessionEvent(e, event));
  await fetchFileWindowResponse(e, access, url("sessions/ses/interactions/snapshot"), {}, async () => Response.json({ code: "snapshot_unavailable" }, { status: 503 }));
  assert.equal(fileWindowSessionEvent(e, event), null);
});

test("question body IDs accept Server spaces and punctuation without permitting controls or oversized IDs", () => {
  const reply = (questionId) => post({ origin: "local-renderer", commandCorrelationId: null, answers: [{ questionId, values: ["yes"] }] });
  const target = url("sessions/ses/interactions/question/question/reply");
  for (const id of ["question with spaces", "Question / A? #1", "q".repeat(256)]) authorizeFileWindowFetch(entry(), access, target, reply(id));
  for (const id of ["", " ", "q".repeat(257), "a\nb", "a\u0000b", "a\u007fb"]) assert.throws(() => authorizeFileWindowFetch(entry(), access, target, reply(id)));
});

test("real HTTP workspace SSE forwards only bound existing Events and abort closes the connection", { timeout: 5000 }, async () => {
  let closed;
  const connectionClosed = new Promise((resolve) => { closed = resolve; });
  const messages = [
    { type: "server.connected", properties: { secret: "provider-secret" } },
    { type: "provider.updated", properties: { sessionID: "ses", secret: "provider-secret" } },
    { type: "message.part.delta", properties: { sessionID: "foreign", delta: "foreign" } },
    { type: "session.updated", properties: { info: { id: "ses", title: "Bound" } } },
    { type: "permission.v2.asked", properties: { id: "p", sessionID: "ses", headers: { Authorization: "provider-secret" } } },
    { type: "message.part.delta", properties: { sessionID: "ses", info: { sessionID: "foreign" }, delta: "foreign" } },
    { type: "server.heartbeat", properties: {} },
    { type: "message.part.delta", properties: { sessionID: "ses", delta: "hello" } },
  ];
  const http = await httpFixture((request, response) => {
    assert.equal(request.url, "/workspace/ws/opencode/event");
    assert.equal(request.headers.authorization, "Bearer main-secret");
    response.writeHead(200, { "content-type": "text/event-stream" });
    const text = messages.map((payload) => `data: ${JSON.stringify({ directory: "/project", payload })}\r\n\r\n`).join("");
    response.write(text.slice(0, 39));
    response.write(text.slice(39));
    response.on("close", () => closed());
  });
  const controller = new AbortController();
  const events = [];
  try {
    const client = createManagedRuntimeSseClient({ getAccess: () => ({ ...access, baseUrl: http.baseUrl }) });
    await client.subscribe({ workspaceId: "ws", signal: controller.signal, onReconnectGap: () => {}, onEvent: (raw) => {
      const event = fileWindowSessionEvent(entry(), raw);
      if (event) events.push(event);
      if (event?.type === "message.part.delta") controller.abort();
    } });
    await connectionClosed;
    assert.deepEqual(events.map((event) => event.type), ["server.connected", "session.updated", "permission.v2.asked", "server.heartbeat", "message.part.delta"]);
    assert.equal(events.at(-1).properties.delta, "hello");
    assert.doesNotMatch(JSON.stringify(events), /foreign|provider-secret/);
  } finally { controller.abort(); await http.close(); }
});

test("SSE frame limits, stalled readers and redirects cancel without following other URLs", { timeout: 5000 }, async () => {
  let targetHits = 0;
  const http = await httpFixture((request, response) => {
    if (request.url === "/forbidden") { targetHits++; response.end(); return; }
    response.writeHead(302, { location: "/forbidden" }); response.end();
  });
  try {
    const client = createManagedRuntimeSseClient({ getAccess: () => ({ ...access, baseUrl: http.baseUrl }) });
    await assert.rejects(client.subscribe({ workspaceId: "ws", signal: new AbortController().signal, onReconnectGap: () => {}, onEvent: () => {} }), /subscription failed/);
    assert.equal(targetHits, 0);
  } finally { await http.close(); }
  for (const oversized of [true, false]) {
    const controller = new AbortController();
    let cancelled = false;
    const client = createManagedRuntimeSseClient({ getAccess: () => access, maxBufferBytes: 64, inactivityMs: 10,
      fetcher: async () => new Response(new ReadableStream({ start(stream) { if (oversized) stream.enqueue(new TextEncoder().encode(`data: ${"x".repeat(65)}`)); }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }),
    });
    const task = client.subscribe({ workspaceId: "ws", signal: controller.signal, onReconnectGap: () => controller.abort(), onEvent: () => {} });
    if (oversized) await assert.rejects(task);
    else { setTimeout(() => controller.abort(), 30); await task; }
    assert.equal(cancelled, true);
  }
});
