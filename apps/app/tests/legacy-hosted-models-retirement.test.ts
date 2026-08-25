import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const source = (relativePath: string) => readFileSync(
  new URL(`../${relativePath}`, import.meta.url),
  "utf8",
);

const filesUnder = (url: URL): URL[] => readdirSync(url, { withFileTypes: true }).flatMap(
  (entry) => {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, url);
    return entry.isDirectory() ? filesUnder(child) : [child];
  },
);

describe("legacy hosted model retirement", () => {
  test("removes every desktop promotion surface", () => {
    for (const relativePath of [
      "src/react-app/domains/cloud/jugglework-models-promo.ts",
      "src/react-app/domains/cloud/jugglework-models-startup-dialog.tsx",
      "src/react-app/domains/cloud/use-jugglework-models-startup-promo.ts",
    ]) {
      expect(existsSync(new URL(`../${relativePath}`, import.meta.url))).toBe(false);
    }

    const statusBar = source("src/react-app/domains/session/chat/status-bar.tsx");
    expect(statusBar).not.toContain("JuggleWork Models");
    expect(statusBar).not.toContain("jugglework-models-promo");
  });

  test("removes the legacy hosted inference type module and publication entries", () => {
    expect(existsSync(new URL(
      "../../../packages/types/src/den/inference.ts",
      import.meta.url,
    ))).toBe(false);

    const rootExports = source("../../packages/types/src/index.ts");
    const packageJson = source("../../packages/types/package.json");
    const tsupConfig = source("../../packages/types/tsup.config.ts");

    expect(rootExports).not.toContain("./den/inference");
    expect(packageJson).not.toContain("./den/inference");
    expect(tsupConfig).not.toContain('"den/inference"');
    expect(tsupConfig).not.toContain("src/den/inference.ts");
  });

  test("removes retired hosted inference contracts from active evals", () => {
    const evalRoot = new URL("../../../evals/", import.meta.url);
    const retired = /JuggleWork Models|Continue without JuggleWork Models|Use JuggleWork Models|hosted subscription|\/inference|juggleworkModelsPromo|jugglework-jugglework-models-promo-changed/;
    const rootContracts = readdirSync(evalRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:md|json|ya?ml|ts)$/.test(entry.name))
      .map((entry) => new URL(entry.name, evalRoot));
    const activeContracts = [
      ...rootContracts,
      ...filesUnder(new URL("flows/", evalRoot)),
      ...filesUnder(new URL("voiceovers/", evalRoot)),
    ].filter((url) => /\.(?:mjs|md|json|ya?ml|ts)$/.test(url.pathname));
    const offenders = activeContracts.flatMap((url) => {
      const text = readFileSync(url, "utf8");
      return retired.test(text) ? [url.pathname.slice(evalRoot.pathname.length)] : [];
    });

    expect(offenders).toEqual([]);
    expect(existsSync(new URL(
      "../../../evals/flows/jugglework-models-hidden-single-org-dashboard.flow.mjs",
      import.meta.url,
    ))).toBe(false);
    expect(existsSync(new URL(
      "../../../evals/flows/jugglework-models-voice-funnel.flow.mjs",
      import.meta.url,
    ))).toBe(false);
    expect(existsSync(new URL(
      "../../../evals/flows/voice-session-context.flow.mjs",
      import.meta.url,
    ))).toBe(true);
  });

  test("retains stale-provider compatibility guards", () => {
    const den = source("src/app/lib/den.ts");
    const cloudProviderConfig = source(
      "src/react-app/domains/connections/provider-auth/cloud-provider-config.ts",
    );
    const modelSelect = source("src/components/model-select.tsx");
    const modelPicker = source(
      "src/react-app/domains/session/modals/model-picker-modal.tsx",
    );
    const automationPage = source(
      "src/react-app/domains/automations/automation-page.tsx",
    );

    expect(den).toContain('value.source !== "jugglework"');
    expect(cloudProviderConfig).toContain('provider.source !== "jugglework"');
    expect(cloudProviderConfig).toContain('provider.providerId.trim().toLowerCase() !== "jugglework"');
    expect(cloudProviderConfig).toContain('providerId.trim().toLowerCase() === "jugglework"');
    expect(modelSelect).toContain('option.providerID.trim().toLowerCase() === "jugglework"');
    expect(modelPicker).toContain('option.providerID.trim().toLowerCase() !== "jugglework"');
    expect(automationPage).toContain('item.providerId.trim().toLowerCase() === "jugglework"');
  });

  test("does not alter the independent Voice Mode broker contract", () => {
    const server = source("../server/src/server.ts");
    const envFile = source("../server/src/env-file.ts");

    expect(server).toContain("jugglework_models_voice_failed");
    expect(server).toContain("JUGGLEWORK_MODELS_API_KEY");
    expect(envFile).toContain('"JUGGLEWORK_MODELS_API_KEY"');
    expect(envFile).toContain('"JUGGLEWORK_MODELS_BASE_URL"');
  });
});
