import { applyEdits, modify } from "jsonc-parser";
import type { ProviderConfig } from "@opencode-ai/sdk/v2/client";

import type {
  DenOrgLlmProvider,
  DenOrgLlmProviderConnection,
} from "../../../../app/lib/den";
import type { CloudImportedProvider } from "../../../../app/cloud/import-state";
import type { DeploymentModelCatalog } from "./deployment-model-catalog";

/**
 * Pure helpers that build and reconcile the cloud-managed ("lpr_*") provider
 * block inside a workspace `opencode.jsonc`. Extracted from the provider-auth
 * store so the diff/update behaviour can be unit tested directly (#2346).
 */

/**
 * Name of the user-env variable that carries an imported provider's gateway
 * token to MCP subprocesses.
 *
 * The server declares its own name for this credential (`JUGGLEWORK_GATEWAY_KEY_*`,
 * from services.GatewayCredentialEnvName) and OpenCode consumes it from auth.json.
 * A stdio MCP server cannot read auth.json, and the server's name is unusable as
 * an environment variable here: the user env store refuses writes to
 * `JUGGLEWORK_*`/`OPENCODE_*` (isReservedEnvKey) and strips them again when
 * injecting into children (readForInjection, mirrored in the Electron shell
 * loader). So the desktop mirrors the token under a non-reserved name that
 * survives both gates.
 *
 * The console derives the same name when it binds an MCP component to a
 * provider — keep this in sync with `gatewayCredentialEnvName` in
 * webconsole/web/app/(cloud)/dashboard/_components/mcp-component-payload.ts.
 *
 * @param cloudProviderId Organization LLM provider record id, e.g. `lpr_a1b2c3`.
 * @returns The environment variable name holding the gateway token.
 */
export const gatewayMirrorEnvName = (cloudProviderId: string): string => {
  const suffix = cloudProviderId.trim().replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return suffix ? `MCP_GATEWAY_KEY_${suffix}` : "MCP_GATEWAY_KEY";
};

const getStringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      )
    : [];

const sameStringList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const removeCloudProviderComment = (raw: string, providerId: string) =>
  raw.replace(
    new RegExp(
      `(^[ \t]*)// JuggleWork Cloud import:.*\\n\\1(?="${escapeRegExp(providerId)}":)`,
      "m",
    ),
    "$1",
  );

export const getCloudProviderEnv = (config: Record<string, unknown>) =>
  getStringList(config.env);

/**
 * Split a connect payload's credential into the opencode auth.json entry and
 * the env vars to upsert. Multi-env providers (`apiKeys`) set every value as
 * an env var and use the first env-ordered value as the auth entry, following
 * the models.dev convention that `env[0]` is the primary credential. Legacy
 * single-credential payloads (`apiKey`) keep today's auth-only behaviour.
 */
export const resolveCloudProviderCredentials = (
  provider: Pick<
    DenOrgLlmProviderConnection,
    "apiKey" | "apiKeys" | "providerConfig"
  >,
) => {
  const apiKeys = provider.apiKeys ?? {};
  const envNames = getCloudProviderEnv(provider.providerConfig);
  const orderedNames = [
    ...envNames.filter((name) => name in apiKeys),
    ...Object.keys(apiKeys).filter((name) => !envNames.includes(name)),
  ];
  const envEntries = orderedNames.flatMap((name) => {
    const value = apiKeys[name]?.trim();
    return value ? [{ key: name, value }] : [];
  });
  const primaryApiKey = provider.apiKey?.trim() || envEntries[0]?.value || "";
  return { envEntries, primaryApiKey };
};

export const getCloudManagedProviderId = (
  provider: Pick<DenOrgLlmProvider, "id" | "providerId" | "source">,
) => provider.id.trim();

/**
 * Cloud badges must reflect providers published by the active organization,
 * not merely workspace import records left by an earlier organization.
 */
