import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { filterImportableCloudOrgProviders, getCloudManagedProviderId, type CloudProvider } from "@jugglework/cloud-provider";
import type { CliOptions } from "./args.js";
import { JuggleWorkApiClient } from "./api.js";
import { CloudClient, CloudHttpError } from "./cloud-client.js";
import { CloudProfileStore, cloudProfilePath } from "./cloud-profiles.js";
import { normalizeCloudUrl } from "./cloud-url.js";
import { chooseWorkspace } from "./controller.js";
import type { CliRenderer } from "./render.js";
import { createRuntime, resolveOpenCodeBinary, resolvePackagedRuntimeAssets, resolvePluginDirectory } from "./runtime.js";

export type DoctorStatus = "pass" | "warning" | "failure";
export type DoctorCheck = { id: string; status: DoctorStatus; message: string; details?: Record<string, unknown> };
export type DoctorReport = { ok: boolean; checks: DoctorCheck[]; summary: Record<DoctorStatus, number> };

function message(error: unknown): string {
  if (error instanceof CloudHttpError) return `${error.message} [${error.code}]`;
  return error instanceof Error ? error.message : String(error);
}

async function workspaceCheck(path: string): Promise<DoctorCheck> {
  try {
    if (!(await stat(path)).isDirectory()) return { id: "workspace", status: "failure", message: "Workspace is not a directory.", details: { path } };
    await access(path, constants.R_OK);
    try {
      await access(path, constants.W_OK);
      return { id: "workspace", status: "pass", message: "Workspace is readable and writable.", details: { path, readable: true, writable: true } };
    } catch {
      return { id: "workspace", status: "warning", message: "Workspace is readable but not writable.", details: { path, readable: true, writable: false } };
    }
  } catch {
    return { id: "workspace", status: "failure", message: "Workspace is not accessible.", details: { path, readable: false, writable: false } };
  }
}

async function assetsCheck(options: CliOptions): Promise<DoctorCheck> {
  try {
    const packaged = await resolvePackagedRuntimeAssets();
    if (packaged) return { id: "runtime_assets", status: "pass", message: "Packaged manifest and runtime assets passed integrity checks.", details: { mode: "packaged", manifest: true, sidecar: true, plugins: true } };
    const opencode = await resolveOpenCodeBinary(options.opencodeBin);
    const plugins = opencode ? await resolvePluginDirectory(options.pluginDir, opencode) : null;
    if (opencode && plugins) return { id: "runtime_assets", status: "pass", message: "Development runtime sidecar and plugin assets are accessible.", details: { mode: "development", manifest: false, sidecar: true, plugins: true } };
    return { id: "runtime_assets", status: "failure", message: "Runtime sidecar or required plugin assets are missing.", details: { mode: "development", manifest: false, sidecar: Boolean(opencode), plugins: Boolean(plugins) } };
  } catch (error) {
    return { id: "runtime_assets", status: "failure", message: message(error), details: { manifest: true, verified: false } };
  }
}

