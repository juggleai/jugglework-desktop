/**
 * JuggleWork Safe Grep Plugin
 *
 * OpenCode's built-in grep uses ripgrep JSON output. A match in a generated
 * or minified file can make one JSON record exceed the engine's 64 KiB safety
 * limit, which aborts an otherwise ordinary code search. When an agent did
 * not request a file filter, search the source/config formats that are useful
 * for code work by default. Explicit includes are preserved unless they are
 * broad/generated-file patterns that are known to produce oversized records.
 */

const DEFAULT_CODE_SEARCH_INCLUDE = "*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,kts,swift,rb,php,cs,c,cc,cpp,cxx,h,hpp,hxx,vue,svelte,md,mdx,json,jsonc,yaml,yml,toml,xml,sql,sh,bash,zsh,fish,ps1,gradle}";
const UNSAFE_INCLUDE_PATTERN = /(^|[/\\])\*($|[/\\])|\*\.\{?[^}]*\b(html?|map|css)\b|\*\.(?:min|bundle)\.[^,}]+/i;

type ToolArgs = Record<string, unknown>;

function hasExplicitInclude(args: ToolArgs): boolean {
  return typeof args.include === "string" && args.include.trim().length > 0;
}

function hasUnsafeInclude(args: ToolArgs): boolean {
  return typeof args.include === "string" && UNSAFE_INCLUDE_PATTERN.test(args.include);
}

// Single export: the OpenCode plugin loader treats every export as a plugin
// factory, so helpers must stay module-private.
export const JuggleWorkSafeGrep = async () => ({
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
});
