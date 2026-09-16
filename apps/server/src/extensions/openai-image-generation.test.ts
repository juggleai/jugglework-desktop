import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { callOpenAiImageGenerationExtensionAction } from "./openai-image-generation.js";
import { writeRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); mock.restore(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "jugglework-image-generation-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const config = {
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
});
