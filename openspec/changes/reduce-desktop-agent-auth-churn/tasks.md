## 1. Main-process Token Cache

- [x] 1.1 Add a device-bound in-memory agent-token cache with a handshake safety margin.
- [x] 1.2 Reuse the cache only for ordinary reconnects; keep proactive refresh and revocation probes on fresh issuance.
- [x] 1.3 Clear the cache on every identity, credential, local-stop, revocation, and pre-welcome failure boundary.

## 2. Verification

- [x] 2.1 Add tests for reuse within TTL, proactive/near-expiry rotation, pre-welcome rejection, and identity-switch invalidation.
- [x] 2.2 Run focused agent tests, Electron checks, package test registration, diff checks, and strict OpenSpec validation.
