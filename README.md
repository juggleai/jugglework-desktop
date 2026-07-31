[![Discord](https://img.shields.io/badge/discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/VEhNQXxYMB)

# JuggleWork

> Privacy-first, open-source alternative to Claude Cowork.

JuggleWork is a desktop app that equips AI agents with the tools your team already uses — files, browser, terminal, and cloud services — and lets them learn from your behavior. The more you use JuggleWork, the tighter the connections between tools, the more knowledge accumulated, and the larger the chunks of work that can be automated.

It is the simplest way to create and share safe agent workflows with your team.

Built on [OpenCode](https://github.com/sst/opencode), JuggleWork wraps the engine in a clean, product-like experience: pick a workspace, start a session, watch progress, approve when needed, and reuse what works.

---

## Design principles

- **Local-first, cloud-ready** — One-click to run on your machine. Connect to JuggleWork Cloud when you want shared workspaces, team policies, and managed providers.
- **Composable** — Desktop app, WhatsApp bot, CLI host, or server. Use what fits. No lock-in.
- **Ejectable** — JuggleWork runs on OpenCode. Everything OpenCode can do, JuggleWork can do — even without the UI.
- **Sharing is caring** — Start solo on localhost, explicitly opt in to remote sharing when needed.
- **Extensible** — Skills, plugins, and MCP connections are installable modules. Install from the marketplace or write your own.
- **Auditable** — Every session shows what happened, when, and why.
- **Permission-controlled** — Consequential actions (send email, run commands, post to Slack) check in before executing. You approve what matters.

---

## What's included

### Core
- **Host Mode** — Run OpenCode locally on your machine.
- **Client Mode** — Connect to a remote OpenCode server by URL.
- **Sessions** — Create, select, and manage session groups with drag-and-drop ordering, pinning, and archiving.
- **Live streaming** — SSE event subscription for real-time progress and tool output.
- **Execution plans** — Render OpenCode todos as a timeline.
- **Permissions** — Approve, allow once, or deny tool requests.
- **Templates** — Save and re-run common workflows.
- **Skills Manager** — List, install, and import skill folders from the marketplace.
- **Commands** — Slash commands for repeatable workflows.
- **Plugins** — Native OpenCode plugins, managed from the app.
- **Debug Export** — Copy or export runtime debug reports and developer log streams.

### Agent capabilities
- **Built-in Browser** — Your agent navigates, clicks, fills forms, and captures pages right inside the app.
- **Voice Mode** — Control JuggleWork by voice through OpenAI Realtime.
- **Computer Use** — Let your agent take screenshots and control mouse/keyboard (macOS accessibility-permissioned).
- **Artifacts** — Preview, edit, download, and reopen generated files.
- **Split Screen** — Chat on one side, artifacts on the other.
- **Cross-chat Memory** — Durable memory bank that persists across sessions. The agent remembers facts, preferences, and workflows you teach it.

### Team & cloud (JuggleWork Cloud)
- Organization accounts with members, teams, and RBAC.
- Shared workspaces, providers, skills, and templates.
- Desktop policies to restrict capabilities by org, team, or member.
- Marketplace for publishing skills, commands, MCPs, and plugins.
- JuggleWork Connect for one-click tool connections (Slack, Gmail, Calendar, Notion, Linear, etc.).
- SAML SSO (Microsoft Entra, Google Workspace) and SCIM provisioning.
- Usage analytics and telemetry.
- Self-host / on-prem deployment in your own VPC.

### Model providers
Bring your own API keys — or run fully local:

| Cloud | Open-weight | Local |
|---|---|---|
| OpenAI, Anthropic, Google (Gemini) | DeepSeek, Kimi, GLM, Qwen, MiniMax | Ollama |
| xAI (Grok), Mistral, Together AI, Fireworks | Z.AI · GLM | |

Switch models per task, even mid-conversation.

---

## Other surfaces

JuggleWork is more than the desktop app:

| Surface | What it is |
|---|---|
| **[JuggleWork Orchestrator](apps/orchestrator/README.md)** | CLI host — run OpenCode + JuggleWork Server without the desktop UI. `npm install -g jugglework-orchestrator` |
| **[Owpenbot](https://github.com/juggleai/jugglework-desktop)** | Lightweight WhatsApp bridge for a running OpenCode server. |
| **[JuggleWork Server](https://github.com/juggleai/jugglework-server)** | Self-hostable Go backend — deploy in your VPC for private team use. |
| **[JuggleWork Cloud MCP](https://work.juggle.im/jwork/api/mcp/agent)** | Connect any MCP-compatible client (Claude Code, Cursor, Codex, VS Code, etc.) to your JuggleWork org. |

---

## Quick start

### Download

Get the latest release for macOS and Linux at **[juggle.im/download](https://juggle.im/download)** or from [GitHub Releases](https://github.com/juggleai/jugglework-desktop/releases).

Windows access is available through a paid support plan at [juggle.im/pricing#windows-support](https://juggle.im/pricing#windows-support).

Hosted JuggleWork Cloud workers launch from the web app after sign-in and connect from the desktop via **Add a worker → Connect remote**.

### Prerequisites (source build)

- **Node.js 24** + **pnpm 11.4+**
- **Bun 1.3.9+** (`bun --version`)
- **Rust toolchain** (for Tauri): `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **Tauri CLI**: `cargo install tauri-cli`
- **OpenCode CLI** on PATH: `opencode`
- **macOS**: Xcode Command Line Tools
- **Linux**: WebKitGTK 4.1 dev packages (`webkit2gtk-4.1`, `javascriptcoregtk-4.1`)

### Quick smoke test

From the repo root:

```bash
git checkout dev
git pull --ff-only origin dev
pnpm install --frozen-lockfile

which bun && bun --version
pnpm --filter @jugglework/desktop exec tauri --version
```

### Install

```bash
pnpm install
```

The project lives in `apps/app` (UI) and `apps/desktop` (Electron shell).

### Run (desktop)

```bash
pnpm dev
```

`pnpm dev` automatically enables `JUGGLEWORK_DEV_MODE=1`, which uses isolated OpenCode state instead of your personal global config/auth/data — safe for development.

### Run (web UI only)

```bash
pnpm dev:ui
```

All `dev` entry points use the same dev-mode isolation.

### Arch Linux

```bash
sudo pacman -S --needed webkit2gtk-4.1
curl -fsSL https://opencode.ai/install | bash -s -- \
  --version "$(node -e "const fs=require('fs'); const parsed=JSON.parse(fs.readFileSync('constants.json','utf8')); process.stdout.write(String(parsed.opencodeVersion||'').trim().replace(/^v/,''));")" \
  --no-modify-path
```

---

## Architecture

JuggleWork is an Electron (Tauri) desktop shell wrapping a web UI that connects to a local or remote OpenCode runtime.

### Host mode (default)

When you pick a workspace, JuggleWork starts the local runtime stack:

```
jugglework-orchestrator (CLI)        ← default runtime (npm install -g jugglework-orchestrator)
  ├── opencode serve --port <port>   ← manages OpenCode server process
  └── jugglework-server              ← optional backend for cloud features
```

Fallback: if the orchestrator is not installed, the desktop falls back to starting `opencode serve` directly.

The UI uses `@opencode-ai/sdk/v2/client` to connect, list/create sessions, send prompts, subscribe to SSE events, and read todos/permissions.

### Client mode

Point the desktop at any `opencode serve` instance by URL — your local machine, a remote server, or a cloud worker.

---

## Useful commands

```bash
pnpm dev              # Run desktop app (dev mode)
pnpm dev:ui           # Run web UI only
pnpm typecheck        # Type-check the UI package
pnpm build            # Build desktop + UI
pnpm build:ui         # Build UI only
pnpm test:e2e         # Run end-to-end tests
pnpm evals            # Run eval suite (automation mode)
pnpm fraimz           # Run eval suite (demo mode)
pnpm bump:patch       # Bump patch version
pnpm release:review   # Review release status
pnpm release:prepare  # Prepare a release
pnpm release:ship     # Ship a release
```

---

## Security

- JuggleWork hides model inference and sensitive tool metadata by default.
- Host mode binds to `127.0.0.1` — local-only.
- Secrets (API keys, tokens) are stored in the app's local secret store, never in the cloud.

---

## Troubleshooting

If you need to report a desktop or session bug, export both the runtime debug report and developer logs from **Settings → Debug** before opening an issue.

### Linux / Wayland (Hyprland)

If JuggleWork crashes on launch with WebKitGTK errors (e.g., `Failed to create GBM buffer`), disable dmabuf or compositing before launch:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 jugglework
```

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 jugglework
```

---

## Contributing

We welcome contributions. Before diving in:

1. Read `AGENTS.md`, `VISION.md`, `PRINCIPLES.md`, `PRODUCT.md`, and `ARCHITECTURE.md` for product context.
2. Ensure Node.js, `pnpm`, Rust, Bun, and `opencode` are installed.
3. Run `pnpm install` after every checkout.
4. Validate changes with `pnpm typecheck` and `pnpm test:e2e` before opening a PR.
5. Use `.github/pull_request_template.md` and include the commands you ran, results, and manual verification steps.
6. For new PRDs, follow the conventions in `apps/app/pr/<name>.md`.

Community docs: `CODE_OF_CONDUCT.md`, `SECURITY.md`, `SUPPORT.md`, `TRIAGE.md`.

### First-time contributor checklist

- [ ] Run `pnpm install` and baseline verification commands.
- [ ] Ensure changes have a clear issue link and scope.
- [ ] Add or update tests for behavior changes.
- [ ] Include commands run and results in the PR.
- [ ] Add screenshots or video for user-facing flow changes.

---

## For teams and enterprises

Interested in using JuggleWork in your organization? We'd love to hear from you — reach out at [ben@juggle.im](mailto:ben@juggle.im) to discuss your use case.

---

## License

MIT — see [`LICENSE`](LICENSE).
