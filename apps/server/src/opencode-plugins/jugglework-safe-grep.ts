/**
 * JuggleWork Safe Search Plugin
 *
 * OpenCode's built-in grep uses ripgrep JSON output. A match in a generated
 * or minified file can make one JSON record exceed the engine's 64 KiB safety
 * limit, which aborts an otherwise ordinary code search. When an agent did
 * not request a file filter, search the source/config formats that are useful
 * for code work by default. Explicit includes are preserved unless they are
 * broad/generated-file patterns that are known to produce oversized records.
 */

import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, parse, relative, resolve } from "node:path";
import { z } from "zod";

const DEFAULT_CODE_SEARCH_INCLUDE = "*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,kts,swift,rb,php,cs,c,cc,cpp,cxx,h,hpp,hxx,vue,svelte,md,mdx,json,jsonc,yaml,yml,toml,xml,sql,sh,bash,zsh,fish,ps1,gradle}";
const UNSAFE_INCLUDE_PATTERN = /(^|[/\\])\*($|[/\\])|\*\.\{?[^}]*\b(html?|map|css)\b|\*\.(?:min|bundle)\.[^,}]+/i;

type ToolArgs = Record<string, unknown>;

type OpenCodeContext = {
  abort?: AbortSignal;
  directory?: string;
  worktree?: string;
};

const safeGlobArgsSchema = z.object({
  pattern: z.string().trim().min(1),
  path: z.string().trim().optional(),
});

const SAFE_GLOB_TIMEOUT_MS = 20_000;
const SAFE_GLOB_RESULT_LIMIT = 100;
const SAFE_GLOB_EXCLUDES = [
  "!**/.git/**",
  "!**/node_modules/**",
  "!**/.next/**",
  "!**/dist/**",
  "!**/build/**",
  "!**/coverage/**",
];

function contextFrom(value: unknown): OpenCodeContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    abort: record.abort instanceof AbortSignal ? record.abort : undefined,
    directory: typeof record.directory === "string" ? record.directory : undefined,
    worktree: typeof record.worktree === "string" ? record.worktree : undefined,
  };
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function timeoutMs(): number {
  const configured = Number(process.env.JUGGLEWORK_SAFE_GLOB_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 10
    ? Math.min(configured, SAFE_GLOB_TIMEOUT_MS)
    : SAFE_GLOB_TIMEOUT_MS;
}

async function executablePath(): Promise<string | null> {
  const candidates = [
    process.env.JUGGLEWORK_SAFE_GLOB_COMMAND,
    typeof Bun !== "undefined" ? Bun.which("rg") : null,
    resolve(homedir(), ".cache/opencode/bin/rg"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next stable location.
    }
  }
  return null;
}

async function stopProcess(process: Bun.Subprocess): Promise<void> {
  try {
    process.kill("SIGTERM");
  } catch {
    return;
  }
  const exited = await Promise.race([
    process.exited.then(() => true),
    new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 250)),
  ]);
  if (!exited) {
    try {
      process.kill("SIGKILL");
    } catch {
      // The process exited between checks.
    }
  }
}

async function runSafeGlob(input: {
  command: string;
  cwd: string;
  pattern: string;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const command = [
    input.command,
    "--no-config",
    "--files",
    "--hidden",
    "--glob",
    input.pattern,
    ...SAFE_GLOB_EXCLUDES.flatMap((pattern) => ["--glob", pattern]),
    ".",
  ];
  const child = Bun.spawn(command, {
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let timedOut = false;
  let aborted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void stopProcess(child);
  }, timeoutMs());
  const onAbort = () => {
    aborted = true;
    void stopProcess(child);
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });

  const exitCode = await child.exited;
  clearTimeout(timer);
  input.signal?.removeEventListener("abort", onAbort);
  const [output, errorOutput] = await Promise.all([stdout, stderr]);

  if (aborted) {
    return {
      ok: false,
      code: "glob_cancelled",
      retryable: false,
      message: "The search was cancelled with the current run.",
    };
  }
  if (timedOut) {
    return {
      ok: false,
      code: "glob_timeout",
      retryable: true,
      timeoutMs: timeoutMs(),
      message: "The search exceeded JuggleWork's safety deadline and its process was stopped. Retry with a narrower path or pattern; do not repeat a whole-home search.",
    };
  }
  // ripgrep uses 1 for a valid search with no matches.
  if (exitCode !== 0 && exitCode !== 1) {
    return {
      ok: false,
      code: "glob_failed",
      retryable: true,
      message: errorOutput.trim() || `ripgrep exited with status ${exitCode}`,
    };
  }

  const files = output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const truncated = files.length > SAFE_GLOB_RESULT_LIMIT;
  return {
    ok: true,
    root: input.cwd,
    files: files.slice(0, SAFE_GLOB_RESULT_LIMIT).map((file) => resolve(input.cwd, file)),
    truncated,
    ...(truncated ? { message: "Results were limited to 100 files. Narrow the path or pattern for a complete result." } : {}),
  };
}

