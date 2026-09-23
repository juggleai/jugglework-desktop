import type { CloudUrls } from "./cloud-url.js";
import type { CloudProvider, CloudProviderConnection, CloudProviderModel } from "@jugglework/cloud-provider";

export type { CloudProvider, CloudProviderModel } from "@jugglework/cloud-provider";

export type CloudUser = { id: string; name?: string; email?: string };
export type CloudOrganization = { id: string; name: string; slug: string; role?: string };
export type CloudOrganizations = { items: CloudOrganization[]; activeOrgId: string | null; activeOrgSlug: string | null };
export class CloudHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string,
    readonly referenceId: string | null = null,
  ) {
    super(message);
    this.name = "CloudHttpError";
  }
}

type Fetch = typeof globalThis.fetch;
type RequestOptions = { method?: string; token?: string | null; organizationId?: string | null; body?: unknown; public?: boolean };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseProvidersPayload(payload: unknown): CloudProvider[] {
  const body = record(payload);
  const values = Array.isArray(body?.llmProviders) ? body.llmProviders : [];
  return values.flatMap((value) => {
    const item = record(value);
    const id = safeString(item?.id);
    const providerId = safeString(item?.providerId);
    const name = safeString(item?.name);
    if (!id || !providerId || !name) return [];
    const models = Array.isArray(item?.models) ? item.models.flatMap((modelValue) => {
      const model = record(modelValue);
      const modelId = safeString(model?.id);
      const modelName = safeString(model?.name);
      const config = record(model?.config);
      return modelId && modelName ? [{ id: modelId, name: modelName, ...(config ? { config } : {}) } satisfies CloudProviderModel] : [];
    }) : [];
    const providerConfig = record(item?.providerConfig);
    const source = safeString(item?.source);
    const createdAt = safeString(item?.createdAt);
    const updatedAt = safeString(item?.updatedAt);
    return [{
      id, providerId, name,
      ...(source ? { source } : {}),
      ...(providerConfig ? { providerConfig } : {}),
      ...(typeof item?.hasApiKey === "boolean" ? { hasApiKey: item.hasApiKey } : {}),
      ...(typeof item?.enabled === "boolean" ? { enabled: item.enabled } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      models,
    } satisfies CloudProvider];
  });
}

export class CloudClient {
  constructor(readonly urls: CloudUrls, private readonly fetchImpl: Fetch = globalThis.fetch) {}

  private async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    const url = path === "catalog" ? this.urls.catalogUrl : `${path.startsWith("/api/") ? this.urls.controlPlaneUrl : this.urls.apiBaseUrl}${path}`;
    const headers = new Headers({ Accept: "application/json" });
    if (!options.public && options.token) headers.set("Authorization", `Bearer ${options.token}`);
    if (!options.public && options.organizationId) {
      headers.set("x-jugglework-org-id", options.organizationId);
      headers.set("x-jugglework-legacy-org-id", options.organizationId);
    }
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch {
      throw new CloudHttpError(`Cloud request failed for ${this.urls.origin}.`, null, "network_error");
    }
    const requestReference = response.headers.get("x-request-id");
    let payload: unknown = null;
    try { payload = await response.json(); } catch { /* normalized below */ }
    if (!response.ok) {
      const body = record(payload);
      const code = safeString(body?.error) ?? safeString(body?.code) ?? "request_failed";
      const referenceId = requestReference ?? safeString(body?.referenceId) ?? safeString(body?.reference_id);
      throw new CloudHttpError(
        `Cloud request failed for ${this.urls.origin} with HTTP ${response.status}${referenceId ? ` (reference ${referenceId})` : ""}.`,
        response.status,
        code,
        referenceId,
      );
    }
    return payload;
  }

  async exchangeHandoff(grant: string): Promise<{ token: string; user: CloudUser | null }> {
    const payload = record(await this.request("/v1/auth/desktop-handoff/exchange", { method: "POST", body: { grant } }));
    const token = safeString(payload?.token) ?? safeString(record(payload?.session)?.token);
    if (!token) throw new CloudHttpError("Cloud handoff response did not include a session token.", 500, "invalid_handoff_payload");
    return { token, user: this.parseUser(payload) };
  }

  async currentUser(token: string): Promise<CloudUser> {
    const payload = await this.request("/v1/me", { token });
    const user = this.parseUser(record(payload));
    if (!user) throw new CloudHttpError("Cloud session response did not include a user.", 500, "invalid_session_payload");
    return user;
  }

  async organizationState(token: string): Promise<CloudOrganizations> {
    const payload = record(await this.request("/v1/me/orgs", { token }));
    const values = Array.isArray(payload?.orgs) ? payload.orgs : Array.isArray(payload?.organizations) ? payload.organizations : [];
    const items = values.flatMap((value) => {
      const item = record(value);
      const id = safeString(item?.id);
      const name = safeString(item?.name);
      const slug = safeString(item?.slug);
      return id && name && slug ? [{ id, name, slug, ...(safeString(item?.role) ? { role: safeString(item?.role)! } : {}) }] : [];
    });
    return { items, activeOrgId: safeString(payload?.activeOrgId), activeOrgSlug: safeString(payload?.activeOrgSlug) };
  }

  async organizations(token: string): Promise<CloudOrganization[]> {
    return (await this.organizationState(token)).items;
  }

  async setActiveOrganization(token: string, organizationId: string): Promise<void> {
    await this.request("/v1/me/active-organization", { method: "POST", token, body: { organizationId } });
  }

  async providers(token: string, organizationId: string): Promise<CloudProvider[]> {
    return parseProvidersPayload(await this.request("/v1/llm-providers", { token, organizationId }));
  }

  async providerConnection(token: string, organizationId: string, providerId: string): Promise<CloudProviderConnection> {
    const payload = record(await this.request(`/v1/llm-providers/${encodeURIComponent(providerId)}/connect`, { token, organizationId }));
    const providerPayload = record(payload?.llmProvider);
    if (!providerPayload) throw new CloudHttpError("Cloud provider response did not include connection details.", 500, "invalid_llm_provider_payload");
    const parsed = parseProvidersPayload({ llmProviders: [providerPayload] });
    const provider = parsed[0];
    if (!provider) throw new CloudHttpError("Cloud provider response did not include connection details.", 500, "invalid_llm_provider_payload");
    const apiKeys = record(providerPayload.apiKeys);
    return {
      ...provider,
      apiKey: safeString(providerPayload.apiKey),
      apiKeys: apiKeys ? Object.fromEntries(Object.entries(apiKeys).flatMap(([key, value]) => typeof value === "string" && value.trim() ? [[key, value]] : [])) : null,
    };
  }

  catalog(): Promise<unknown> {
    return this.request("catalog", { public: true });
  }

  async logout(token: string): Promise<void> {
    await this.request("/api/auth/sign-out", { method: "POST", token, body: {} });
  }

  private parseUser(payload: Record<string, unknown> | null): CloudUser | null {
    const candidate = record(payload?.user) ?? record(record(payload?.session)?.user) ?? payload;
    const id = safeString(candidate?.id);
    if (!id) return null;
    return { id, ...(safeString(candidate?.name) ? { name: safeString(candidate?.name)! } : {}), ...(safeString(candidate?.email) ? { email: safeString(candidate?.email)! } : {}) };
  }

}