export async function buildDoctorReport(options: CliOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let publishedProviders: CloudProvider[] | null = null;
  const urls = normalizeCloudUrl(options.cloudUrl);
  const cloud = new CloudClient(urls);
  const profile = await new CloudProfileStore(cloudProfilePath(options.configPath)).get(urls.origin);
  const token = options.cloudToken ?? profile?.token ?? null;
  checks.push({ id: "cloud_profile", status: "pass", message: "Cloud deployment profile resolved.", details: { origin: urls.origin, source: options.cloudToken ? "environment" : profile ? "profile" : "default", tokenPresent: Boolean(token) } });
  try {
    await cloud.catalog();
    checks.push({ id: "cloud_reachability", status: "pass", message: "Cloud catalog is reachable.", details: { origin: urls.origin } });
  } catch (error) {
    checks.push({ id: "cloud_reachability", status: "failure", message: message(error), details: { origin: urls.origin } });
  }

  let organizationId = options.cloudOrg ?? profile?.organizationId ?? null;
  if (!token) {
    checks.push({ id: "cloud_login", status: "warning", message: "Cloud login is not configured.", details: { authenticated: false } });
    checks.push({ id: "organization", status: "warning", message: "Organization selection cannot be validated without login.", details: { selected: Boolean(organizationId) } });
    checks.push({ id: "providers_models", status: "warning", message: "Provider and model inventory requires Cloud login and an organization.", details: { providers: null, models: null } });
  } else {
    try {
      const user = await cloud.currentUser(token);
      checks.push({ id: "cloud_login", status: "pass", message: "Cloud login is valid.", details: { authenticated: true, userId: user.id } });
      const organizations = await cloud.organizations(token);
      const organization = organizations.find((item) => item.id === organizationId || item.slug === organizationId);
      if (!organization) {
        organizationId = null;
        checks.push({ id: "organization", status: "warning", message: "No valid organization is selected.", details: { selected: false, available: organizations.length } });
        checks.push({ id: "providers_models", status: "warning", message: "Provider and model inventory requires an organization selection.", details: { providers: null, models: null } });
      } else {
        checks.push({ id: "organization", status: "pass", message: "Selected organization is available to the account.", details: { selected: true, id: organization.id, slug: organization.slug } });
        const providers = filterImportableCloudOrgProviders(await cloud.providers(token, organization.id));
        publishedProviders = providers;
        checks.push({ id: "providers_models", status: "pass", message: "Organization provider and model inventory loaded.", details: { providers: providers.length, enabledProviders: providers.filter((item) => item.enabled !== false).length, models: providers.reduce((total, item) => total + item.models.length, 0), configuredModel: options.model } });
      }
    } catch (error) {
      checks.push({ id: "cloud_login", status: "failure", message: message(error), details: { authenticated: false } });
      checks.push({ id: "organization", status: "warning", message: "Organization selection was not validated.", details: { selected: Boolean(organizationId) } });
      checks.push({ id: "providers_models", status: "warning", message: "Provider and model inventory was not loaded.", details: { providers: null, models: null } });
    }
  }

  checks.push(await workspaceCheck(options.workspace));
  const assets = await assetsCheck(options);
  checks.push(assets);

  if (options.serverUrl && !options.token) {
    checks.push({ id: "runtime", status: "failure", message: "Connected runtime diagnostics require a Server token.", details: { connected: true, configured: false } });
  } else {
    let ownedRuntime: Awaited<ReturnType<typeof createRuntime>> | null = null;
    try {
      if (!options.serverUrl) {
        if (assets.details?.mode !== "packaged") {
          checks.push({ id: "runtime", status: "warning", message: "Source-mode runtime health requires an explicit Server connection; a packaged CLI can probe its embedded runtime.", details: { connected: false, embeddedStarted: false } });
          checks.push({ id: "provider_visibility", status: "warning", message: "Provider visibility requires a running Server.", details: { checked: false } });
          return summarize(checks);
        }
        ownedRuntime = await createRuntime(options);
      }
      const api = new JuggleWorkApiClient(ownedRuntime?.url ?? options.serverUrl!, ownedRuntime?.token ?? options.token!, ownedRuntime?.hostToken ?? options.hostToken);
      const [health, status, workspaces] = await Promise.all([api.health(), api.status(), api.listWorkspaces()]);
      const workspace = await chooseWorkspace(api, options, null);
      const runtimeConfig = await api.runtimeConfig(workspace.id);
      const runtimeKeys = Array.isArray(runtimeConfig?.runtimeKeys) ? runtimeConfig.runtimeKeys.filter((key): key is string => typeof key === "string") : [];
      const effective = runtimeConfig?.effectiveRuntime && typeof runtimeConfig.effectiveRuntime === "object" && !Array.isArray(runtimeConfig.effectiveRuntime)
        ? runtimeConfig.effectiveRuntime as Record<string, unknown>
        : {};
      const providers = effective.provider && typeof effective.provider === "object" && !Array.isArray(effective.provider)
        ? Object.keys(effective.provider as Record<string, unknown>).length
        : 0;
      checks.push({ id: "runtime", status: health.ok ? "pass" : "failure", message: health.ok ? "Runtime is healthy." : "Runtime reported unhealthy.", details: { connected: Boolean(options.serverUrl), embeddedStarted: Boolean(ownedRuntime), version: health.version, opencodeVersion: health.opencodeVersion ?? null, workspaceCount: workspaces.items.length, workspaceId: workspace.id, readOnly: status.readOnly === true, runtimeConfigKeys: runtimeKeys, configuredProviders: providers } });
      if (publishedProviders && (ownedRuntime?.hostToken || options.hostToken)) {
        try {
          const states = await Promise.all(publishedProviders.map(async (provider) => {
            const state = await api.providerStatus(workspace.id, getCloudManagedProviderId(provider));
            return { id: provider.id, published: true, imported: state.imported, loaded: state.loaded, authenticated: state.authenticated, enabled: state.enabled, models: state.models.length, verifiedExecutable: state.models.some((model) => model.verifiedExecutable === true) ? state.models.filter((model) => model.verifiedExecutable === true).length : null };
          }));
          checks.push({ id: "provider_visibility", status: states.some((state) => !state.loaded || !state.authenticated || state.enabled === false) ? "warning" : "pass", message: "Organization providers were compared with the selected runtime.", details: { states } });
        } catch {
          checks.push({ id: "provider_visibility", status: "warning", message: "Provider visibility could not be verified through the runtime host API.", details: { checked: false } });
        }
      } else {
        checks.push({ id: "provider_visibility", status: "warning", message: publishedProviders ? "Provider visibility requires runtime host authority." : "Provider visibility requires Cloud login and a selected organization.", details: { checked: false } });
      }
    } catch (error) {
      checks.push({ id: "runtime", status: "failure", message: "Runtime health could not be verified.", details: { connected: Boolean(options.serverUrl), healthy: false, errorCode: error instanceof Error ? error.name : "unknown" } });
      checks.push({ id: "provider_visibility", status: "warning", message: "Provider visibility requires a healthy runtime.", details: { checked: false } });
    } finally {
      await ownedRuntime?.stop();
    }
  }

  return summarize(checks);
}

function summarize(checks: DoctorCheck[]): DoctorReport {
  const summary = { pass: 0, warning: 0, failure: 0 };
  for (const check of checks) summary[check.status] += 1;
  return { ok: summary.failure === 0, checks, summary };
}

export async function executeDoctor(options: CliOptions, renderer: CliRenderer): Promise<number> {
  const report = await buildDoctorReport(options);
  renderer.doctor(report);
  return report.ok ? 0 : 1;
}
