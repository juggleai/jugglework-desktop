import { applyEdits, modify, parse } from "jsonc-parser";
export {
  buildCloudImportedProvider,
  buildCloudProviderConfig,
  buildRuntimeProviderPatch,
  CLOUD_PROVIDER_METADATA_VERSION,
  filterImportableCloudOrgProviders,
  gatewayMirrorEnvName,
  getCloudManagedProviderId,
  getCloudProviderEnv,
  getCurrentCloudManagedProviderIds,
  getProviderModelIds,
  isCloudManagedProviderKey,
  isCloudProviderOutOfSync,
  missingCloudProviderReloadKey,
  resolveCloudProviderCredentials,
} from "@jugglework/cloud-provider";

/**
 * Pure helpers that build and reconcile the cloud-managed ("lpr_*") provider
 * block inside a workspace `opencode.jsonc`. Extracted from the provider-auth
 * store so the diff/update behaviour can be unit tested directly (#2346).
 */

const getStringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      )
    : [];

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

export const formatConfigWithoutCloudProviders = (
  raw: string,
  providerIds: readonly string[],
) => {
  const ids = [...new Set(providerIds.map((id) => id.trim()).filter(Boolean))];
  let updated = raw.trim()
    ? raw
    : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  for (const providerId of ids) {
    updated = removeCloudProviderComment(updated, providerId);
    const providerEdits = modify(updated, ["provider", providerId], undefined, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    updated = applyEdits(updated, providerEdits);
  }

  const parsed = (parse(updated) ?? {}) as Record<string, unknown>;
  const removed = new Set(ids.map((id) => id.toLowerCase()));
  const nextDisabled = getStringList(parsed.disabled_providers).filter(
    (id) => !removed.has(id.trim().toLowerCase()),
  );
  const disabledEdits = modify(updated, ["disabled_providers"], nextDisabled, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  updated = applyEdits(updated, disabledEdits);
  return updated.endsWith("\n") ? updated : `${updated}\n`;
};
