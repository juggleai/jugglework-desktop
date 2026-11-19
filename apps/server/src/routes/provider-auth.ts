import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { Auth } from "@opencode-ai/sdk/v2/types";
import { resolve, sep } from "node:path";

import { ApiError } from "../errors.js";
import { readJuggleWorkWorkspaceConfig, writeJuggleWorkWorkspaceConfig } from "../jugglework-workspace-config-store.js";
import { readRuntimeOpencodeConfig, runtimeDisabledProviderList } from "../runtime-opencode-config-store.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import type { EnvService } from "../env-file.js";
import {
  cloudGatewayMirrorEnvName,
  cloudGatewayMirrorOwnerId,
} from "@jugglework/types/provider-credentials";
import { addRoute, type Route } from "./registry.js";
import { managedProviderAuthority } from "../managed-provider-authority.js";
import { createWorkspaceProviderCredentialResolver } from "../provider-credential-resolver.js";

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
  env: EnvService;
}

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CLOUD_PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function importedProviders(config: Record<string, unknown>): Record<string, unknown> {
  return record(record(config.cloudImports)?.providers) ?? {};
}

/**
 * Whether a workspace other than `excludeWorkspaceId` still imports a cloud
 * provider that matches `matches`.
 *
 * The OpenCode auth store and the gateway credential record are both shared
 * by every workspace on this machine. Removing one workspace's import must not
 * delete a credential another workspace is still using; that is how one
 * workspace's cleanup used to leave the others failing with 401.
 */
