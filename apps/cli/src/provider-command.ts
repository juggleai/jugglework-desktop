import {
  buildCloudImportedProvider, buildRuntimeProviderPatch, gatewayMirrorEnvName,
  filterImportableCloudOrgProviders, getCloudManagedProviderId, isCloudManagedProviderKey, resolveCloudProviderCredentials,
  type CloudImportedProvider, type DeploymentModelCatalog,
} from "@jugglework/cloud-provider";
import type { CliOptions } from "./args.js";
import { JuggleWorkApiClient, JuggleWorkApiError, type JsonRecord, type RuntimeProviderStatus } from "./api.js";
import { CloudClient } from "./cloud-client.js";
import { CloudProfileStore, cloudProfilePath } from "./cloud-profiles.js";
import { resolveCloudOrganization } from "./cloud-organization.js";
import { normalizeCloudUrl } from "./cloud-url.js";
import type { CliRenderer } from "./render.js";
import { createRuntime, type RuntimeConnection } from "./runtime.js";
import { chooseWorkspace } from "./controller.js";

export type ProviderMutationStage = "host_authority" | "connection" | "environment" | "authentication" | "runtime_config" | "baseline" | "reload" | "verification";

export class ProviderMutationError extends Error {
  constructor(readonly operation: "import" | "remove", readonly stage: ProviderMutationStage, readonly completedStages: ProviderMutationStage[], cause: unknown) {
    const code = cause instanceof JuggleWorkApiError && cause.code ? ` (${cause.code})` : "";
    super(`Provider ${operation} failed at stage '${stage}'${code} after [${completedStages.join(", ") || "none"}]. Safe retry: run the same command again; completed stages are idempotent and were not rolled back.`);
    this.name = "ProviderMutationError";
  }
}

type RuntimeApi = Pick<JuggleWorkApiClient, "preflightProviderAuthority" | "upsertUserEnvironment" | "removeUserEnvironment" | "setProviderAuth" | "removeProviderAuth" | "patchWorkspaceConfig" | "reloadEngine" | "providerStatus" | "getCloudProviderImport" | "setCloudProviderImport" | "removeCloudProviderImport">;

async function stage<T>(operation: "import" | "remove", name: ProviderMutationStage, completed: ProviderMutationStage[], run: () => Promise<T>): Promise<T> {
  try {
    const result = await run();
    completed.push(name);
    return result;
  } catch (error) {
    throw new ProviderMutationError(operation, name, [...completed], error);
  }
}

function deploymentCatalog(payload: unknown): DeploymentModelCatalog | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const root = payload as Record<string, unknown>;
  const providers = root.providers;
  return (providers && typeof providers === "object" && !Array.isArray(providers) ? providers : root) as DeploymentModelCatalog;
}

export async function importProvider(input: { cloud: CloudClient; runtime: RuntimeApi; token: string; organizationId: string; workspaceId: string; cloudProviderId: string; registerSecrets?: (values: string[]) => void }): Promise<RuntimeProviderStatus> {
  const completed: ProviderMutationStage[] = [];
  await stage("import", "host_authority", completed, () => input.runtime.preflightProviderAuthority(input.workspaceId));
  const provider = await stage("import", "connection", completed, () => input.cloud.providerConnection(input.token, input.organizationId, input.cloudProviderId));
  if (provider.id !== input.cloudProviderId || !isCloudManagedProviderKey(provider.id) || filterImportableCloudOrgProviders([provider]).length !== 1) {
    throw new ProviderMutationError("import", "connection", completed, new Error("The selected publication is not importable."));
  }
  const localProviderId = getCloudManagedProviderId(provider);
  const existing = (await input.runtime.getCloudProviderImport(input.workspaceId, input.cloudProviderId)).item as CloudImportedProvider | null;
  const credentials = resolveCloudProviderCredentials(provider);
  input.registerSecrets?.([credentials.primaryApiKey, ...credentials.envEntries.map((entry) => entry.value)].filter(Boolean));
  const requiredEnv = Array.isArray(provider.providerConfig?.env) ? provider.providerConfig.env.filter((value): value is string => typeof value === "string") : [];
  if (!credentials.primaryApiKey && requiredEnv.length) throw new ProviderMutationError("import", "connection", completed, new Error(`${provider.name} has no stored organization credential.`));
  const envEntries = [...credentials.envEntries];
  if (credentials.primaryApiKey) envEntries.push({ key: gatewayMirrorEnvName(provider.id), value: credentials.primaryApiKey });
  if (envEntries.length) await stage("import", "environment", completed, () => input.runtime.upsertUserEnvironment(envEntries)); else completed.push("environment");
  if (credentials.primaryApiKey) await stage("import", "authentication", completed, () => input.runtime.setProviderAuth(input.workspaceId, localProviderId, credentials.primaryApiKey)); else completed.push("authentication");
  await stage("import", "runtime_config", completed, async () => {
    const catalog = deploymentCatalog(await input.cloud.catalog());
    return input.runtime.patchWorkspaceConfig(input.workspaceId, { opencode: { provider: buildRuntimeProviderPatch(provider, localProviderId, existing?.providerId ?? null, catalog) } });
  });
  const baseline = buildCloudImportedProvider(provider);
  await stage("import", "baseline", completed, () => input.runtime.setCloudProviderImport(input.workspaceId, provider.id, baseline as unknown as JsonRecord));
  await stage("import", "reload", completed, () => input.runtime.reloadEngine(input.workspaceId));
  const status = await stage("import", "verification", completed, () => input.runtime.providerStatus(input.workspaceId, localProviderId));
  if (!status.loaded) throw new ProviderMutationError("import", "verification", completed.slice(0, -1), new Error("Provider is not visible after reload."));
  return status;
}