export const getCurrentCloudManagedProviderIds = (input: {
  imported: Record<string, CloudImportedProvider>;
  liveProviders: Array<Pick<DenOrgLlmProvider, "id">>;
}) => {
  const liveIds = new Set(input.liveProviders.map((provider) => provider.id.trim()));
  return Object.values(input.imported)
    .filter((provider) => liveIds.has(provider.cloudProviderId.trim()))
    .map((provider) => provider.providerId);
};

/**
 * A provider key in `opencode.jsonc` that is owned by the cloud-import system:
 * `lpr_*` keys (org-managed providers) and `jugglework` (the built-in cloud
 * provider). These keys are never hand-authored, so re-importing over an
 * existing block with one of these ids is a safe reconcile (recovers a lost
 * import baseline) rather than a clobber of a user's manual provider (#2346).
 *
 * Kept in step with the two copies that cannot import this module or predate
 * it: `isCloudManagedProviderId` in `app/cloud/desktop-app-restrictions.ts`
 * (sits below `react-app/`) and the inline test in
 * `domains/session/modals/use-model-picker.ts`.
 */
export const isCloudManagedProviderKey = (providerId: string) =>
  /^lpr_/i.test(providerId) || providerId.trim().toLowerCase() === "jugglework";


export const getProviderModelIds = (
  provider: Pick<DenOrgLlmProvider, "models">,
) =>
  provider.models
    .flatMap((model) => {
      const id = model.id.trim();
      return id ? [id] : [];
    })
    .sort();

/**
 * Bump when `buildCloudProviderConfig` starts writing a materially different
 * block, so already-imported providers are rewritten once instead of keeping
 * whatever an older build wrote. 1: model metadata is backfilled from the
 * deployment catalog. 2: that backfill no longer reads the catalog through the
 * HTTP cache, so blocks written from a stale catalog are rewritten. 3: hosted
 * cloud imports also read the deployment catalog, including model variants.
 * 4: imports also mirror the gateway token to the user env store
 * (`gatewayMirrorEnvName`) so stdio MCP servers can read it — providers
 * imported by an older build have no such variable and would otherwise leave
 * every gateway-backed MCP reporting a missing credential until the member
 * re-imported by hand.
 */
export const CLOUD_PROVIDER_METADATA_VERSION = 4;

export const isCloudProviderOutOfSync = (
  provider: DenOrgLlmProvider,
  importedProvider: CloudImportedProvider,
) =>
  (importedProvider.metadataVersion ?? 0) < CLOUD_PROVIDER_METADATA_VERSION ||
  importedProvider.providerId !== getCloudManagedProviderId(provider) ||
  importedProvider.sourceProviderId !== provider.providerId ||
  (importedProvider.source ?? null) !== provider.source ||
  (importedProvider.updatedAt ?? null) !== (provider.updatedAt ?? null) ||
  !sameStringList(
    importedProvider.modelIds,
    // Normalize both sides: raw Den ids can include whitespace/empty values,
    // which otherwise made providers permanently out-of-sync.
    getProviderModelIds(provider),
  );

/**
 * `isCloudProviderOutOfSync` compares the import baseline against Den, never
 * against the engine — so a provider stays "in sync" even when the engine never
 * loaded it, because the engine reads cloud providers from the runtime config
 * at startup or reload only. This answers the other question: which imported
 * providers is the running engine missing?
 *
 * Returns a stable `<workspaceId>::<ids>` key so a caller can request one
 * reload per distinct gap instead of re-requesting on every sync trigger, or
 * null when the engine already knows all of them.
 */
export function missingCloudProviderReloadKey(input: {
  workspaceId: string;
  imported: Record<string, CloudImportedProvider>;
  engineProviderIds: readonly string[];
}): string | null {
  const expected = new Set(
    Object.values(input.imported)
      .map((entry) => entry.providerId.trim())
      .filter(Boolean),
  );
  if (expected.size === 0) return null;

  const known = new Set(
    input.engineProviderIds.map((id) => id.trim()).filter(Boolean),
  );
  const missing = [...expected].filter((id) => !known.has(id)).sort();
  return missing.length > 0 ? `${input.workspaceId}::${missing.join(",")}` : null;
}

