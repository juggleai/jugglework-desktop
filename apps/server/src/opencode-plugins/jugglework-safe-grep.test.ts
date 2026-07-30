import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { juggleworkSafeGrepPluginPath } from "../jugglework-extensions-plugin-path.js";
import { buildJuggleWorkRuntimeConfigObject } from "../jugglework-runtime-config.js";
import { JuggleWorkSafeGrep } from "./jugglework-safe-grep.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("JuggleWork Safe Grep Plugin", () => {
  test("adds a source/config filter to unscoped grep calls", async () => {
    const plugin = await JuggleWorkSafeGrep();
    const output: { args: Record<string, unknown> } = {
      args: { pattern: "scriptPlan", path: "/workspace" },
    };

    await plugin["tool.execute.before"]({ tool: "grep" }, output);

    expect(output.args.include).toContain("ts");
    expect(output.args.include).toContain("yaml");
    expect(output.args.include).not.toContain("html");
  });

  test("preserves explicit grep includes and non-grep calls", async () => {
    const plugin = await JuggleWorkSafeGrep();
    const explicit: { args: Record<string, unknown> } = {
      args: { pattern: "needle", include: "data/web/index.html" },
    };
    const other: { args: Record<string, unknown> } = {
      args: { command: "rg needle" },
    };

    await plugin["tool.execute.before"]({ tool: "grep" }, explicit);
    await plugin["tool.execute.before"]({ tool: "bash" }, other);

    expect(explicit.args.include).toBe("data/web/index.html");
    expect(other.args.include).toBeUndefined();
  });

  test("module exposes only the plugin factory", async () => {
    const mod = await import("./jugglework-safe-grep.js");
    expect(Object.keys(mod)).toEqual(["JuggleWorkSafeGrep"]);
  });

  test("is registered in runtime config and bundled by the build script", async () => {
    const runtime = await buildJuggleWorkRuntimeConfigObject();
    if (!Array.isArray(runtime.plugin)) throw new Error("Expected plugin list");
    expect(runtime.plugin).toContain(juggleworkSafeGrepPluginPath());

    const packageJson = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      scripts?: { build?: unknown };
    };
    expect(packageJson.scripts?.build).toContain("jugglework-safe-grep.ts");
  });
});
