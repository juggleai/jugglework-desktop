# Claude Agent distribution legal-review checklist

This checklist records release evidence; it is not legal advice and does not
declare an artifact approved. Product counsel or the designated legal reviewer
must approve the actual target artifacts before publication. Use one completed
copy per release and retain it with the release evidence.

## Release record

- Release/version:
- Commit:
- Reviewer and approval date:
- Approved target triples:
- Artifact names and SHA-512 values:
- Distribution channels and territories:
- Provider/authentication paths enabled:
- Related privacy/security review:
- Exceptions, owners, and expiry dates:

Do not place credentials, license-portal credentials, private transcripts,
customer names, or unredacted diagnostics in this record.

## Current shipped-component inventory

Verify this inventory against the generated package rather than copying it into
an approval unchanged:

| Component | Current source/version contract | Current package behavior | Review evidence |
| --- | --- | --- | --- |
| JuggleWork Desktop/Server/worker code | Repository release; root and Server declare MIT | App/Server bundles and worker JavaScript | Root `LICENSE`, source offer/attribution obligations, product EULA compatibility |
| Claude Agent SDK | `@anthropic-ai/claude-agent-sdk` exact pin `0.3.226` | Worker code is bundled; `worker/sdk-package.json` records SDK and Claude Code versions | Installed package metadata/license/terms for the exact version; redistribution and use restrictions |
| Platform Claude executable | Matching `@anthropic-ai/claude-agent-sdk-<target>` package at `0.3.226` | Copied to `resources/claude-agent/claude`; the packaging script also copies that package's `LICENSE.md` and `README.md` when present | Per-target package terms, notices included in final installer, trademark/product naming, provider terms |
| Node.js runtime | Exact Node `24.19.0` download from nodejs.org | Only the target Node executable is copied into `resources/claude-agent/node` by the current script | Node license and bundled third-party notices; confirm required notices accompany the final artifact or record an approved remediation before release |
| Electron and app dependencies | Locked workspace dependencies | Included according to Electron Builder and package-manager output | OSS inventory/SBOM, license compatibility, source/notice obligations |
| OpenCode sidecar | Repository `constants.json` pin and target sidecar | Packaged separately under `resources/sidecars` | Existing OpenCode distribution approval remains valid for this release |

The Node row is intentionally explicit: the current Claude asset script copies
the Node executable, not the Node distribution's license/notice files. Legal
review must not mark the release complete merely because the binary works. Add
the required notices to the distribution or record counsel's approved handling
before release.

## Review gates

- [ ] Generate a per-target package inventory and SBOM from the final signed
  artifacts; reconcile it with the lockfile and package manifest.
- [ ] Confirm the exact SDK and all six optional platform package versions match
  `apps/claude-agent-worker/package.json` and `pnpm-lock.yaml`.
- [ ] Read the exact SDK/platform package terms and all bundled license/readme
  files. Record redistribution, hosted-service, reverse-engineering,
  modification, notice, and update obligations.
- [ ] Confirm Node.js license and third-party notices are distributed as
  required for the exact downloaded build.
- [ ] Confirm Electron, OpenCode, and all transitive OSS notices/source-offer
  obligations remain satisfied after bundling/minification.
- [ ] Verify third-party notices are reachable in every installer format and
  survive auto-update.
- [ ] Review use of the names `Claude`, `Claude Agent`, `Claude Code`,
  `Anthropic`, and provider logos against trademark guidelines. Do not imply
  endorsement or ownership.
- [ ] Review Anthropic/provider terms for BYOK, gateway, Bedrock, Vertex, and
  Foundry paths actually enabled in the release. Disabled broker code does not
  authorize production use.
- [ ] Review privacy disclosures for prompts, selected files, tool arguments and
  results, MCP recipients, local transcript/canonical storage, diagnostics,
  retention, deletion, backups, subprocesses, and remote collaborators.
- [ ] Confirm user/admin docs accurately distinguish normal Anthropic model
  configuration from the dedicated Claude Agent credential broker.
- [ ] Confirm the 30-day JSONL cleanup, 10,000-event window, 90-day audit
  retention, indefinite canonical projection, full-reset behavior, and backup
  caveat meet policy and contractual requirements.
- [ ] Complete data-processing, subprocess/vendor, international transfer,
  export-control/sanctions, age/acceptable-use, and sector-specific review for
  intended customers and territories.
- [ ] Confirm security representations match implementation: authenticated
  loopback worker, allowlisted environment, OS-backed secret storage,
  fail-closed sandbox requirement, mandatory pre-tool policy, and redacted
  diagnostics. Do not describe sandboxing as the only boundary.
- [ ] Confirm cost values are described as estimates, not invoices or billing
  records.
- [ ] Verify rollback can disable Claude/advanced features without deleting user
  data and that incident evidence excludes credentials/private transcripts.
- [ ] Record legal approval or block the target/release with an owner and dated
  remediation.

## Evidence commands

These commands verify implementation/package facts; they do not replace legal
review:

```bash
pnpm release:review --strict
node apps/claude-agent-worker/scripts/check-package-content.mjs \
  apps/desktop/resources/claude-agent
node apps/claude-agent-worker/scripts/installed-smoke.mjs \
  apps/desktop/resources/claude-agent
```

Run installed smoke on a target-compatible host and review the final signed
installer, not only the staging directory. Preserve command results and hashes,
but never attach environment dumps or credential-bearing files.
