export type CompletionShell = "bash" | "zsh" | "fish" | "powershell";

type CommandHelp = { summary: string; usage: string; commands?: Record<string, string>; options?: string[] };

const GLOBAL_OPTIONS = [
  "-C, --workspace <path>       Workspace directory (default: current directory)",
  "    --workspace-id <id>      Workspace ID when connecting to an existing Server",
  "    --server <url>           Connect to an existing JuggleWork Server",
  "    --token <token>          Server bearer token",
  "    --host-token <token>     Host token for connected host-authorized operations",
  "    --cloud-url <url>        Cloud deployment (default: https://work.jugglechat.cn)",
  "    --opencode-bin <path>    OpenCode executable for local mode",
  "    --plugin-dir <path>      JuggleWork OpenCode plugin directory",
  "-m, --model <provider/model> Model for submitted prompts",
  "-a, --agent <name>           Agent for submitted prompts",
  "    --reasoning-effort <n>   Model reasoning effort",
  "    --sandbox <mode>         workspace-write or danger-full-access",
  "    --approval <policy>      on-request or never",
  "    --full-access            Deprecated expert alias for both dangerous dimensions",
  "    --dangerously-bypass-approvals-and-sandbox",
  "                              Expert-only Full access request; Server policy remains authoritative",
  "    --force                  Skip deletion confirmation with an exact session ID",
  "-c, --continue               Resume the latest session",
  "    --title <text>           Title for a new session",
  "    --timeout <seconds>      Per-run timeout (default: 1800)",
  "    --config <path>          CLI config file",
  "    --json                   Emit machine-readable JSON/NDJSON",
  "    --no-color               Disable ANSI color",
  "-h, --help                   Show contextual help",
  "-V, --version                Show version",
];

const HELP_TREE: Record<string, CommandHelp> = {
  "": {
    summary: "Run JuggleWork tasks and manage JuggleWork Cloud.",
    usage: "jugglework [options] [prompt]\n  jugglework <command> [options]",
    commands: {
      exec: "Run one deterministic non-interactive task", session: "Manage the persisted session lifecycle", resume: "Alias for session resume", fork: "Alias for session fork", sessions: "Alias for session list", status: "Show runtime and task status", workspace: "List, add, or activate Server workspaces",
      login: "Sign in or inspect Cloud login status", logout: "Sign out of the selected Cloud deployment",
      org: "List or select an organization", catalog: "Inspect public model catalog metadata",
      provider: "Inspect organization providers", model: "Inspect organization models",
      doctor: "Run redacted installation and connectivity diagnostics", completion: "Generate shell completion",
    },
    options: GLOBAL_OPTIONS,
  },
  login: { summary: "Authenticate to JuggleWork Cloud.", usage: "jugglework login [--grant-stdin]\n  jugglework login status", commands: { status: "Validate the selected Cloud login" }, options: ["    --grant-stdin            Read a one-time login grant from stdin"] },
  org: { summary: "Manage the selected Cloud organization.", usage: "jugglework org <command>", commands: { list: "List account organizations", use: "Select an organization by exact ID or slug" } },
  "org list": { summary: "List organizations available to the signed-in account.", usage: "jugglework org list [--json]" },
  "org use": { summary: "Select the organization used by inventory commands.", usage: "jugglework org use <id-or-slug> [--json]" },
  exec: { summary: "Run one deterministic non-interactive task.", usage: "jugglework exec [options] [prompt]" },
  session: {
    summary: "Manage persisted runtime sessions.",
    usage: "jugglework session <command> [arguments] [options]",
    commands: {
      list: "List sessions", show: "Show a session and transcript", resume: "Select a session", fork: "Fork a session",
      queue: "Queue a prompt for a busy session", rename: "Rename a session", archive: "Archive a session",
      unarchive: "Restore an archived session", delete: "Permanently delete a session",
    },
  },
  "session list": { summary: "List sessions in the current workspace.", usage: "jugglework session list [--json]" },
  "session show": { summary: "Show session metadata and transcript.", usage: "jugglework session show <session-id> [--json]" },
  "session resume": { summary: "Select a persisted session.", usage: "jugglework session resume [session-id]" },
  "session fork": { summary: "Fork a persisted session.", usage: "jugglework session fork [session-id]" },
  "session queue": { summary: "Queue a prompt behind active work, or start it when idle.", usage: "jugglework session queue <session-id> <prompt> [--json]" },
  "session rename": { summary: "Rename a persisted session.", usage: "jugglework session rename <session-id> <title> [--json]" },
  "session archive": { summary: "Archive a persisted session without deleting it.", usage: "jugglework session archive <session-id> [--json]" },
  "session unarchive": { summary: "Restore an archived session.", usage: "jugglework session unarchive <session-id> [--json]" },
  "session delete": { summary: "Permanently delete a session after confirmation.", usage: "jugglework session delete <session-id> [--force] [--json]" },
  catalog: { summary: "Inspect unauthenticated public catalog metadata.", usage: "jugglework catalog list [--json]", commands: { list: "List public model metadata" } },
  provider: {
    summary: "Inspect or reconcile organization providers with the selected runtime.",
    usage: "jugglework provider list|import|remove [publication-id] [options]",
    commands: {
      list: "List organization providers",
      import: "Import one published provider into the runtime",
      remove: "Remove one imported provider from the runtime",
    },
  },
  model: { summary: "Inspect models published to the selected organization.", usage: "jugglework model list [--json]", commands: { list: "List organization models" } },
  workspace: { summary: "Manage workspaces through host-authorized Server APIs.", usage: "jugglework workspace <command>", commands: { list: "List Server workspaces", add: "Add a local workspace path", open: "Activate a workspace by exact ID or unique prefix" } },
  "workspace list": { summary: "List Server workspaces.", usage: "jugglework workspace list [runtime options]" },
  "workspace add": { summary: "Add a local workspace using Server host authority.", usage: "jugglework workspace add <path> [runtime options]" },
  "workspace open": { summary: "Activate and persist a Server workspace.", usage: "jugglework workspace open <id> [runtime options]" },
  resume: { summary: "Resume an existing runtime session.", usage: "jugglework resume [session-id] [options]" },
  fork: { summary: "Fork an existing runtime session.", usage: "jugglework fork [session-id] [options]" },
  sessions: { summary: "List recent runtime sessions.", usage: "jugglework sessions [options]" },
  status: { summary: "Show runtime and task status.", usage: "jugglework status [options]" },
  doctor: { summary: "Run redacted diagnostics without starting an embedded runtime.", usage: "jugglework doctor [--json] [--server <url> --token <token>]" },
  completion: { summary: "Generate a completion script for a supported shell.", usage: "jugglework completion <bash|zsh|fish|powershell>" },
};

