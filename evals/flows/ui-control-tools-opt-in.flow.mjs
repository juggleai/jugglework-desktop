import { execFile as execFileCallback } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const PROBE_SCRIPT = `
  const { JuggleWorkExtensionsPreview } = await import("./apps/server/src/opencode-plugins/jugglework-extensions-preview.ts");
  const plugin = await JuggleWorkExtensionsPreview();
  const output = { system: [] };
  await plugin["experimental.chat.system.transform"](undefined, output);
  console.log(JSON.stringify({ tools: Object.keys(plugin.tool).sort(), system: output.system.join("\\n") }));
`;

async function probeSemanticTools() {
  const { stdout } = await execFile("bun", ["-e", PROBE_SCRIPT], {
    cwd: ROOT,
    env: process.env,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout.trim());
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function witness(ctx, condition, assertion, actual) {
  const detail = actual === undefined ? undefined : String(actual);
  if (!condition) {
    ctx.recordEvidence({ type: "assertion", status: "failed", assertion, actual: detail });
    ctx.assert(false, assertion + (detail ? ` (actual: ${detail})` : ""));
  }
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual: detail });
}

export default {
  id: "ui-control-tools-opt-in",
  title: "Built-in JuggleWork agent surface is semantic-only",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Only semantic JuggleWork tools are registered",
      run: async (ctx) => {
        let result = null;
        await ctx.prove("The preview plugin exposes jugglework_context/query/execute only", {
          voiceover: "The bundled JuggleWork plugin no longer registers legacy session, extension, browser, or UI-control tool aliases. Agents use the three semantic tools and affordance ids from jugglework_context.",
          action: async () => {
            result = await probeSemanticTools();
            ctx.output("semantic tool surface", pretty(result));
          },
          assert: async () => {
            witness(ctx, Array.isArray(result?.tools), "The probe printed a tools array", result ? pretty(result.tools) : "null");
            witness(ctx, result.tools.join(",") === "jugglework_context,jugglework_execute,jugglework_query", "Only the three semantic tools are registered", result.tools.join(", "));
            witness(ctx, !result.tools.some((tool) => tool.startsWith("jugglework_ui_")), "Legacy jugglework_ui_* tools are gone", result.tools.join(", "));
            witness(ctx, !result.tools.some((tool) => tool.startsWith("jugglework_session_")), "Legacy jugglework_session_* tools are gone", result.tools.join(", "));
            witness(ctx, !result.system.includes("jugglework_ui_"), "The system prompt lacks jugglework_ui_ steering", result.system);
            witness(ctx, result.system.includes("jugglework_context"), "The system prompt steers toward jugglework_context", result.system);
            witness(ctx, result.system.includes("browser.open_url"), "The system prompt steers browser work through browser.open_url", result.system);
          },
        });
      },
    },
  ],
};