async function importedByAnotherWorkspace(
  config: ServerConfig,
  excludeWorkspaceId: string,
  matches: (item: Record<string, unknown>) => boolean,
): Promise<boolean> {
  for (const workspace of config.workspaces) {
    if (workspace.id === excludeWorkspaceId) continue;
    const providers = importedProviders(await readJuggleWorkWorkspaceConfig(config, workspace.id));
    if (Object.values(providers).some((item) => {
      const entry = record(item);
      return Boolean(entry && matches(entry));
    })) return true;
  }
  return false;
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
    env,
  } = options;

  const authority = managedProviderAuthority(config);
  addRoute(routes, "GET", "/managed-provider-authority", "host-token", async () =>
    jsonResponse({ revision: authority.currentRevision() }));
  addRoute(routes, "DELETE", "/managed-provider-authority", "host-token", async (ctx) => {
    const expected = new URL(ctx.request.url).searchParams.get("revision");
    return jsonResponse({ revision: expected !== null ? authority.fenceIfCurrent(expected) : authority.fence() });
  });
  addRoute(routes, "PUT", "/managed-provider-authority", "host-token", async (ctx) => {
    const { revision, deployment, userId, organizationId, session } = await readJsonBody(ctx.request);
    if (typeof revision !== "string" || typeof deployment !== "string" || typeof userId !== "string" ||
      typeof organizationId !== "string" || typeof session !== "string" || !userId.trim() || !organizationId.trim() ||
      !/^[a-f0-9]{64}$/.test(session) || !URL.canParse(deployment) || !/^https?:\/\//.test(deployment)) {
      throw new ApiError(400, "invalid_managed_provider_authority", "Managed provider scope is invalid");
    }
    const active = authority.confirm(revision, { deployment, userId, organizationId, session });
    if (!active) throw new ApiError(409, "stale_managed_provider_authority", "Managed provider scope changed");
    return jsonResponse({ id: active.id });
  });
  addRoute(routes, "PUT", "/workspace/:id/managed-provider-readiness", "host-token", async (ctx) => {
    const { authorityId, ready } = await readJsonBody(ctx.request);
    if (typeof authorityId !== "string" || typeof ready !== "boolean" || !config.workspaces.some((ws) => ws.id === ctx.params.id && ws.workspaceType !== "remote") ||
      !authority.setWorkspaceReady(authorityId, ctx.params.id, ready)) {
      throw new ApiError(409, "stale_managed_provider_authority", "Managed provider scope changed");
    }
    return jsonResponse({ ok: true });
  });
  addRoute(routes, "GET", "/workspace/:id/managed-provider-inventory", "host-token", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const result = await createWorkspaceOpencodeClient(config, workspace).provider.list();
    if (!result.response.ok || !result.data) throw new ApiError(502, "model_catalog_unavailable", "Model catalog unavailable");
    const { all, connected, default: defaults } = result.data;
    return jsonResponse({ connected, default: defaults, all: all.map(({ id, name, source, models }) => ({
      id, name, source, models: Object.fromEntries(Object.keys(models ?? {}).map((modelId) => [modelId, {}])),
    })) });
  });

  // Used by the managed engine at actual egress (including retries). A caller
  // may ask a yes/no question, but cannot set the authority with its client token.
  addRoute(routes, "POST", "/internal/managed-provider-dispatch", "client", async (ctx) => {
    const { directory, providerID, url, digest } = await readJsonBody(ctx.request);
    if (typeof directory !== "string" || typeof url !== "string" || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
      return jsonResponse({ allowed: false });
    }
    const path = resolve(directory);
    const matches = config.workspaces.filter((workspace) => workspace.workspaceType !== "remote" &&
      (path === resolve(workspace.path) || path.startsWith(`${resolve(workspace.path)}${sep}`)))
      .sort((a, b) => resolve(b.path).length - resolve(a.path).length);
    if (!directory || !matches[0] || (matches[1] && resolve(matches[0].path) === resolve(matches[1].path))) return jsonResponse({ allowed: false });
    const credentials = createWorkspaceProviderCredentialResolver({ config, env, readOnly: true });
    return jsonResponse({ allowed: await credentials.canDispatch(matches[0], { providerID: typeof providerID === "string" ? providerID : undefined, url, digest }) });
  });

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

  addRoute(routes, "PUT", "/workspace/:id/cloud-provider-mirror/:cloudProviderId", "host-token", async (ctx) => {
    ensureWritable(config);
    const cloudProviderId = parseCloudProviderId(ctx.params.cloudProviderId);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const organizationId = typeof body.organizationId === "string" ? body.organizationId.trim() : "";
    const value = typeof body.value === "string" ? body.value : "";
    if (!organizationId || !value.trim()) {
      throw new ApiError(400, "invalid_cloud_provider_mirror", "Cloud provider mirror payload is invalid");
    }
    // The workspace only authorizes the write. The gateway credential is issued
    // per member and device, so one record per organization provider is shared
    // by every workspace on this machine instead of drifting per workspace.
    const owner = { organizationId, cloudProviderId };
    const key = cloudGatewayMirrorEnvName(owner);
    await env.upsertOwned({ key, value, owner: cloudGatewayMirrorOwnerId(owner) });
    return jsonResponse({ ok: true, mirror: { ...owner, key } });
  });

  addRoute(routes, "DELETE", "/workspace/:id/cloud-provider-mirror/:cloudProviderId", "host-token", async (ctx) => {
    ensureWritable(config);
    const cloudProviderId = parseCloudProviderId(ctx.params.cloudProviderId);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const baseline = record(importedProviders(await readJuggleWorkWorkspaceConfig(config, workspace.id))[cloudProviderId]);
    const mirror = record(baseline?.gatewayMirror);
    const organizationId = typeof mirror?.organizationId === "string" ? mirror.organizationId.trim() : "";
    const key = typeof mirror?.key === "string" ? mirror.key.trim() : "";
    const legacyWorkspaceId = typeof mirror?.workspaceId === "string" ? mirror.workspaceId.trim() : "";
    const owner = legacyWorkspaceId
      ? { workspaceId: legacyWorkspaceId, organizationId, cloudProviderId }
      : { organizationId, cloudProviderId };
    if ((legacyWorkspaceId && legacyWorkspaceId !== workspace.id) || mirror?.cloudProviderId !== cloudProviderId || !organizationId ||
      key !== cloudGatewayMirrorEnvName(owner)) {
      throw new ApiError(409, "cloud_provider_mirror_unowned", "Cloud provider mirror has no exact owning baseline");
    }
    const expectedOwner = cloudGatewayMirrorOwnerId(owner);
    const stored = (await env.list()).find((entry) => entry.key === key);
    if (stored && stored.owner !== expectedOwner) {
      throw new ApiError(409, "cloud_provider_mirror_unowned", "Cloud provider mirror ownership does not match");
    }
    // A shared record stays while any other workspace still imports this
    // organization provider. A legacy record belongs to this workspace alone.
    const sharedStillUsed = !legacyWorkspaceId && await importedByAnotherWorkspace(config, workspace.id, (item) =>
      item.cloudProviderId === cloudProviderId && item.organizationId === organizationId);
    if (stored && !sharedStillUsed) await env.deleteOwned(key, expectedOwner);
    return jsonResponse({ ok: true, retained: Boolean(stored && sharedStillUsed) });
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
    // OpenCode keeps one auth entry per provider id for the whole machine.
    // Another workspace that still imports this provider needs the entry.
    if (await importedByAnotherWorkspace(config, workspace.id, (item) => item.providerId === providerId)) {
      return jsonResponse({ ok: true, retained: true });
    }
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
