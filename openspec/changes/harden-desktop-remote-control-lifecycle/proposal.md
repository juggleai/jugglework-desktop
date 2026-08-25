## Why

Desktop remote control currently goes offline when macOS sleeps and does not immediately restore a fresh authorized WebSocket after wake. The existing settings are also buried in the cloud account page, while an unattended remote-control device needs an explicit global power policy that keeps the Mac awake while it waits for remote work.

## What Changes

- Keep **Remote Control** inside Cloud Account settings for device-wide enrollment, connection, background, startup, busy-session, and power behavior.
- Default enabled remote-control devices to **stay awake while waiting for remote tasks**, while still allowing the display to sleep.
- Keep remote control fail-closed across system sleep, but immediately request fresh organization policy after resume and reconnect once policy and network access recover.
- Trigger the same bounded recovery path after the renderer reports network restoration.
- Detect silent or half-open remote-control WebSockets from cloud-provided liveness thresholds and replace them with a newly authenticated connection.
- Keep the local emergency disable and Stop All actions available even when cloud policy is unavailable.
- Add deterministic lifecycle, settings, transport, route, and UI coverage for the P0-P1 behavior.

## Capabilities

### New Capabilities

- `desktop-remote-control-lifecycle`: Device-wide remote-control settings, unattended wake policy, system suspend/resume recovery, network recovery, and transport liveness requirements.

### Modified Capabilities

- None.

## Impact

- Electron Main remote-control agent, power monitor, power-save blocker, WebSocket transport, settings store, and IPC lifecycle.
- Renderer desktop-config refresh orchestration and the existing Cloud Account settings page.
- Shared desktop IPC/settings types and localized Settings text.
- Existing desktop remote-control settings files migrate from schema version 1 to a compatible schema with an explicit unattended wake preference.
- No server protocol breaking change is required; the client begins consuming the existing `staleSeconds` and `offlineSeconds` welcome fields.
