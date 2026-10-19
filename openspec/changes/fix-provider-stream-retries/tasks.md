## 1. Streaming transport

- [x] 1.1 Replace tee probing with single-reader prefix handoff and propagate consumer cancellation.
- [x] 1.2 Abort and release timed-out transports before retry backoff and preserve caller cancellation.
- [x] 1.3 Adjust bounded initial response/output waits and report the final timeout phase.
- [x] 1.4 Verify mocked and real HTTP cancellation, reasoning handoff, empty/unknown replay guards, Server typecheck, plugin build and strict OpenSpec validation.

Verification: all 21 plugin tests passed, including a real loopback HTTP stream whose connection closes before retry dispatch, delayed reasoning handoff, cancellation ordering, and existing replay guards. Server typecheck, isolated plugin build, strict OpenSpec validation, and diff checks passed. The installed application and remote services were not modified.
