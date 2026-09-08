## Why

The requested 1.2.14 macOS distribution must connect to https://work.jugglechat.cn by default instead of the previous hosted server.

## What Changes

- Align renderer fallback and Electron bootstrap default with the requested server origin.
- Preserve explicitly configured deployments and legacy URL compatibility.
- Rebuild an arm64 DMG without changing version 1.2.14 and upload it to the requested Qiniu bucket without publishing update-channel manifests.

## Capabilities

### New Capabilities

- `desktop-default-server`: Consistent default server selection for an unconfigured desktop installation.

### Modified Capabilities

None.

## Impact

Renderer Den defaults, Electron bootstrap defaults, focused tests, and a macOS artifact in juggleim/jugglework/releases/v1.2.14/mac/arm64/. Existing installations retain explicit bootstrap settings. No automatic updater migration or Git push is included.
