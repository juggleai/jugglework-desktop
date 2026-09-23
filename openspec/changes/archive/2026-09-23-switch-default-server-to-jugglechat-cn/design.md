## Context

See proposal.md. Renderer build defaults and main-process workspace bootstrap defaults currently use work.juggle.im. Bootstrap files take precedence over defaults. The requested version is already 1.2.14; the available build host is macOS arm64.

## Goals / Non-Goals

**Goals:** Produce a verifiable arm64 DMG using the new fallback origin without changing explicit bootstrap configuration.

**Non-Goals:** Cross-region updater routing, automatic rollout, forced server migration, x64/Windows builds, Git publication.

## Decisions

- Change both fallback origins, not just the Vite override, because Electron supplies the renderer's authoritative bootstrap.
- Preserve legacy hosted-domain recognition; the old origin in compatibility helpers is not an active default and must not be blindly replaced.
- Use a separate build output directory and non-overwriting Qiniu upload. Keep version 1.2.14 as requested; this is a manually installable rebuild rather than a higher-version update.
- Verify the packaged version, embedded origins, native dependencies, DMG integrity and available signing/notarization status before upload.

## Risks / Trade-offs

- Same version as existing installs → no automatic upgrade discovery; do not publish channel manifests.
- Apple notarization credentials may be unavailable → report actual signature/notarization status explicitly, never claim notarized without verification.
- New endpoint connectivity → check the actual API path, not only the root URL.
