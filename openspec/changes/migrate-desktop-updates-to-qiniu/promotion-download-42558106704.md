# Promotion download failure: run 42558106704

## Verified observations (2026-11-09)

- Authenticated `gh run view` metadata/logs identify trusted dev tooling
  `04dc36853e190d486728f7014e3a636e7f63f648`, macOS 26.7.2 arm64,
  Node 24.22.2. Artifact source remains
  `c97ca572189939d7d61ee18b7533285d137c0e21`; no rebuild is proposed.
- The retained evidence has only `download.zip/before` at
  `03:46:53.637Z`; failure evidence was updated at `03:47:04.228Z`
  (10.591 seconds later). CLI output contains only stage/category/TypeError,
  followed by exit 1. No fetch message, cause, resolved address, TLS diagnostic,
  received-byte count or memory measurement was retained. There is no OOM/killed
  process signature in the logs. This does not exclude every memory failure.
- Existing redaction discards `error.cause` before both evidence and CLI output.
  GitHub masking is not the reason the cause is unavailable. Historical cause
  cannot be reconstructed from these logs.
- The duration is consistent with a connection timeout but is not proof of one.
  The 600-second AbortSignal is a whole-operation bound, not a replacement for
  fetch/Undici connection timeouts. DNS, TCP, TLS and response-body transport
  failures can surface as TypeError. No evidence supports changing Node versions,
  DNS preference, TLS verification, or memory limits yet.
- The restore function writes each received chunk with backpressure and
  `inspectArtifact` hashes via a file stream. It does not buffer the 423,068,859-byte
  ZIP in an arrayBuffer. Fresh CDN verification is a later, unreached gate; its
  separate buffering behavior cannot explain this failed restore gate.
- Public read-only checks from the local machine: Node 24.21.0 / Undici 7.29.1,
  verified TLS 1.3, ZIP HEAD 200 with exact MIME/size, ZIP range GET 206 with one
  byte and `bytes 0-0/423068859`, immutable manifest GET 200 / 706 bytes / SHA-256
  `c2305f907ed84fb4a2c41d3afc5f514846e52b02a32373bf8c69be75de1c2cc4`.
  curl independently returned HEAD 200 and TLS verify result 0. Local DNS resolves
  to 198.18.0.126 (an intermediary/fake-IP path), so these results do not establish
  the failed GitHub runner's region, DNS answers or reachability.
- Public Stable GET returns 1.2.33, 706 bytes, SHA-256
  `4870eac860afc4dc365f80ef42e9504d1305ec80e463fa77bdeec43dd2d7d17a`,
  exactly the approved predecessor. Public lock HEAD returns 404. Public CDN
  observations are not authenticated origin stat or a complete mutation audit.
- Evidence has `workflow.promotion=null`. Code sequencing puts all downloads,
  manifest/package/fresh-CDN verification before `promoteChannel`; lock access,
  channel writes and CDN refresh occur only inside that later function. Thus this
  execution stopped before these effects. Authentication and retained GitHub
  evidence upload did happen. No Den or website operation is in this continuation.
- Independently fetched the small authenticated GitHub evidence artifact
  `13648486348`: 3,823-byte ZIP, SHA-256
  `f2b68213db39e8086eaae87b060ddf8c3d3dbaa6aa8477b3567aed0025ffda3c`,
  matching GitHub's artifact digest. Its only member is `release-evidence.json`
  and confirms the same source, single checkpoint, failure and null promotion.

## Minimal implemented change: diagnostic loss only

`promotion-continuation.mjs` now retains download phase (headers, metadata, open,
body, write, sync or digest), received bytes, elapsed time, actual Node/Undici
versions and numeric process memory counters on failure. It projects nested cause
and AggregateError children into fixed names/codes/syscalls, with at most eight
visited entries and depth four; cycles terminate. No messages, stacks, URLs,
addresses, certificate data, paths, subprocess output or environment values are
copied. Rejected/unconsumed response bodies are cancelled without hiding the gate
failure. Existing exclusive local creation, redirect rejection, TLS defaults,
size/MIME/SHA-256/SHA-512/ETag checks remain mandatory.

This repairs the demonstrated observability defect, not the unproven network
cause. It adds no retries or dispatch. Tests inject connect timeout, nested
aggregate/cyclic errors and a partial-body socket failure with sentinel secrets;
they check persisted safe diagnostics, one GET, retained partial output and no
Qiniu access/effects. Existing promotion/integrity tests remain applicable.

Validation: all 239 release-tool tests passed (including 54 continuation tests),
all four workflow-policy tests passed, OpenSpec 1.16.1 strict validation passed
using its existing temporary cache, and `git diff --check` passed. No dependency
installation or lockfile change was needed. These are local regression results,
not a reproduction of the failed runner's network path.

## Bounded retry design (not enabled)

If a separately authorized next diagnostic execution confirms a transient
transport cause, confine retry to the immutable restore GET helper, never wrap
`continuePromotion`, `promoteChannel`, qshell operations or a workflow job:

1. Require the exact candidate-derived HTTPS immutable URL/key, no userinfo,
   query, fragment, redirect, fallback origin or mutable channel path. Explicit
   method GET, no authentication headers or cookies.
2. At most three total attempts, bounded 1s/3s backoff, one shared 600-second
   deadline. Record every attempt's safe diagnostics even if a later one succeeds.
   Never reset the deadline per attempt.
3. Retry only a fetch rejection while awaiting headers, with no response and zero
   artifact bytes, for an entirely recognized transient cause tree:
   `EAI_AGAIN`, `ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`, `ENETUNREACH`,
   `EHOSTUNREACH`, `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_HEADERS_TIMEOUT`, or
   `UND_ERR_SOCKET`. An AggregateError must have only recognized transient leaf
   codes; one certificate/unknown/permanent leaf vetoes retry. Bare TypeError,
   ENOTFOUND, abort/deadline, TLS/certificate, HTTP response (including 429/5xx),
   MIME/length/redirect/integrity/local-filesystem errors fail closed immediately.
4. Never retry a partial body or restart a large download automatically in this
   minimal design. Preserve partial evidence, cancel the response and stop. File
   creation remains exclusive; no truncate, overwrite, resume or digest bypass.
5. Test transient-failure-then-success, exact exhaustion/deadline, mixed aggregate
   veto, TLS/unknown/HTTP/metadata/digest/filesystem/partial-body no-retry cases,
   full integrity on eventual success and zero production mutations on failure.
   Prove a production mutation failure still invokes that mutation only once.

Before authorizing another full restore, a small same-runner public diagnostic
should compare OS DNS results, verified TLS, Node HEAD/one-byte Range and curl
HEAD/one-byte Range using strict time/byte bounds and the unchanged URL. A
Node-only failure with curl success would narrow the client/runtime path; both
clients failing would narrow the runner/CDN path. A certificate code requires
certificate/hostname/time/chain investigation, never disabled verification.
Public success now cannot establish what happened at the original timestamp.

No commit, push, workflow dispatch/rerun, full ZIP/DMG GET, lock acquisition,
channel mutation, CDN refresh, Den change or website deployment was performed
during this investigation. Promotion tasks 40.7–40.9 remain pending.