function hasExplicitInclude(args: ToolArgs): boolean {
  return typeof args.include === "string" && args.include.trim().length > 0;
}

function hasUnsafeInclude(args: ToolArgs): boolean {
  return typeof args.include === "string" && UNSAFE_INCLUDE_PATTERN.test(args.include);
}

// Single export: the OpenCode plugin loader treats every export as a plugin
// factory, so helpers must stay module-private.
export const JuggleWorkSafeGrep = async (factoryInput?: unknown) => ({
  "tool.execute.before": async (
    input: { tool?: unknown },
    output: { args?: unknown },
  ) => {
    if (input.tool !== "grep") return;
    if (typeof output.args !== "object" || output.args === null || Array.isArray(output.args)) return;
    const args = output.args as ToolArgs;
    // An explicit source-file include is respected. Broad globs and common
    // generated-file patterns are narrowed because one long line can become
    // a single ripgrep JSON record larger than OpenCode's 64 KiB limit.
    if (hasExplicitInclude(args) && !hasUnsafeInclude(args)) return;
    args.include = DEFAULT_CODE_SEARCH_INCLUDE;
  },
  tool: {
    jugglework_safe_glob: {
      description: "Safely find files inside the current JuggleWork workspace. This replaces the unbounded built-in glob: it rejects whole-home/filesystem searches, excludes generated dependency trees, stops the search process after 20 seconds, and returns retryable guidance instead of hanging. If retryable=true, narrow path or pattern before retrying.",
      args: safeGlobArgsSchema.shape,
      async execute(rawArgs: unknown, executeContext?: unknown) {
        const args = safeGlobArgsSchema.parse(rawArgs);
        const context = { ...contextFrom(factoryInput), ...contextFrom(executeContext) };
        const base = context.directory ?? context.worktree;
        if (!base) {
          return JSON.stringify({
            ok: false,
            code: "workspace_unavailable",
            retryable: true,
            message: "JuggleWork could not resolve the current workspace. Retry after selecting a workspace.",
          }, null, 2);
        }

        let workspaceRoot: string;
        let searchRoot: string;
        try {
          workspaceRoot = await realpath(base);
          searchRoot = await realpath(args.path ? resolve(base, args.path) : base);
        } catch {
          return JSON.stringify({
            ok: false,
            code: "search_path_unavailable",
            retryable: true,
            message: "The search path does not exist or is not readable. Retry with an existing workspace subdirectory.",
          }, null, 2);
        }

        const dangerousRoots = new Set([
          parse(searchRoot).root,
          homedir(),
          tmpdir(),
        ]);
        if (!isInside(workspaceRoot, searchRoot) || dangerousRoots.has(searchRoot)) {
          return JSON.stringify({
            ok: false,
            code: "unsafe_search_root",
            retryable: true,
            suggestedPath: workspaceRoot,
            message: "JuggleWork refused an unbounded or out-of-workspace search. Retry inside the current workspace or a narrower subdirectory.",
          }, null, 2);
        }

        const command = await executablePath();
        if (!command) {
          return JSON.stringify({
            ok: false,
            code: "search_engine_unavailable",
            retryable: true,
            message: "The bounded search engine is unavailable. Retry after restarting the workspace runtime.",
          }, null, 2);
        }
        return JSON.stringify(await runSafeGlob({
          command,
          cwd: searchRoot,
          pattern: args.pattern,
          signal: context.abort,
        }), null, 2);
      },
    },
  },
});
