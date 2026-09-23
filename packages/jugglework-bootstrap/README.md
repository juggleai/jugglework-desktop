# JuggleWork Bootstrap CLI

Script-installable `jugglework-bootstrap` command for agent-first onboarding.

This package is intentionally small and does not assume npm is the install
channel. A bootstrap script can place its package-local launcher on disk, then
run:

```bash
jugglework-bootstrap install --bin-dir ~/.local/bin --install-dir ~/.jugglework/bootstrap
jugglework-bootstrap doctor --json
jugglework-bootstrap install app --manifest https://example.com/jugglework-install-manifest.json
jugglework-bootstrap doctor --app --json
JUGGLEWORK_OWNER_PASSWORD='<generated-password>' jugglework-bootstrap cloud onboard --base-url https://den.example.com --owner-email ada@example.com --org-name 'Ada Workspace' --invite-email teammate@example.com --skill-name 'First skill' --json
```

Current scope:

- `install` installs the lightweight CLI into a user-writable bin directory.
- `install app` downloads a manifest-selected desktop app artifact, verifies its
  SHA-256 digest, and installs it into a user-writable app directory.
  Supported artifact types: macOS `.dmg`, `.zip`, `.tar.gz`/`.tgz`, Linux
  `.AppImage`, and Windows `.exe`/`.msi` copy-installs.
- `doctor` verifies the CLI install and, optionally, a Den API health endpoint.
- `cloud onboard` drives the headless REST onboarding flow: sign up, sign in,
  create an org, invite a teammate, and create a starter skill.

This bootstrap layer is independent from runtime hosting and from the supported
standalone `jugglework` CLI in `apps/cli`. Bootstrap installs itself or a Desktop
app artifact; it does not install a standalone CLI distribution, start Server,
manage OpenCode, daemonize a runtime, or update CLI archives.

The old `jugglework-orchestrator` package and its legacy launcher contract are
retired. `jugglework-server` remains the supported direct headless-host
entrypoint. The current standalone `jugglework` command is a separate terminal
client whose native release directory bundles OpenCode and can own an embedded
Server; see [the CLI guide](../../apps/cli/README.md).
