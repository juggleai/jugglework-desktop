#!/usr/bin/env node

/**
 * jugglework-vision-mcp — multi-provider image recognition MCP server
 *
 * Exposes image recognition tools backed by Qwen-VL, OpenAI GPT-4o, Gemini,
 * Claude, OpenRouter, Ollama, or any OpenAI-compatible endpoint. When an image
 * is attached to a session, the model can call these tools for deep recognition:
 * OCR, scene description, chart data extraction, and so on.
 *
 * Usage:
 *   npx jugglework-vision-mcp
 *
 * MCP config (opencode.jsonc / Claude Desktop / Cursor):
 *   {
 *     "mcp": {
 *       "vision": {
 *         "type": "local",
 *         "command": ["npx", "-y", "jugglework-vision-mcp"],
 *         "enabled": true,
 *         "environment": {
 *           "VISION_PROVIDER": "dashscope",
 *           "DASHSCOPE_API_KEY": "sk-xxx",
 *           "VISION_MODEL": "qwen-vl-max"
 *         }
 *       }
 *     }
 *   }
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  PROVIDER_PRESETS,
  callVision,
  maxImageBytes,
  resolveProvider,
  validateProvider,
} from "./providers.mjs";

const packageManifest = JSON.parse(
  await readFile(new URL("./package.json", import.meta.url), "utf8"),
);

const server = new McpServer({ name: "vision", version: packageManifest.version });

// ── Image loading ──

/** Extensions the OpenAI-compatible image_url payload accepts. */
const IMAGE_MIME_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

/**
 * Turn a tool argument into a filesystem path.
 *
 * TIPS: Attachments arrive as file:// URLs, and a filename containing a space
 * reaches us percent-encoded. Stripping the scheme textually leaves "%20" in the
 * path and the read fails, so the URL parser has to do the decoding.
 *
 * @param {string} input Absolute path or file:// URL.
 * @returns {string} Filesystem path.
 */
