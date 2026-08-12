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
        schedule: { version: 1, kind: "once", localDate, localTime: "23:59", timezone: "UTC" },
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
      provider: { list: async () => ({ data: { all: [{ id: "openai", name: "OpenAI", models: { "gpt-5": { id: "gpt-5", name: "GPT-5" } } }] } }) },
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
      schedule: { version: 1, kind: "once", localDate, localTime: "23:59", timezone: "UTC" },
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