/**
 * Every model field the engine reads off a workspace provider block. Anything
 * missing here falls back to the engine's own defaults — `limit.context: 0`
 * (which disables context accounting and compaction), zero cost, and
 * text-only capabilities.
 */
const CLOUD_PROVIDER_MODEL_FIELDS = [
  "family",
  "release_date",
  "attachment",
  "reasoning",
  "temperature",
  "tool_call",
  "interleaved",
  "cost",
  "limit",
  "modalities",
  "status",
  "options",
  "headers",
  "provider",
  "variants",
] as const;

export const buildCloudProviderConfig = (
  provider: DenOrgLlmProviderConnection,
  catalog?: DeploymentModelCatalog | null,
): ProviderConfig => {
  // The block is keyed by the cloud row id (`lpr_*`), which the engine cannot
  // match against the catalog — so resolve the catalog by the provider's
  // source id here and let it fill whatever Den did not publish.
  const catalogModels = catalog?.[provider.providerId] ?? null;

  const models = Object.fromEntries(
    provider.models.map((model) => {
      const next: NonNullable<ProviderConfig["models"]>[string] = {
        id: model.id,
        name: model.name,
      };
      const raw = model.config;
      const catalogModel = catalogModels?.[model.id];
      for (const key of CLOUD_PROVIDER_MODEL_FIELDS) {
        const value = raw[key] !== undefined ? raw[key] : catalogModel?.[key];
        if (value !== undefined) {
          (next as Record<string, unknown>)[key] = value;
        }
      }
      return [model.id, next];
    }),
  );

  const next: ProviderConfig = {
    id: provider.providerId,
    name: provider.name,
    env: getCloudProviderEnv(provider.providerConfig),
  };

  next.models = models;

  if (
    typeof provider.providerConfig.npm === "string" &&
    provider.providerConfig.npm.trim()
  ) {
    next.npm = provider.providerConfig.npm;
  }
  if (
    typeof provider.providerConfig.api === "string" &&
    provider.providerConfig.api.trim()
  ) {
    next.api = provider.providerConfig.api;
  }
  if (
    provider.providerConfig.options &&
    typeof provider.providerConfig.options === "object"
  ) {
    next.options = provider.providerConfig.options as Record<string, unknown>;
  }
  if (Array.isArray(provider.providerConfig.whitelist)) {
    next.whitelist = getStringList(provider.providerConfig.whitelist);
  }
  if (Array.isArray(provider.providerConfig.blacklist)) {
    next.blacklist = getStringList(provider.providerConfig.blacklist);
  }

  return next;
};

/**
 * Build the per-key runtime provider patch for a cloud import/reconcile.
 * Sent to `PATCH /workspace/:id/config` where record values upsert and
 * explicit `null` deletes (`mergeRuntimeProviderUpdate`) — no client-side
 * read-modify-write of the user's `opencode.jsonc` at all.
 */
export const buildRuntimeProviderPatch = (
  provider: DenOrgLlmProviderConnection,
  localProviderId: string,
  previousProviderId?: string | null,
  catalog?: DeploymentModelCatalog | null,
): Record<string, unknown> => {
  const patch: Record<string, unknown> = {};
  if (previousProviderId && previousProviderId !== localProviderId) {
    patch[previousProviderId] = null;
  }
  patch[localProviderId] = buildCloudProviderConfig(
    provider,
    catalog,
  ) as unknown as Record<string, unknown>;
  return patch;
};

export const formatConfigWithoutCloudProvider = (
  raw: string,
  providerId: string,
  disabledProviders: string[],
) => {
  let updated = raw.trim()
    ? raw
    : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  updated = removeCloudProviderComment(updated, providerId);
  const providerEdits = modify(updated, ["provider", providerId], undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  updated = applyEdits(updated, providerEdits);

  const nextDisabled = disabledProviders.filter((id) => id !== providerId);
  const disabledEdits = modify(updated, ["disabled_providers"], nextDisabled, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  updated = applyEdits(updated, disabledEdits);
  return updated.endsWith("\n") ? updated : `${updated}\n`;
};