function resolveImagePath(input) {
  const value = input.trim();
  if (!/^file:\/\//i.test(value)) return value;
  try {
    return fileURLToPath(value);
  } catch {
    return decodeURIComponent(value.replace(/^file:\/\//i, ""));
  }
}

/**
 * Infer the MIME type from a filename.
 *
 * @param {string} filename File path or name.
 * @returns {string | null} MIME type, or null when the extension is not a supported image.
 */
function inferMime(filename) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MIME_TYPES[ext] ?? null;
}

/**
 * Read an image and prepare it for the vision call.
 *
 * @param {string} input Absolute path or file:// URL.
 * @returns {Promise<{ ok: true, base64: string, mime: string, filename: string } | { ok: false, error: string }>}
 */
async function loadImage(input) {
  const filePath = resolveImagePath(input);
  const filename = filePath.split("/").pop() || filePath;

  const mime = inferMime(filePath);
  if (!mime) {
    const supported = Object.keys(IMAGE_MIME_TYPES).join(", ");
    return { ok: false, error: `Unsupported image type: ${filename}. Supported extensions: ${supported}.` };
  }

  let buffer;
  try {
    buffer = await readFile(filePath);
  } catch {
    return { ok: false, error: `Cannot read image: ${filePath}` };
  }

  // TIPS: Checked before encoding — base64 grows the payload by 4/3, and an
  // oversized body comes back from the gateway as an opaque 413.
  const limit = maxImageBytes();
  if (buffer.byteLength > limit) {
    const actual = (buffer.byteLength / 1024 / 1024).toFixed(1);
    const allowed = (limit / 1024 / 1024).toFixed(1);
    return {
      ok: false,
      error: `Image is ${actual} MB, over the ${allowed} MB limit. Resize it, or raise VISION_MAX_IMAGE_BYTES if the endpoint accepts more.`,
    };
  }

  return { ok: true, base64: buffer.toString("base64"), mime, filename };
}

/** Build an error tool result. */
function toolError(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

// ── Tool: recognize one image ──

const DEFAULT_PROMPTS = {
  low: "Briefly describe the main content of this image.",
  auto: "Analyze this image:\n1. Extract all visible text (OCR)\n2. Describe the main content\n3. If it is a chart or screenshot, summarize the key information",
  high: "Analyze this image in detail:\n1. Extract all visible text verbatim (OCR)\n2. Identify the image type (screenshot / photo / chart / document)\n3. List the key information (titles, data, UI elements, people, scene)\n4. If it is a code screenshot, reconstruct the code",
};

server.tool(
  "recognize_image",
  "Recognize the content of an image and return it as text. Handles OCR text extraction, scene description, and chart data interpretation. Use it for screenshots, photos, and scanned documents attached to the session.",
  {
    path: z.string().describe("Image path (workspace absolute path or file:// URL)"),
    prompt: z.string().optional().describe("Custom instruction, e.g. extract all text / describe the chart data / what is wrong in this screenshot"),
    detail: z.enum(["auto", "low", "high"]).optional().describe("Level of detail, defaults to auto"),
  },
  async ({ path, prompt, detail }) => {
    const config = resolveProvider();
    const check = validateProvider(config);
    if (!check.ok) return toolError(check.error);

    const image = await loadImage(path);
    if (!image.ok) return toolError(image.error);

    // TIPS: low suits bulk passes over many images, high suits precise OCR.
    const instruction = prompt || DEFAULT_PROMPTS[detail || "auto"];

    try {
      const result = await callVision(config, instruction, image.base64, image.mime);
      return {
        content: [{ type: "text", text: `[${config.label} · ${config.model}]\n\n${result}` }],
      };
    } catch (error) {
      return toolError(`Recognition failed: ${error.message}`);
    }
  },
);

// ── Tool: recognize several images ──

server.tool(
  "recognize_images",
  "Recognize several images in one call. Each image is processed independently and the results are returned together.",
  {
    paths: z.array(z.string()).describe("Image paths (absolute paths or file:// URLs)"),
    prompt: z.string().optional().describe("Instruction applied to every image"),
  },
  async ({ paths, prompt }) => {
    const config = resolveProvider();
    const check = validateProvider(config);
    if (!check.ok) return toolError(check.error);

    const instruction = prompt || "Analyze this image: extract all visible text (OCR) and describe the main content.";
    const results = [];

    for (const imagePath of paths) {
      const image = await loadImage(imagePath);
      if (!image.ok) {
        results.push(`### ${imagePath.split("/").pop()}\n\nError: ${image.error}`);
        continue;
      }
      try {
        const result = await callVision(config, instruction, image.base64, image.mime);
        results.push(`### ${image.filename}\n\n${result}`);
      } catch (error) {
        results.push(`### ${image.filename}\n\nError: recognition failed — ${error.message}`);
      }
    }

    return { content: [{ type: "text", text: results.join("\n\n---\n\n") }] };
  },
);

// ── Tool: inspect current configuration ──

server.tool(
  "vision_status",
  "Report the current vision provider configuration: which model is in use and whether it is ready.",
  {},
  async () => {
    const config = resolveProvider();
    const check = validateProvider(config);
    // The key is masked: this output reaches the model and the transcript.
    const maskedKey = config.apiKey
      ? `${config.apiKey.slice(0, 6)}***${config.apiKey.slice(-4)}`
      : "(not set)";
    return {
      content: [{
        type: "text",
        text: [
          `Provider: ${config.provider} (${config.label})`,
          `Base URL: ${config.baseURL || "(not set)"}`,
          `Model: ${config.model || "(not set)"}`,
          `API key: ${maskedKey}`,
          `Status: ${check.ok ? "ready" : `not ready — ${check.error}`}`,
        ].join("\n"),
      }],
    };
  },
);

// ── Tool: list supported providers ──

server.tool(
  "vision_providers",
  "List every supported vision provider and how to configure it.",
  {},
  async () => {
    const lines = ["Supported providers:", ""];
    for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
      lines.push(`**${key}** — ${preset.label}`);
      lines.push(`  baseURL: ${preset.baseURL || "(set VISION_BASE_URL)"}`);
      lines.push(`  default model: ${preset.defaultModel || "(set VISION_MODEL)"}`);
      lines.push(`  API key variable: ${preset.envKey}${preset.needsKey ? " (required)" : " (optional)"}`);
      lines.push("");
    }
    lines.push("To switch: set VISION_PROVIDER=<key>, or just set that provider's API key variable and it is detected automatically.");
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// ── Start ──

await server.connect(new StdioServerTransport());
