import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { callOpenAiImageGenerationExtensionAction } from "./openai-image-generation.js";
import { cloudGatewayCredentialEnvName, cloudGatewayMirrorEnvName, cloudGatewayMirrorOwnerId, cloudProviderConfigFingerprint } from "@jugglework/types/provider-credentials";
import { writeRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import { writeJuggleWorkWorkspaceConfig } from "../jugglework-workspace-config-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); mock.restore(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "jugglework-image-generation-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const config = {
    configPath: join(root, "jugglework.json"),
    workspaces: [{ id: "ws", name: "Workspace", path: workspace, preset: "", workspaceType: "local" }],
  } as never;
  const env = { list: async () => [{ key: "CUSTOM_IMAGES_API_KEY", value: "secret" }] } as never;
  return { root, workspace, config, env, context: { workspaceId: "ws" } };
}

async function writeRuntime(config: never) {
  await writeRuntimeOpencodeConfig(config, "ws", () => ({
    provider: {
      images: {
        npm: "@ai-sdk/openai-compatible",
        name: "Images",
        env: ["CUSTOM_IMAGES_API_KEY"],
        options: { baseURL: "https://images.example.test/v1" },
        models: {
          painter: {
            name: "Painter",
            imageGeneration: {
              protocol: "openai", textToImage: true, imageToImage: true, multiImageToImage: true,
              inputImage: { mimeTypes: ["image/png"], maxBytes: 25_000_000, maxCount: 16 },
              outputImage: { mimeTypes: ["image/png"] },
            },
          },
        },
      },
    },
  }));
}

