import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AUTOMATION_DEFAULT_PERMISSION_PROFILE, AUTOMATION_PERMISSION_PROFILE } from "@jugglework/types/automation";
import type { ServerConfig } from "../types.js";
import { AutomationRepository } from "./repository.js";
import { registerAutomationRoutes } from "../routes/automations.js";
import { matchRoute, type RequestContext, type Route } from "../routes/registry.js";
import { GithubEventAuthStore } from "./github-event-auth-store.js";

test("automation routes support local-first CRUD, manual run and history", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-automation-routes-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  await writeFile(join(workspacePath, ".keep"), "");
  const routeConfig = config(root, workspacePath);
  const repository = await AutomationRepository.open(routeConfig);
  const routes: Route[] = [];
  registerAutomationRoutes({
    routes,
    config: routeConfig,
    repository,
    jsonResponse: (data, status = 200) => Response.json(data, { status }),
    readJsonBody: async (request) => await request.json() as Record<string, unknown>,
    ensureWritable: () => undefined,
    requireClientScope: () => undefined,
  });
  const invoke = async (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://localhost${path}`);
    const route = matchRoute(routes, method, url.pathname);
    assert.ok(route);
    const request = new Request(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return route.handler({ request, url, params: route.params, config: routeConfig } as RequestContext);
  };
  const now = Date.now();
  const localDate = new Date(now + 86_400_000).toISOString().slice(0, 10);
  try {
    // TIPS:/automations/preview 是独立的"预览调度下一次执行时间"端点，只服务定时触发，
    // 请求体字段名仍是 schedule，不随 AutomationDraft.trigger 的改名而改——事件触发没有
    // "下一次执行时间"的概念，不适用这个端点。
    const preview = await invoke("POST", "/automations/preview", {
      schedule: { version: 1, kind: "once", localDate, localTime: "23:59", timezone: "UTC" },
      locale: "zh-CN",
    });
    assert.equal(preview.status, 200);
    assert.equal(typeof ((await preview.json()) as { nextRunAt: number }).nextRunAt, "number");

    const create = await invoke("POST", "/automations", {
        name: "自动化路由测试",
        workspace: { id: "workspace-1", name: "工作空间", path: workspacePath, workspaceType: "local" },
        prompt: { version: 1, parts: [{ type: "text", text: "执行测试" }] },
        timezone: "UTC",
        trigger: { version: 1, kind: "once", localDate, localTime: "23:59", timezone: "UTC" },
        model: { mode: "auto" },
        skillIds: [],
        connectors: [],
        permission: { profile: AUTOMATION_PERMISSION_PROFILE, acknowledgedAt: now },
        lifecycle: "enabled",
        executorDeviceId: "device-1",
    });
    assert.equal(create.status, 201);
    const created = await create.json() as { item: { definition: { id: string; revision: number } } };

    const list = await invoke("GET", "/automations");
    assert.equal(list.status, 200);
    assert.equal(((await list.json()) as { items: unknown[] }).items.length, 1);

    const pause = await invoke("POST", `/automations/${created.item.definition.id}/pause`, {
      baseRevision: created.item.definition.revision,
    });
    assert.equal(pause.status, 200);
    const paused = await pause.json() as { item: { definition: { revision: number } } };

    const manual = await invoke("POST", `/automations/${created.item.definition.id}/run`, {});
    assert.equal(manual.status, 201);
    assert.equal(((await manual.json()) as { item: { triggerSource: string; state: string } }).item.triggerSource, "manual");
    // 重复点击「立即执行」必须被 one-active-run-per-task 拦住，界面据此提示「正在执行中」。
    await assert.rejects(
      invoke("POST", `/automations/${created.item.definition.id}/run`, {}),
      (error: unknown) => (error as { status: number; code: string }).status === 409
        && (error as { code: string }).code === "overlap_blocked",
    );
    const history = await invoke("GET", "/automation-runs?trigger=manual");
    assert.equal(history.status, 200);
    assert.equal(((await history.json()) as { items: unknown[] }).items.length, 1);

    const remove = await invoke("DELETE", `/automations/${created.item.definition.id}`, {
      baseRevision: paused.item.definition.revision,
    });
    assert.equal(remove.status, 200);
    const afterDelete = await invoke("GET", "/automations");
    assert.deepEqual((await afterDelete.json() as { items: unknown[] }).items, []);
  } finally {
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

function config(root: string, workspacePath: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "test-token",
    hostToken: "host-token",
    configPath: join(root, "config.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: [],
    workspaces: [{ id: "workspace-1", name: "工作空间", path: workspacePath, preset: "default", workspaceType: "local" }],
    authorizedRoots: [workspacePath],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  };
}

test("dependency lookup falls back to the first local workspace when none is selected", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-automation-deps-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  await writeFile(join(workspacePath, ".keep"), "");
  const routeConfig = config(root, workspacePath);
  const repository = await AutomationRepository.open(routeConfig);
  const routes: Route[] = [];
  const resolved: string[] = [];
  registerAutomationRoutes({
    routes,
    config: routeConfig,
    repository,
    jsonResponse: (data, status = 200) => Response.json(data, { status }),
    readJsonBody: async (request) => await request.json() as Record<string, unknown>,
    ensureWritable: () => undefined,
    requireClientScope: () => undefined,
    resolveWorkspace: async (_config, id) => {
      resolved.push(id);
      return { id, name: "工作空间", path: workspacePath, preset: "default", workspaceType: "local" };
    },
    createWorkspaceOpencodeClient: () => ({
      provider: {
        list: async () => ({
          data: {
            all: [
              { id: "openai", name: "OpenAI", source: "api", models: { "gpt-5": { id: "gpt-5", name: "GPT-5" } } },
              // 未连接的 provider（models.dev 全量目录里的条目）不能出现在可选模型里。
              { id: "mistral", name: "Mistral", source: "api", models: { "mistral-large": { id: "mistral-large", name: "Mistral Large" } } },
              // 已连接但没有模型的自定义 provider 同样排除，与会话输入栏口径一致。
              { id: "my-proxy", name: "Proxy", source: "custom", models: {} },
            ],
            connected: ["openai", "my-proxy"],
          },
        }),
      },
      app: {
        agents: async () => ({ data: [
          { name: "build", description: "", mode: "primary" },
          { name: "plan", description: "", mode: "primary" },
          { name: "jugglework", description: "", mode: "primary" },
          { name: "explore", description: "", mode: "subagent" },
          { name: "secret", description: "", mode: "primary", hidden: true },
        ] }),
        skills: async () => ({ data: [{ name: "prd-writer", description: "PRD" }] }),
      },
    }) as never,
    listWorkspaceMcp: async () => [{ name: "lark", config: {}, source: "config.global" }],
  });
  const invoke = async (path: string) => {
    const url = new URL(`http://localhost${path}`);
    const route = matchRoute(routes, "GET", url.pathname);
    assert.ok(route);
    return route.handler({ request: new Request(url), url, params: route.params, config: routeConfig } as RequestContext);
  };
  try {
    const response = await invoke("/automations/dependencies");
    assert.equal(response.status, 200);
    const body = await response.json() as {
      models: Array<{ modelId: string; providerName: string }>;
      agents: Array<{ id: string }>;
      skills: Array<{ id: string }>;
      connectors: Array<{ id: string; ready: boolean }>;
    };
    // 没传 workspaceId 时回落到配置里的第一个本机工作空间，四类依赖都要有值。
    assert.deepEqual(resolved, ["workspace-1"]);
    // 只保留 engine 报告为已连接、且确有模型的 provider。
    assert.deepEqual(body.models.map((model) => model.modelId), ["gpt-5"]);
    assert.deepEqual(body.models.map((model) => model.providerName), ["OpenAI"]);
    // 与会话输入栏一致：隐藏项、子智能体和内置默认智能体都不出现在可选项里。
    assert.deepEqual(body.agents.map((agent) => agent.id), ["build", "plan"]);
    assert.deepEqual(body.skills.map((skill) => skill.id), ["prd-writer"]);
    assert.deepEqual(body.connectors, [{ id: "lark", label: "lark", ready: true }]);
  } finally {
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive default permission profile is accepted and preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-automation-permission-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  await writeFile(join(workspacePath, ".keep"), "");
  const routeConfig = config(root, workspacePath);
  const repository = await AutomationRepository.open(routeConfig);
  const routes: Route[] = [];
  registerAutomationRoutes({
    routes,
    config: routeConfig,
    repository,
    jsonResponse: (data, status = 200) => Response.json(data, { status }),
    readJsonBody: async (request) => await request.json() as Record<string, unknown>,
    ensureWritable: () => undefined,
    requireClientScope: () => undefined,
  });
  const invoke = async (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://localhost${path}`);
    const route = matchRoute(routes, method, url.pathname);
    assert.ok(route);
    return route.handler({
      request: new Request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }),
      url,
      params: route.params,
      config: routeConfig,
    } as RequestContext);
  };
  const now = Date.now();
  const localDate = new Date(now + 86_400_000).toISOString().slice(0, 10);
  try {
    const create = await invoke("POST", "/automations", {
      name: "默认权限任务",
      workspace: { id: "workspace-1", name: "工作空间", path: workspacePath, workspaceType: "local" },
      prompt: { version: 1, parts: [{ type: "text", text: "执行测试" }] },
      timezone: "UTC",
      trigger: { version: 1, kind: "once", localDate, localTime: "23:59", timezone: "UTC" },
      model: { mode: "auto" },
      skillIds: [],
      connectors: [],
      permission: { profile: AUTOMATION_DEFAULT_PERMISSION_PROFILE, acknowledgedAt: now },
      lifecycle: "enabled",
      executorDeviceId: "device-1",
    });
    assert.equal(create.status, 201);
    const created = await create.json() as { item: { definition: { id: string; permission: { profile: string } } } };
    assert.equal(created.item.definition.permission.profile, AUTOMATION_DEFAULT_PERMISSION_PROFILE);
    // 默认权限的任务同样可以手动触发，权限模式不影响可运行性判定。
    const manual = await invoke("POST", `/automations/${created.item.definition.id}/run`, {});
    assert.equal(manual.status, 201);
  } finally {
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

// TIPS: 这是 resolveAuth 的真实生产落点——渲染进程登录后把云端 session + 设备 agent
// token 推给这个进程，见 routes/automations.ts 的 PUT /automations/github-event-auth。
test("github-event-auth push/clear routes write through to the shared store, gated behind mutation scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-automation-github-event-auth-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  await writeFile(join(workspacePath, ".keep"), "");
  const routeConfig = config(root, workspacePath);
  const repository = await AutomationRepository.open(routeConfig);
  const routes: Route[] = [];
  const authStore = new GithubEventAuthStore();
  const scopeChecks: string[] = [];
  registerAutomationRoutes({
    routes,
    config: routeConfig,
    repository,
    jsonResponse: (data, status = 200) => Response.json(data, { status }),
    readJsonBody: async (request) => await request.json() as Record<string, unknown>,
    ensureWritable: () => undefined,
    requireClientScope: (_ctx, required) => { scopeChecks.push(required); },
    githubEventAuthStore: authStore,
  });
  const invoke = async (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://localhost${path}`);
    const route = matchRoute(routes, method, url.pathname);
    assert.ok(route, `no route registered for ${method} ${path}`);
    const request = new Request(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return route.handler({ request, url, params: route.params, config: routeConfig } as RequestContext);
  };
  try {
    assert.equal(authStore.get(), null);

    await assert.rejects(
      () => invoke("PUT", "/automations/github-event-auth", { baseUrl: "https://cloud.example.com" }),
      (error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === "invalid_request",
    );
    assert.equal(authStore.get(), null);

    const first = await invoke("PUT", "/automations/github-event-auth", { baseUrl: "https://cloud.example.com", token: "tok" });
    assert.equal(first.status, 200);
    assert.deepEqual(authStore.get(), { baseUrl: "https://cloud.example.com", token: "tok" });

    // A second push (e.g. account switch) must overwrite, not merge with, the first.
    const second = await invoke("PUT", "/automations/github-event-auth", { baseUrl: "https://cloud.example.com", token: "tok2" });
    assert.equal(second.status, 200);
    assert.deepEqual(authStore.get(), { baseUrl: "https://cloud.example.com", token: "tok2" });

    const cleared = await invoke("DELETE", "/automations/github-event-auth");
    assert.equal(cleared.status, 200);
    assert.equal(authStore.get(), null);

    // TIPS: PUT 和 DELETE 都是写操作，必须走跟其它自动化写接口相同的 collaborator 门槛
    // （requireMutation），不能因为这是"推凭据"这个特殊用途就绕开权限检查。
    assert.ok(scopeChecks.length >= 3);
    assert.ok(scopeChecks.every((scope) => scope === "collaborator"));
  } finally {
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

// TIPS: 没传 githubEventAuthStore 时，这两个路径不是"匹配不到路由"——`PUT
// /automations/:automationId` 这条既有的通用 CRUD 路由本来就会吃掉任何
// `/automations/<任意字符串>`，把 "github-event-auth" 当成一个 automationId。这里要验证
// 的是一条安全边界：落到那条通用路由之后，因为这个 ID 对应不到任何真实自动化，会正常走
// 它自己的 404，不会有任何跟凭据相关的特殊行为——不是没人处理这个请求，而是被安全地当成
// "一个不存在的自动化"处理掉了。DELETE 没有对应的通用路由，才是真正意义上的匹配不到。
test("without a store, the path falls through to the generic automation-not-found handler, not a credential endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-automation-github-event-auth-absent-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  await writeFile(join(workspacePath, ".keep"), "");
  const routeConfig = config(root, workspacePath);
  const repository = await AutomationRepository.open(routeConfig);
  const routes: Route[] = [];
  registerAutomationRoutes({
    routes,
    config: routeConfig,
    repository,
    jsonResponse: (data, status = 200) => Response.json(data, { status }),
    readJsonBody: async (request) => await request.json() as Record<string, unknown>,
    ensureWritable: () => undefined,
    requireClientScope: () => undefined,
    // githubEventAuthStore intentionally omitted
  });
  try {
    const isAutomationNotFound = (error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === "automation_not_found";

    const putRoute = matchRoute(routes, "PUT", "/automations/github-event-auth");
    assert.ok(putRoute);
    const putRequest = new Request("http://localhost/automations/github-event-auth", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision: 1, draft: {} }),
    });
    await assert.rejects(
      () => putRoute.handler({ request: putRequest, url: new URL(putRequest.url), params: putRoute.params, config: routeConfig } as RequestContext),
      isAutomationNotFound,
    );

    const deleteRoute = matchRoute(routes, "DELETE", "/automations/github-event-auth");
    assert.ok(deleteRoute);
    const deleteRequest = new Request("http://localhost/automations/github-event-auth", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision: 1 }),
    });
    await assert.rejects(
      () => deleteRoute.handler({ request: deleteRequest, url: new URL(deleteRequest.url), params: deleteRoute.params, config: routeConfig } as RequestContext),
      isAutomationNotFound,
    );
  } finally {
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

// TIPS: 这条覆盖的是渲染进程收到 jugglework-server 那条 IM 唤醒推送后，真正会打的那个
// 端点——它本身不带请求体，唯一要验证的是"确实转发给了 poller.pollNow()"和"权限门槛
// 跟其它写接口一致"。
test("github-event-poll-now route forwards to the poller, gated behind mutation scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-automation-poll-now-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  await writeFile(join(workspacePath, ".keep"), "");
  const routeConfig = config(root, workspacePath);
  const repository = await AutomationRepository.open(routeConfig);
  const routes: Route[] = [];
  const pollNowCalls: number[] = [];
  const scopeChecks: string[] = [];
  registerAutomationRoutes({
    routes,
    config: routeConfig,
    repository,
    jsonResponse: (data, status = 200) => Response.json(data, { status }),
    readJsonBody: async (request) => await request.json() as Record<string, unknown>,
    ensureWritable: () => undefined,
    requireClientScope: (_ctx, required) => { scopeChecks.push(required); },
    githubEventPoller: { pollNow: () => { pollNowCalls.push(Date.now()); } },
  });
  try {
    const route = matchRoute(routes, "POST", "/automations/github-event-poll-now");
    assert.ok(route);
    const request = new Request("http://localhost/automations/github-event-poll-now", { method: "POST" });
    const response = await route.handler({ request, url: new URL(request.url), params: route.params, config: routeConfig } as RequestContext);
    assert.equal(response.status, 200);
    assert.equal(pollNowCalls.length, 1);
    // TIPS: 跟 github-event-auth 那两个写接口一样，走 requireMutation（collaborator 门槛），
    // 不能因为这条只是"发个信号"就绕开权限检查。
    assert.ok(scopeChecks.length >= 1);
    assert.ok(scopeChecks.every((scope) => scope === "collaborator"));
  } finally {
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("without a poller configured, github-event-poll-now has no route at all", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-automation-poll-now-absent-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  await writeFile(join(workspacePath, ".keep"), "");
  const routeConfig = config(root, workspacePath);
  const repository = await AutomationRepository.open(routeConfig);
  const routes: Route[] = [];
  registerAutomationRoutes({
    routes,
    config: routeConfig,
    repository,
    jsonResponse: (data, status = 200) => Response.json(data, { status }),
    readJsonBody: async (request) => await request.json() as Record<string, unknown>,
    ensureWritable: () => undefined,
    requireClientScope: () => undefined,
    // githubEventPoller intentionally omitted
  });
  try {
    // TIPS: 跟 github-event-auth 那条不一样——没有任何通用 POST 路由会吃掉
    // /automations/github-event-poll-now 这个路径（既有的通配路由都要求 /:automationId 后面
    // 跟一个具体动作，比如 /run、/pause），所以这里是真正意义上的"匹配不到路由"，不是落到
    // 别的处理器上。
    assert.equal(matchRoute(routes, "POST", "/automations/github-event-poll-now"), null);
  } finally {
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
});
