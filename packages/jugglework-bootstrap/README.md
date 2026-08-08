# JuggleWork Bootstrap CLI

Script-installable `jugglework-bootstrap` command for agent-first onboarding.

This package is intentionally small and does not assume npm is the install
channel. A bootstrap script can place `bin/jugglework.mjs` on disk, then run:

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

This bootstrap layer is independent from runtime hosting. The old bare
`jugglework` command and `jugglework-orchestrator` package are retired;
`jugglework-server` is the supported headless runtime entrypoint. Bootstrap does
not start Server, manage OpenCode, daemonize a runtime, or provide compatibility
commands for the retired CLI.