describe("configured OpenAI image generation", () => {
  test("generates a validated workspace PNG with the configured model", async () => {
    const fx = await fixture();
    await writeRuntime(fx.config);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://images.example.test/v1/images/generations");
      expect(JSON.parse(String(init.body))).toMatchObject({ model: "painter", prompt: "a cat" });
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    }) as never;
    try {
      const response = await callOpenAiImageGenerationExtensionAction(fx.config, fx.env, "image_generate", { prompt: "a cat", mode: "text-to-image", filename: "cat" }, fx.context) as { path: string };
      expect(response.path).toBe("artifacts/cat.png");
      expect(await readFile(join(fx.workspace, response.path))).toEqual(png);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("submits every validated reference image for multi-image edit", async () => {
    const fx = await fixture();
    await writeRuntime(fx.config);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(join(fx.workspace, "one.png"), png);
    await writeFile(join(fx.workspace, "two.png"), png);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://images.example.test/v1/images/edits");
      expect(init.body).toBeInstanceOf(FormData);
      expect((init.body as FormData).getAll("image[]")).toHaveLength(2);
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    }) as never;
    try {
      const response = await callOpenAiImageGenerationExtensionAction(fx.config, fx.env, "image_generate", { prompt: "combine", mode: "multi-image-to-image", sourceImagePaths: ["one.png", "two.png"] }, fx.context) as { result: { mode: string } };
      expect(response.result.mode).toBe("multi-image-to-image");
    } finally { globalThis.fetch = originalFetch; }
  });

  test("reports a reserved cloud credential ready only with its workspace import baseline", async () => {
    const fx = await fixture();
    const owner = { workspaceId: "ws", organizationId: "org_current", cloudProviderId: "lpr_images" };
    const mirrorKey = cloudGatewayMirrorEnvName(owner);
    const providerConfig = {
      npm: "@ai-sdk/openai-compatible",
      name: "Cloud Images",
      env: [cloudGatewayCredentialEnvName("lpr_images")],
      options: { baseURL: "https://images.example.test/v1" },
      models: { painter: { imageGeneration: { protocol: "openai", textToImage: true } } },
    };
    await writeRuntimeOpencodeConfig(fx.config, "ws", () => ({ provider: {
      lpr_images: providerConfig,
    } }));
    await writeJuggleWorkWorkspaceConfig(fx.config, "ws", () => ({ cloudImports: { providers: {
      lpr_images: {
        cloudProviderId: "lpr_images", providerId: "lpr_images", sourceProviderId: "openai",
        name: "Cloud Images", source: "custom", updatedAt: null, modelIds: ["painter"],
        importedAt: Date.now(), metadataVersion: 10, organizationId: "org_current",
        providerConfigFingerprint: cloudProviderConfigFingerprint(providerConfig), gatewayMirror: { ...owner, key: mirrorKey },
      },
    } } }));
    const env = { list: async () => [{ key: mirrorKey, value: "gateway-secret", owner: cloudGatewayMirrorOwnerId(owner) }] } as never;
    const ready = await callOpenAiImageGenerationExtensionAction(fx.config, env, "image_models_list", { mode: "text-to-image" }, fx.context) as { result: { models: unknown[] } };
    expect(ready.result.models).toHaveLength(1);

    await writeJuggleWorkWorkspaceConfig(fx.config, "ws", (current) => ({ ...current, cloudImports: { providers: {} } }));
    const isolated = await callOpenAiImageGenerationExtensionAction(fx.config, env, "image_models_list", { mode: "text-to-image" }, fx.context) as { result: { models: unknown[] } };
    expect(isolated.result.models).toHaveLength(0);
  });

  test("status and list expose only public model fields and never inline provider secrets", async () => {
    const fx = await fixture();
    const inlineSecret = "be459a45-01ef-47ad-8184-7e937dcb9b86.eyJhbGciOiJIUzI1NiJ9.signature";
    await writeRuntimeOpencodeConfig(fx.config, "ws", () => ({ provider: { images: {
      npm: "@ai-sdk/openai-compatible", name: "Images", env: ["CUSTOM_IMAGES_API_KEY"],
      options: { baseURL: "https://images.example.test/v1", apiKey: inlineSecret },
      models: { painter: { name: "Painter", imageGeneration: { protocol: "openai", textToImage: true } } },
    } } }));
    for (const action of ["status", "image_models_list"]) {
      const response = await callOpenAiImageGenerationExtensionAction(fx.config, fx.env, action, {}, fx.context);
      const serialized = JSON.stringify(response);
      expect(serialized).not.toContain("providerConfig");
      expect(serialized).not.toContain("baseURL");
      expect(serialized).not.toContain("envKeys");
      expect(serialized).not.toContain(inlineSecret);
    }
  });

  test("status, list, and generation share case-insensitive disabled-provider filtering", async () => {
    const fx = await fixture();
    await writeRuntimeOpencodeConfig(fx.config, "ws", () => ({
      disabled_providers: ["ImAgEs"],
      provider: {
        images: {
          npm: "@ai-sdk/openai-compatible",
          name: "Images",
          env: ["CUSTOM_IMAGES_API_KEY"],
          options: { baseURL: "https://images.example.test/v1" },
          models: { painter: { imageGeneration: { protocol: "openai", textToImage: true } } },
        },
      },
    }));

    const status = await callOpenAiImageGenerationExtensionAction(fx.config, fx.env, "status", {}, fx.context) as { result: { configured: boolean; models: unknown[] } };
    const list = await callOpenAiImageGenerationExtensionAction(fx.config, fx.env, "image_models_list", { mode: "text-to-image" }, fx.context) as { result: { models: unknown[] } };
    const generate = await callOpenAiImageGenerationExtensionAction(fx.config, fx.env, "image_generate", { prompt: "cat" }, fx.context) as { ok: boolean; error: string };

    expect(status.result).toMatchObject({ configured: false, models: [] });
    expect(list.result.models).toEqual([]);
    expect(generate).toMatchObject({ ok: false, error: "no_image_model_available" });
  });

  test("project-only disabled providers are excluded from image status, list, and generation", async () => {
    const fx = await fixture();
    await writeRuntime(fx.config);
    await writeFile(join(fx.workspace, "opencode.jsonc"), JSON.stringify({ disabled_providers: ["IMAGES"] }));
    const status = await callOpenAiImageGenerationExtensionAction(fx.config, fx.env, "status", {}, fx.context) as { result: { configured: boolean; models: unknown[] } };
    const list = await callOpenAiImageGenerationExtensionAction(fx.config, fx.env, "image_models_list", { mode: "text-to-image" }, fx.context) as { result: { models: unknown[] } };
    const generate = await callOpenAiImageGenerationExtensionAction(fx.config, fx.env, "image_generate", { prompt: "cat" }, fx.context) as { ok: boolean; error: string };
    expect(status.result).toMatchObject({ configured: false, models: [] });
    expect(list.result.models).toEqual([]);
    expect(generate).toMatchObject({ ok: false, error: "no_image_model_available" });
  });

  test("redacts the exact arbitrary resolved credential from provider errors", async () => {
    const fx = await fixture();
    await writeRuntime(fx.config);
    const secret = "be459a45-01ef-47ad-8184-7e937dcb9b86.eyJhbGciOiJIUzI1NiJ9.signature";
    const env = { list: async () => [{ key: "CUSTOM_IMAGES_API_KEY", value: secret }] } as never;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => Response.json({ error: { message: `credential ${secret} rejected` } }, { status: 401 })) as never;
    try {
      await expect(callOpenAiImageGenerationExtensionAction(fx.config, env, "image_generate", { prompt: "cat" }, fx.context)).rejects.toThrow("credential [REDACTED] rejected");
    } finally { globalThis.fetch = originalFetch; }
  });
});
