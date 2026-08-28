## Context

The Electron Main process owns remote-control credentials, policy fencing, WebSocket transport, command dispatch, and power lifecycle. A renderer provider obtains organization desktop policy and sends a fresh validation timestamp to Main. On suspend, Main correctly invalidates that policy and closes the transport; on resume, however, no event asks the renderer to refresh policy, so a hidden app can remain offline until the five-minute policy poll. The transport reconnects after explicit close/error but does not consume the server-provided stale/offline thresholds, leaving half-open sockets possible after Wi-Fi, VPN, proxy, or NAT changes.

Remote-control settings persist globally under Electron `userData` and remain managed from Cloud Account. The power-save blocker is held only while a remote run is already active, which cannot keep a waiting device discoverable. The requested default is that an enabled remote-control device prevents application/system idle sleep while waiting for remote tasks, while allowing the display to sleep.

## Goals / Non-Goals

**Goals:**

- Restore an authorized remote-control WebSocket promptly after system resume or network restoration.
- Preserve the existing fail-closed rule that pre-sleep policy and tokens cannot authorize post-sleep control.
- Bound half-open transport lifetime using server-provided liveness values.
- Keep device-wide remote-control behavior grouped with its Cloud account and organization context.
- Default newly created and legacy enabled settings to keep the Mac awake while remote control waits for work.
- Allow a local user to disable or stop remote control even when cloud policy is unavailable.

**Non-Goals:**

- Wake a fully sleeping or powered-off Mac through APNs, Wake-on-LAN, Bonjour Sleep Proxy, or MDM.
- Prevent display sleep or guarantee remote availability while a MacBook lid is closed.
- Change the cloud WebSocket protocol or server presence thresholds.
- Move host-level remote-control authority out of Electron Main.

## Decisions

### Main emits a recovery request; renderer remains policy authority

`powerMonitor.resume` will first resume the agent's fenced state and then notify renderer web contents that fresh remote policy is required. The renderer provider will run its existing fresh network fetch and publish the resulting context through the existing IPC command. `window.online` will invoke the same refresh path.

This keeps organization session and policy access in the existing renderer provider rather than duplicating Den authentication in Main. Directly reconnecting from `resume()` was rejected because Main has intentionally invalidated the only policy that could authorize the connection.

### Recovery retries are bounded and converge on successful fresh validation

The renderer recovery coordinator will retry fresh config reads with exponential delays of approximately 0, 1, 2, 4, 8, 15, then 30 seconds, resetting after success. Repeated resume/online requests will coalesce into one recovery loop. Existing five-minute refresh remains a background fallback.

### Liveness is based on inbound cloud activity

After `connection.welcome`, the agent will store `staleSeconds` and `offlineSeconds`, update `lastInboundAt` for every decoded cloud frame, and arm a watchdog. If no inbound frame arrives by the stricter useful deadline, with a small scheduling tolerance, Main will terminate the socket and use the existing token issuance and reconnect backoff path. Every replacement is fenced by lifecycle and connection generations.

Using outbound `send()` success was rejected because kernel buffers can accept writes for a half-open TCP connection. Relying only on close/error was rejected because cloud presence can expire first.

### Waiting-for-work wake policy is an explicit persisted setting

The settings schema gains `preventSleepWhileWaiting`. Its effective default is `true` for a newly initialized remote-control configuration and for a legacy enabled schema that did not contain the field. When remote control is disabled, all dependent fields remain normalized off, preserving current fail-closed storage semantics.

The power controller will hold one `prevent-app-suspension` assertion whenever authorization is fresh and either an active run exists or `preventSleepWhileWaiting` is enabled. It never requests `prevent-display-sleep`.

### Cloud Account settings surface

The remote-control section remains inside Cloud Account and uses the existing Main-owned store and IPC. Its storage remains device-global and does not vary with workspace, while its placement keeps enrollment alongside the account and organization context it requires.

The enable action continues to require fresh cloud policy. Disable and Stop All remain locally available regardless of policy so loss of cloud access cannot trap the user in an enabled state.

## Risks / Trade-offs

- **[Higher battery use while remote control is enabled]** → Expose the setting clearly, allow it to be turned off, allow the display to sleep, and release the assertion immediately on disable, sign-out, revocation, or stale policy.
- **[Resume event arrives before network is usable]** → Use a coalesced bounded retry loop rather than one immediate request.
- **[Renderer is unavailable during resume]** → Send recovery to every non-destroyed app webContents and retain the existing periodic policy refresh as fallback.
- **[Server sends infrequent inbound traffic]** → Base watchdog scheduling on the negotiated stale/offline values and reset it for every valid inbound frame.
- **[Schema migration accidentally disables an existing device]** → Accept the exact legacy schema, map enabled legacy configurations to the requested default, and rewrite only through the existing atomic store.
- **[Power assertion survives an invalid state]** → Derive authorization in Main and reconcile the blocker on every authorization/settings/active-run transition and controller stop.

## Migration Plan

1. Ship the compatible settings reader and shared type first in the same desktop build.
2. Legacy schema-1 files are read without data loss; enabled devices receive `preventSleepWhileWaiting=true`, disabled files remain fully off.
3. The new global page writes the current schema atomically through existing IPC.
4. Rollback to an older build fails closed on the newer schema rather than silently enabling remote control; the user can re-enable after returning to the newer build.

## Open Questions

- A later change can add an AC-power-only mode if product telemetry shows the default causes unacceptable battery impact.
- True wake-from-sleep requires a separate platform and infrastructure design and is not part of P0-P1.
