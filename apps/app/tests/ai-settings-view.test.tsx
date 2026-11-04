import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import { buildModelGroupRows } from "../src/react-app/domains/settings/model-group-rows";
import { AiSettingsView, type AiSettingsViewProps } from "../src/react-app/domains/settings/pages/ai-view";

const imported = (cloudProviderId: string, providerId: string) => ({
  cloudProviderId,
  providerId,
  sourceProviderId: "openai",
  name: "Cloud OpenAI",
  source: "custom",
  updatedAt: null,
  modelIds: ["gpt-5"],
  importedAt: 1,
  metadataVersion: 11,
});

describe("AI settings model group rows", () => {
  test("uses the cloud directory as the organization inventory before runtime is ready", () => {
    const rows = buildModelGroupRows({
      runtimeProviders: [],
      connectedProviderIds: [],
      cloudOrgProviders: [{
        id: "lpr_cloud_openai",
        providerId: "openai",
        name: "Organization OpenAI",
        models: [{ id: "gpt-5" }, { id: "gpt-5-mini" }],
      }],
      importedCloudProviders: {},
      providerAuthError: null,
    });

    expect(rows.orgManagedProviders).toEqual([{
      id: "lpr_cloud_openai",
      sourceProviderId: "openai",
      name: "Organization OpenAI",
      connected: false,
      syncState: "pending",
      modelCount: 2,
    }]);
  });

  test("keeps ready rows available while marking only unready rows failed", () => {
    const rows = buildModelGroupRows({
      runtimeProviders: [],
      connectedProviderIds: ["lpr_ready"],
      cloudOrgProviders: [
        { id: "cloud_ready", providerId: "openai", name: "Ready", models: [] },
        { id: "cloud_pending", providerId: "anthropic", name: "Pending", models: [] },
      ],
      importedCloudProviders: {
        cloud_ready: imported("cloud_ready", "lpr_ready"),
      },
      providerAuthError: "temporary sync error",
    });

    expect(rows.orgManagedProviders.map((provider) => provider.syncState)).toEqual([
      "ready",
      "failed",
    ]);
  });

  test("excludes direct cloud runtime IDs and current imported local IDs from local rows", () => {
    const rows = buildModelGroupRows({
      runtimeProviders: [
        { id: "cloud_1", name: "Direct duplicate", connected: true },
        { id: "lpr_cloud", name: "Imported duplicate", connected: true },
        { id: "openai", name: "User OpenAI", source: "config", connected: true },
        { id: "local", name: "Local", source: "config", connected: true },
      ],
      connectedProviderIds: ["cloud_1", "lpr_cloud", "openai", "local"],
      cloudOrgProviders: [{ id: "cloud_1", providerId: "openai", name: "Cloud", models: [] }],
      importedCloudProviders: {
        cloud_1: imported("cloud_1", "lpr_cloud"),
        stale: imported("cloud_from_other_org", "local"),
      },
      providerAuthError: null,
    });

    expect(rows.localProviders.map((provider) => provider.id)).toEqual(["openai", "local"]);
  });
});

describe("AI settings cloud sync trigger", () => {
  const source = readFileSync(
    new URL("../src/react-app/shell/settings-route.tsx", import.meta.url),
    "utf8",
  );

  test("syncs when the AI tab is entered without rendering a removed cloud-provider view", () => {
    const trigger = source.slice(
      source.indexOf("void providerAuthStore.runCloudProviderSync(\"settings_cloud_opened\")") - 80,
      source.indexOf("void providerAuthStore.runCloudProviderSync(\"settings_cloud_opened\")") + 120,
    );
    expect(trigger).toContain('route.tab !== "ai"');
    expect(trigger).not.toContain('route.tab !== "cloud-providers"');
  });
});

const viewProps = (override: Partial<AiSettingsViewProps> = {}): AiSettingsViewProps => ({
  busy: false,
  providerAuthBusy: false,
  connectedProviders: [],
  disconnectingProviderId: null,
  providerConnectError: null,
  providerDisconnectError: null,
  onOpenProviderAuth: () => undefined,
  onDisconnectProvider: () => undefined,
  onDeleteProvider: () => true,
  onEditLocalProvider: () => undefined,
  canDisconnectProvider: () => true,
  canDeleteProvider: () => true,
  deletingProviderId: null,
  orgManagedProviders: [],
  orgProviderSyncError: null,
  ...override,
});

describe("AI settings organization directory presentation", () => {
  test("shows an organization error even when the first directory load has no rows", () => {
    const html = renderToStaticMarkup(<AiSettingsView {...viewProps({ orgProviderSyncError: "directory failed" })} />);
    expect(html).toContain("directory failed");
    expect(html).toContain("Organization-managed model groups");
  });

  test("renders the source provider icon identity while preserving the cloud row id", () => {
    const html = renderToStaticMarkup(<AiSettingsView {...viewProps({
      orgManagedProviders: [{
        id: "lpr_opaque",
        sourceProviderId: "openai",
        name: "Production",
        connected: false,
        syncState: "pending",
        modelCount: 1,
      }],
    })} />);
    expect(html).toContain("lpr_opaque");
    expect(html).toContain("Syncing");
    expect(html).toContain("1 model");
  });
});
