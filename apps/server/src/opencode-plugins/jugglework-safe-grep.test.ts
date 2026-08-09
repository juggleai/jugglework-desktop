import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

  test("narrows broad and generated-file includes to avoid oversized records", async () => {
    const plugin = await JuggleWorkSafeGrep();
    const generated: { args: Record<string, unknown> } = {
      args: { pattern: "needle", include: "**/*.{js,map,html}" },
    };
    const minified: { args: Record<string, unknown> } = {
      args: { pattern: "needle", include: "**/*.min.js" },
    };

    await plugin["tool.execute.before"]({ tool: "grep" }, generated);
    await plugin["tool.execute.before"]({ tool: "grep" }, minified);

    expect(generated.args.include).toBeDefined();
    expect(generated.args.include).not.toContain("html");
    expect(minified.args.include).not.toBe("**/*.min.js");
  });

  test("module exposes only the plugin factory", async () => {
    const mod = await import("./jugglework-safe-grep.js");
    expect(Object.keys(mod)).toEqual(["JuggleWorkSafeGrep"]);
  });

  test("refuses whole-home searches with retry guidance", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "jugglework-safe-glob-workspace-"));
    const plugin = await JuggleWorkSafeGrep({ directory: workspace });
    const output = JSON.parse(await plugin.tool.jugglework_safe_glob.execute({
      pattern: "**/bin/go",
      path: process.env.HOME,
    })) as Record<string, unknown>;

    expect(output.ok).toBe(false);
    expect(output.code).toBe("unsafe_search_root");
    expect(output.retryable).toBe(true);
    await rm(workspace, { recursive: true, force: true });
  });

  test("terminates a stalled search and returns a retryable timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-safe-glob-"));
    const command = join(root, "slow-search.sh");
    await mkdir(join(root, "workspace"));
    await writeFile(command, "#!/bin/sh\ntrap 'exit 0' TERM\nsleep 30\n", "utf8");
    await chmod(command, 0o755);
    const previousCommand = process.env.JUGGLEWORK_SAFE_GLOB_COMMAND;
    const previousTimeout = process.env.JUGGLEWORK_SAFE_GLOB_TIMEOUT_MS;
    process.env.JUGGLEWORK_SAFE_GLOB_COMMAND = command;
    process.env.JUGGLEWORK_SAFE_GLOB_TIMEOUT_MS = "25";
    try {
      const plugin = await JuggleWorkSafeGrep({ directory: join(root, "workspace") });
      const started = Date.now();
      const output = JSON.parse(await plugin.tool.jugglework_safe_glob.execute({ pattern: "**/*.go" })) as Record<string, unknown>;
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(output.ok).toBe(false);
      expect(output.code).toBe("glob_timeout");
      expect(output.retryable).toBe(true);
    } finally {
      if (previousCommand === undefined) delete process.env.JUGGLEWORK_SAFE_GLOB_COMMAND;
      else process.env.JUGGLEWORK_SAFE_GLOB_COMMAND = previousCommand;
      if (previousTimeout === undefined) delete process.env.JUGGLEWORK_SAFE_GLOB_TIMEOUT_MS;
      else process.env.JUGGLEWORK_SAFE_GLOB_TIMEOUT_MS = previousTimeout;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("is registered in runtime config and bundled by the build script", async () => {
    const runtime = await buildJuggleWorkRuntimeConfigObject();
    if (!Array.isArray(runtime.plugin)) throw new Error("Expected plugin list");
    expect(runtime.plugin).toContain(juggleworkSafeGrepPluginPath());
    expect((runtime.permission as Record<string, unknown>).glob).toBe("deny");

    const packageJson = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      scripts?: { build?: unknown };
    };
    expect(packageJson.scripts?.build).toContain("jugglework-safe-grep.ts");
  });
});
