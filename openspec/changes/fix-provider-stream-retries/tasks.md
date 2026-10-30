## 1. Streaming transport

- [x] 1.1 Replace tee probing with single-reader prefix handoff and propagate consumer cancellation.
- [x] 1.2 Abort and release timed-out transports before retry backoff and preserve caller cancellation.
- [x] 1.3 Adjust bounded initial response/output waits and report the final timeout phase.
- [x] 1.4 Verify mocked and real HTTP cancellation, reasoning handoff, empty/unknown replay guards, Server typecheck, plugin build and strict OpenSpec validation.
- [x] 1.5 Bind guarded fetch into managed provider config, add serialized timeout fallbacks, and prevent exhausted inner retries from entering OpenCode's outer retry loop.
- [x] 1.6 Add localized provider-timeout diagnostics and regression coverage for the generic operation-timeout fallback.

Verification: all 35 focused server tests passed, including direct managed-provider fetch binding, URL fallback when the marker header is absent, response-header cancellation, a real loopback HTTP stream whose connection closes before retry dispatch, delayed reasoning handoff, and runtime timeout defaults. All 55 focused client tests passed, including localized provider-timeout diagnostics. Server typecheck, server/plugin production build, client production build, and diff checks passed. OpenSpec CLI validation was unavailable in this checkout. The installed application and remote services were not modified.
