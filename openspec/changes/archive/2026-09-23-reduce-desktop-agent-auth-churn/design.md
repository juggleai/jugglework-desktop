## Context

The server returns each opaque agent token once and stores only its digest, so reuse must be implemented by the Desktop process that already holds the token for WebSocket authentication. Electron Main owns the transport and lifecycle fencing; Renderer must never receive the token.

## Goals / Non-Goals

**Goals:**

- Avoid a challenge/sign/token write cycle for ordinary network reconnects within token validity.
- Preserve proactive rotation, expiry, revocation, local-stop, policy, generation, and account/workspace fencing.
- Prevent a rejected cached token from retrying indefinitely.

**Non-Goals:**

- Persisting agent tokens across process restarts.
- Extending token TTL or changing the server authorization contract.
- Reusing tokens across device identities, accounts, organizations, or control-plane origins.

## Decisions

### Cache tokens only in the Main-process agent instance

The cache binds a validated token to the enrolled `deviceId`. Ordinary `connectNow(false)` reconnects may use it when expiry remains beyond a 30-second handshake margin. Proactive `connectNow(true)` refreshes always mint a new token, preventing refresh loops on one near-expiry credential.

### Clear cache at every identity and authorization boundary

The cache is cleared on context identity switch, same-identity authorization/policy loss, invalid/missing credentials, identity deletion or replacement, local or cloud disable/stop, confirmed revocation, and ambiguous-not-found recovery. A transport failure before `connection.welcome` also clears it because the server may have rejected the bearer. A failure after welcome retains it so a normal network drop gets the reuse benefit.

### Keep revocation probes authoritative

Explicit revocation verification continues to mint a fresh token as its proof probe. If successful, that verified token is passed into and cached by the normal connection path; if rejected, existing terminal/retry behavior remains authoritative.

## Risks / Trade-offs

- [Cached bearer remains in memory until lifecycle cleanup] → It is already held for the socket lifetime; no disk, Renderer, log, or status exposure is added.
- [Server revokes token before its local expiry] → Pre-welcome rejection clears the cache and the next retry performs a fresh PoP exchange.
- [Token has too little lifetime for handshake] → A 30-second margin forces fresh issuance.

## Migration Plan

No migration. Rollback restores one PoP exchange per reconnect; server-issued tokens remain valid under the same contract.