export function commandHelp(topic: string[] = []): string {
  const entry = HELP_TREE[topic.slice(0, 2).join(" ")] ?? HELP_TREE[topic[0] ?? ""] ?? HELP_TREE[""]!;
  const lines = [`jugglework - ${entry.summary}`, "", "Usage:", `  ${entry.usage}`];
  if (entry.commands) {
    lines.push("", "Commands:");
    const width = Math.max(...Object.keys(entry.commands).map((name) => name.length));
    for (const [name, summary] of Object.entries(entry.commands)) lines.push(`  ${name.padEnd(width)}  ${summary}`);
  }
  if (entry.options?.length) lines.push("", "Options:", ...entry.options.map((line) => `  ${line}`));
  if (!topic.length) lines.push("", "Run 'jugglework <command> --help' for command-specific help.");
  return `${lines.join("\n")}\n`;
}

export const HELP = commandHelp();
const ROOT_COMMANDS = Object.keys(HELP_TREE[""]!.commands!);
const SUBCOMMANDS: Record<string, string[]> = { login: ["status"], org: ["list", "use"], catalog: ["list"], provider: ["list"], model: ["list"], workspace: ["list", "add", "open"], session: ["list", "show", "resume", "fork", "queue", "rename", "archive", "unarchive", "delete"] };
const LONG_OPTIONS = GLOBAL_OPTIONS.flatMap((line) => line.match(/--[a-z-]+/g) ?? []);

export function completionScript(shell: CompletionShell): string {
  const commands = ROOT_COMMANDS.join(" ");
  const options = LONG_OPTIONS.join(" ");
  if (shell === "bash") {
    const cases = Object.entries(SUBCOMMANDS).map(([group, values]) => `${group}) COMPREPLY=( $(compgen -W '${values.join(" ")}' -- "$cur") ) ;;`).join("\n      ");
    return `# bash completion for jugglework\n_jugglework() {\n  local cur\n  COMPREPLY=()\n  cur="\${COMP_WORDS[COMP_CWORD]}"\n  if [[ $COMP_CWORD -eq 1 ]]; then COMPREPLY=( $(compgen -W '${commands} ${options}' -- "$cur") ); return; fi\n  case "\${COMP_WORDS[1]}" in\n      ${cases}\n  esac\n}\ncomplete -F _jugglework jugglework\n`;
  }
  if (shell === "zsh") return `#compdef jugglework\n_jugglework() {\n  local -a commands\n  commands=(${ROOT_COMMANDS.map((name) => `'${name}:${HELP_TREE[""]!.commands![name]}'`).join(" ")})\n  _arguments '*::arg:->args'\n  case $state in args) _describe 'command' commands ;; esac\n}\n_jugglework\n`;
  if (shell === "fish") return [`# fish completion for jugglework`, `complete -c jugglework -f`, ...ROOT_COMMANDS.map((name) => `complete -c jugglework -n '__fish_use_subcommand' -a '${name}' -d '${HELP_TREE[""]!.commands![name]}'`), ...Object.entries(SUBCOMMANDS).flatMap(([group, values]) => values.map((value) => `complete -c jugglework -n '__fish_seen_subcommand_from ${group}' -a '${value}'`))].join("\n") + "\n";
  return `# PowerShell completion for jugglework\nRegister-ArgumentCompleter -Native -CommandName jugglework -ScriptBlock {\n  param($wordToComplete, $commandAst, $cursorPosition)\n  '${commands} ${options}'.Split(' ') | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }\n}\n`;
}
