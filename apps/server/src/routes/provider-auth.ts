import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { Auth } from "@opencode-ai/sdk/v2/types";

import { ApiError } from "../errors.js";
import { readJuggleWorkWorkspaceConfig, writeJuggleWorkWorkspaceConfig } from "../jugglework-workspace-config-store.js";
import { readRuntimeOpencodeConfig, runtimeDisabledProviderList } from "../runtime-opencode-config-store.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { addRoute, type Route } from "./registry.js";

type WorkspaceOpencodeClient = ReturnType<typeof createOpencodeClient>;
type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;

interface RegisterProviderAuthRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  ensureWritable: (config: ServerConfig) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  createWorkspaceOpencodeClient: (config: ServerConfig, workspace: WorkspaceInfo) => WorkspaceOpencodeClient;
}

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CLOUD_PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function importedProviders(config: Record<string, unknown>): Record<string, unknown> {
  return record(record(config.cloudImports)?.providers) ?? {};
}

function parseCloudProviderId(value: string): string {
  const id = value.trim();
  if (!CLOUD_PROVIDER_ID_PATTERN.test(id)) throw new ApiError(400, "invalid_cloud_provider_id", "Cloud provider ID is invalid");
  return id;
}

function parseProviderId(value: string): string {
  const providerId = value.trim();
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new ApiError(400, "invalid_provider_id", "Provider ID is invalid");
  }
  return providerId;
}

function parseApiAuth(body: Record<string, unknown>): Auth {
  const keys = Object.keys(body);
  if (keys.some((key) => key !== "type" && key !== "key" && key !== "metadata")) {
    throw new ApiError(400, "invalid_provider_auth", "Provider authentication payload is invalid");
  }
  if (body.type !== "api" || typeof body.key !== "string" || !body.key.trim()) {
    throw new ApiError(400, "invalid_provider_auth", "Provider authentication payload is invalid");
  }
  if (body.metadata !== undefined) {
    if (!body.metadata || typeof body.metadata !== "object" || Array.isArray(body.metadata)) {
      throw new ApiError(400, "invalid_provider_auth", "Provider authentication payload is invalid");
    }
    if (Object.values(body.metadata).some((value) => typeof value !== "string")) {
      throw new ApiError(400, "invalid_provider_auth", "Provider authentication payload is invalid");
    }
  }
  return body as Auth;
}

function assertOpencodeSuccess(
  result: Awaited<ReturnType<WorkspaceOpencodeClient["auth"]["set"]>>,
): void {
  if (result.response.ok) return;
  throw new ApiError(502, "opencode_request_failed", "OpenCode provider authentication request failed", {
    status: result.response.status,
  });
}

export function registerProviderAuthRoutes(options: RegisterProviderAuthRoutesOptions): void {
  const {
    routes,
    config,
    jsonResponse,
    readJsonBody,
    ensureWritable,
    resolveWorkspace,
    createWorkspaceOpencodeClient,
  } = options;

  addRoute(routes, "GET", "/workspace/:id/provider-auth", "host-token", async (ctx) => {
    await resolveWorkspace(config, ctx.params.id);
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/workspace/:id/cloud-provider-imports/:cloudProviderId", "host-token", async (ctx) => {
    const cloudProviderId = parseCloudProviderId(ctx.params.cloudProviderId);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const item = importedProviders(await readJuggleWorkWorkspaceConfig(config, workspace.id))[cloudProviderId] ?? null;
    return jsonResponse({ item });
  });

  addRoute(routes, "PUT", "/workspace/:id/cloud-provider-imports/:cloudProviderId", "host-token", async (ctx) => {
    ensureWritable(config);
    const cloudProviderId = parseCloudProviderId(ctx.params.cloudProviderId);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const item = record(body.item);
    if (!item || item.cloudProviderId !== cloudProviderId || typeof item.providerId !== "string") {
      throw new ApiError(400, "invalid_cloud_provider_import", "Cloud provider import baseline is invalid");
    }
    await writeJuggleWorkWorkspaceConfig(config, workspace.id, (current) => ({
      ...current,
      cloudImports: {
        ...(record(current.cloudImports) ?? {}),
        providers: { ...importedProviders(current), [cloudProviderId]: item },
      },
    }));
    return jsonResponse({ ok: true, item });
  });

  addRoute(routes, "DELETE", "/workspace/:id/cloud-provider-imports/:cloudProviderId", "host-token", async (ctx) => {
    ensureWritable(config);
    const cloudProviderId = parseCloudProviderId(ctx.params.cloudProviderId);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    await writeJuggleWorkWorkspaceConfig(config, workspace.id, (current) => {
      const providers = { ...importedProviders(current) };
      delete providers[cloudProviderId];
      return {
        ...current,
        cloudImports: { ...(record(current.cloudImports) ?? {}), providers },
      };
    });
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "PUT", "/workspace/:id/provider-auth/:providerId", "host-token", async (ctx) => {
    ensureWritable(config);
    const providerId = parseProviderId(ctx.params.providerId);
    const auth = parseApiAuth(await readJsonBody(ctx.request));
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const result = await createWorkspaceOpencodeClient(config, workspace).auth.set({ providerID: providerId, auth });
    assertOpencodeSuccess(result);
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "DELETE", "/workspace/:id/provider-auth/:providerId", "host-token", async (ctx) => {
    ensureWritable(config);
    const providerId = parseProviderId(ctx.params.providerId);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const result = await createWorkspaceOpencodeClient(config, workspace).auth.remove({ providerID: providerId });
    assertOpencodeSuccess(result);
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/workspace/:id/provider-status/:providerId", "host-token", async (ctx) => {
    const providerId = parseProviderId(ctx.params.providerId);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const result = await createWorkspaceOpencodeClient(config, workspace).provider.list();
    if (!result.response.ok || !result.data) {
      throw new ApiError(502, "opencode_request_failed", "OpenCode provider visibility request failed", {
        status: result.response.status,
      });
    }
    const provider = result.data.all.find((item) => item.id === providerId);
    const authenticated = result.data.connected.includes(providerId);
    const disabled = runtimeDisabledProviderList(await readRuntimeOpencodeConfig(config, workspace.id)).includes(providerId);
    const imported = Object.values(importedProviders(await readJuggleWorkWorkspaceConfig(config, workspace.id)))
      .some((item) => record(item)?.providerId === providerId);
    return jsonResponse({
      providerId,
      published: null,
      imported,
      loaded: Boolean(provider),
      authenticated,
      enabled: provider ? !disabled : null,
      models: provider ? Object.keys(provider.models).sort().map((modelId) => ({
        id: modelId,
        published: null,
        imported,
        loaded: true,
        authenticated,
        enabled: !disabled,
        verifiedExecutable: null,
      })) : [],
    });
  });
}