export async function removeProvider(input: { runtime: RuntimeApi; workspaceId: string; cloudProviderId: string }): Promise<void> {
  const completed: ProviderMutationStage[] = [];
  await stage("remove", "host_authority", completed, () => input.runtime.preflightProviderAuthority(input.workspaceId));
  const imported = (await input.runtime.getCloudProviderImport(input.workspaceId, input.cloudProviderId)).item as CloudImportedProvider | null;
  if (!imported) return;
  await stage("remove", "environment", completed, async () => { try { await input.runtime.removeUserEnvironment(gatewayMirrorEnvName(input.cloudProviderId)); } catch (error) { if (!(error instanceof JuggleWorkApiError && error.status === 404)) throw error; } });
  await stage("remove", "authentication", completed, async () => { try { await input.runtime.removeProviderAuth(input.workspaceId, imported.providerId); } catch (error) { if (!(error instanceof JuggleWorkApiError && error.status === 404)) throw error; } });
  await stage("remove", "runtime_config", completed, () => input.runtime.patchWorkspaceConfig(input.workspaceId, { opencode: { provider: { [imported.providerId]: null } } }));
  await stage("remove", "baseline", completed, () => input.runtime.removeCloudProviderImport(input.workspaceId, input.cloudProviderId));
  await stage("remove", "reload", completed, () => input.runtime.reloadEngine(input.workspaceId));
}

async function selectedCloud(options: CliOptions): Promise<{ cloud: CloudClient; token: string; organizationId: string }> {
  const urls = normalizeCloudUrl(options.cloudUrl);
  const store = new CloudProfileStore(cloudProfilePath(options.configPath));
  const profile = options.cloudToken ? null : await store.get(urls.origin);
  const token = options.cloudToken ?? profile?.token ?? null;
  if (!token) throw new Error("Not signed in to JuggleWork Cloud. Run 'jugglework login'.");
  const cloud = new CloudClient(urls);
  const selected = resolveCloudOrganization(await cloud.organizationState(token), {
    explicit: options.cloudOrg,
    remembered: profile?.user?.id ? await store.rememberedOrganization(urls.origin, profile.user.id) : null,
    current: profile?.organizationId,
  });
  if (!selected) {
    throw new Error(options.cloudOrg
      ? `No organization exactly matches '${options.cloudOrg}'.`
      : "This account has no available organizations.");
  }
  if (!options.cloudToken && profile && profile.organizationId !== selected.id) await store.selectOrganization(urls.origin, selected.id);
  return { cloud, token, organizationId: selected.id };
}

export async function executeProviderCommand(options: CliOptions, renderer: CliRenderer): Promise<number> {
  if (options.command.group !== "provider" || options.command.action === "list" || !options.command.target) throw new Error("Invalid provider mutation command.");
  let connection: RuntimeConnection | null = null;
  try {
    connection = await createRuntime(options);
    const api = new JuggleWorkApiClient(connection.url, connection.token, connection.hostToken);
    const workspaceId = (await chooseWorkspace(api, options, null)).id;
    if (options.command.action === "import") {
      const cloud = await selectedCloud(options);
      renderer.registerSecretValues([cloud.token]);
      const status = await importProvider({ ...cloud, runtime: api, workspaceId, cloudProviderId: options.command.target, registerSecrets: (values) => renderer.registerSecretValues(values) });
      renderer.providerMutation("imported", options.command.target, status);
    } else {
      await removeProvider({ runtime: api, workspaceId, cloudProviderId: options.command.target });
      renderer.providerMutation("removed", options.command.target, null);
    }
    return 0;
  } finally {
    await connection?.stop();
  }
}
