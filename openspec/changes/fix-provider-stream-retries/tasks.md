## 1. Streaming transport

- [x] 1.1 Replace tee probing with single-reader prefix handoff and propagate consumer cancellation.
- [x] 1.2 Abort and release timed-out transports before retry backoff and preserve caller cancellation.
- [x] 1.3 Adjust bounded initial response/output waits and report the final timeout phase.
- [x] 1.4 Verify mocked and real HTTP cancellation, reasoning handoff, empty/unknown replay guards, Server typecheck, plugin build and strict OpenSpec validation.
- [x] 1.5 Bind guarded fetch into managed provider config, add serialized timeout fallbacks, and prevent exhausted inner retries from entering OpenCode's outer retry loop.
- [x] 1.6 Add localized provider-timeout diagnostics and regression coverage for the generic operation-timeout fallback.
- [x] 1.7 Treat the first response-body byte as stream establishment, remove meaningful-output replay, align desktop deadlines behind the gateway, and reduce empty-stream recovery to one retry.

Verification for 1.7: all 35 focused plugin/runtime tests passed, including first-byte handoff, keepalive handoff, true zero-byte recovery, response-header cancellation, direct managed-provider binding, and 330-second runtime defaults. Server typecheck, standalone plugin build, and diff checks passed. The gateway service test suite also passed with first-output timing coverage. OpenSpec CLI validation was unavailable in this checkout. The installed application and remote services were not modified.

Verification for composed retry-budget clarification: clarified the existing two empty-body recovery rounds (initial plus one replacement), at most two underlying fetch calls per round with transient TLS handshake recovery, and at most four underlying fetch calls in total. Added five deterministic in-memory cases covering TLS failure → zero-byte EOF → TLS failure → success, four-fetch empty-body exhaustion, two-fetch TLS exhaustion within one round, and no replay after a metadata byte followed by EOF or a TLS-shaped read error. All 40 focused plugin/runtime tests passed (142 assertions), Server typecheck and scoped diff checks passed. Production retry code and timeout defaults were unchanged. OpenSpec CLI validation remained unavailable (`openspec: command not found`).

Strict validation follow-up: shortened the retry-budget requirement and moved TLS retry eligibility into a scenario, preserving the two-round, two-fetch-per-round, four-fetch-total limits and the prohibition on replay after the first body byte. `npm exec --yes --package @fission-ai/openspec -- openspec validate fix-provider-stream-retries --strict` passed with exit code 0 (`Change 'fix-provider-stream-retries' is valid`). Only this spec and this appended verification record were changed in this follow-up.
