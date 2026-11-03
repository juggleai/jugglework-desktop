# Restricted local video editing follow-up

## Automatic exported-video result nodes — 2026-11-03

Managed `exportVideo` now checks that the video-node plugin is available before
rendering in a canvas conversation. After successful publication it calls
`addVideoResult`, which validates the existing workspace-relative MP4, creates a
`remote-videoNode` with `outputs.video`, positions it to the right of existing nodes,
focuses it and saves through the normal canvas bridge. No source edges are added.
The node uses the existing video player, download and fullscreen controls. Repeated
publication of the same normalized path reuses its result node.

A failed node publication retains the successful export path and returns
`canvasError` with instructions to add the existing result, rather than rerender it.
The Agent is instructed to direct users to the node instead of producing a blocked
local-file Markdown link. Export outside a canvas retains the previous file-only
behavior.

Verification: Server and Web typechecks and the complete trusted-Bun sidecar build
passed (1034 inventory files). In an isolated temporary project, the actual built
Web canvas created and saved a playable 320x240 MP4 node; playback completed, reload
preserved it, repeated addition reused the node, and a missing file was rejected.
The actual export tool, hostFetch and restricted host editor were exercised through
a temporary authenticated broker transport and the real browser canvas: one render
created one result node with no edges. A simulated canvas failure retained the
successfully rendered file and returned recovery guidance. This is a direct tool
verification, not a live-model or signed-installed-app acceptance run. No existing
user project or installed application resources were changed.

## Explicit cancellation correction — 2026-11-02

The previous disconnect-only UI cancellation claim did not hold on trusted Bun
1.3.14: after POST body consumption, browser abort could leave the host FFmpeg
running. The restricted protocol now requires a fresh UUID `requestId` and an
independent `/api/media/cancel` request. The process request remains pending until
host completion; UI busy therefore includes child close and staging cleanup.
Agent probe/export uses the same explicit cancellation helper. Existing browser
session authentication, same-origin/workspace-header checks, bridge token and
Origin rejection remain enforced. Generic `/api/ffmpeg/*` stays denied.

Each runtime generation has a bounded 4096-ID history, no reuse, and 30-second
cancel-before-start tombstones. Exhaustion fails closed until factory restart;
expired tombstones do not make IDs reusable. Starts register before realpath and
are restricted to the active canonical project. Project open/close and current
workspace grant revocation block new starts and await owned task cleanup. Other
workspace grant removal does not cancel this runtime. No state is persisted to
projects, and no credentials are added to logs or documents.

Verification: routes generated with the operator-specified trusted Bun 1.3.14;
nested Server/Web and Electron typechecks, Server build, focused existing Electron
tests (98 pass, zero failures/skips) and strict affected OpenSpec validation pass. Existing tests were extended
in place (no new test files): early cancellation, ID/ownership/generation/capacity,
cleanup failure, HTTP bridge authentication, and real SIGSTOP FFmpeg interrupted
via explicit HTTP cancel, project close and grant revocation. Each real HTTP case
asserts SIGKILL/ESRCH, empty outputs and no staging before acknowledgement. A
separate actual-route in-memory Bun/Express check rejects unmanaged, missing or
foreign Origin/workspace headers and invalid UUID/schema inputs.

This is source/staging verification, not rebuilt signed-candidate UI acceptance.
Product main/updater and the operator-owned packaged acceptance script were not
run or modified; no commit, push, signing or publication was performed. Failed
cleanup is reported and may retain identity-conflicting output for inspection.
Successful publication that wins the cancellation race remains recoverable;
cancellation does not delete already-committed user artifacts.

### Cancellation review corrections — 2026-11-02

Drained media registries retain cleanup errors for repeated cancel-all and close,
including when cancellation came from an external signal. The existing cleanup
regression exercises both signal sources and repeated error reporting.

Agent requests carry fresh UUID `runId` values and use the independently
authenticated `/api/agent/stop` endpoint. The generation-local bounded registry
reserves before asynchronous lookups, remembers early stops, rejects ID reuse,
and stops only the matching project/run. Async-local context tracks hostVideoEdit
and SDK abort promises; stop waits for their cleanup and retains failures even
when the SDK consumes a rejected tool. The UI keeps its NDJSON transport alive
and remains busy through the independent stop acknowledgement.
Stream/network failures also request and await explicit stop for the same run;
they do not treat a lost processing connection as cleanup confirmation. Project
open/close/remove share a host-to-Pinia transaction queue; removal closes directly
inside its queued transaction to avoid recursive-queue deadlock.

Actual Bun/Express Agent routes passed in-memory checks for session, Origin,
workspace header and schema rejection, early stop, stale/duplicate IDs, cleanup
waiting, repeated successful stop and repeated cleanup errors. A separate actual
hostVideoEdit bridge check verified run-signal propagation without a tool-supplied
signal, cleanup waiting and errors retained despite a swallowed tool rejection.
The actual Pinia project store passed delayed close/open ordering, removal,
queue recovery after host failure and host-success/Pinia consistency after caller
abort. These isolated checks used synthetic transports, not a live model or
running Desktop UI. Router numbering changes follow the existing sorted-index
generator; no generated imports or registrations were manually maintained.

Latest release-note update: the complete darwin/arm64 bundle and independent inventory
verification have passed with 1035 files including frameAnalysisNode.umd.js (tasks 9.6).
Any older "full build pending" statement below is a historical phase handoff, not the
current build status. Live Desktop acceptance (9.7) and cross-platform packaging remain
open. See `docs/toon-factory-release.md` for version-controlled release requirements;
the workspace-local release Skill now references that document. No release was published.

## Source and scope

Reviewed the user-provided Toonflow-app repository at v2.0.8, commit
`af6e884c3d8cda353acaf8ef13aea8ea754a4afd` (MIT, Copyright (c) 2026 HBAI-Ltd).
The earlier local origin/2.0 ref does not include its later FFmpeg Agent plugin.
Upstream videoNode/src/videoProcessing.ts supplies trim/re-encode conventions;
packages/tools/ffmpeg supplies general probe/render capabilities, not a multi-track editor.
Project ZIP export is not movie rendering.

This adaptation intentionally does not copy the unrestricted fluent-ffmpeg tool or
upgrade the upstream runtime, worker framework, i18n or file subsystem. It introduces
managed Agent tools `probeVideo` and `exportVideo`, backed by the authenticated Desktop
broker. Existing `/api/ffmpeg/*` restrictions remain in place.

## Contract

- Inputs are authorized-project relative MP4/MOV/MKV/WebM files, not URLs or manifests.
- Export accepts 1–32 ordered clips with optional start/end seconds, an unused relative
  .mp4 output path, even width/height 128–3840 and fps 24/25/30/60.
- Defaults: 1280x720, 30fps, H.264 CRF18/preset fast/yuv420p, AAC192k/48k stereo.
- Preserve aspect ratio with padding; preserve the first audio stream or add finite
  silence; normalize clips then concatenate them. Total duration is limited to 30min.
- Reject symlink media paths and traversal; validate the host's directory grant again
  before publication. Publish with exclusive hard-link creation, never overwrite input
  or output. Temporary data is isolated beneath the project and removed after processing.
- Use fixed system FFmpeg/FFprobe locations, argv without a shell, restricted protocols
  and demuxers, bounded diagnostics, one active task and a 20min deadline. Stop/abort
  kills and reaps the active child before cleanup. No provider generation is involved.
- No editing timeline, subtitles, transitions, BGM mixing or external-directory export
  is claimed. In canvas conversations, the generated MP4 is automatically attached
  to a saved video result node without source connections.

## Operational limitations and verification

Initial binary discovery targets macOS/Linux standard installation paths; Windows
binary discovery and packaged distribution are deferred, not release-ready.
FFmpeg is not bundled or silently downloaded; its separate license is not covered by
the upstream MIT notice. macOS operators may install it explicitly using Homebrew.
Path checks are not an OS sandbox against another local process concurrently replacing
project paths. Projects should not be mutated by another process during rendering.

Server typecheck passed. Existing runtime lifecycle tests: 28 passed. Desktop-wide
typecheck reports unrelated Office/Socket test errors; full clean-baseline comparison
has not been performed. Real media render and cancel verification remain pending until
FFmpeg/FFprobe are installed. Do not report the media pipeline as end-to-end verified.

The existing managed-resource test expectation now includes the two built-in tools;
all 53 managed tests pass. The darwin/arm64 sidecar rebuild and independent inventory
verification passed (1034 files). The host module is loaded on Desktop restart.

Suggested Agent request after installation/restart:
“探测已有视频，按我确认的顺序拼接，导出到新的 final.mp4，保留原素材。”
The Agent must determine actual relative input paths and obtain the requested edit
order/specification; this migration does not edit the user's cat1 files itself.

## Operator-authorized local verification

After explicit approval, Homebrew FFmpeg/FFprobe 9.0.2 was installed. Temporary
red/blue fixtures verified trimming, concatenating silent and audible clips, duration,
no-overwrite, traversal rejection and cancellation without publishing a partial output.
The operator subsequently authorized project export: four existing clips were joined
in their numbered storyboard order, preserving their full lengths and audio, to a new
MP4 (864x496, 30fps, H.264/AAC, 30.389333 seconds). Full FFmpeg decode returned no errors.
No source clips or canvas JSON were changed. This exercises the same host processor
directly, not a live Agent-to-broker round trip; Desktop restart/live verification is
still pending. Artifact auto-collection failed for the external project path despite
successful file generation and independent on-disk verification.

## v2.0.8 UI migration — 2026-10-30

Implemented the next restricted slice against the same upstream commit:

- videoNode and videoGenerationNode expose 提取音轨 / 分离音视频 / 截取片段 / 逐帧拉片. Trim uses a video preview and numeric start/end seconds (not the upstream thumbnail-strip drag UI).
- The fourth button creates `remote-frameAnalysisNode` and connects `video` → `in`. The independent node is also discovered through the normal built-node menu. It has a VIDEO target handle, local detector settings, cancel, re-analysis and rebuild-result buttons.
- A new `/api/media/process` POST route validates a strict discriminated union, checks the sidecar directory grant, and forwards via `hostFetch` to the existing authenticated `/videoEdit` broker. Canvas injects only this fixed-operation capability. `/api/ffmpeg/*` remains denied; no `context.ffmpeg` or raw command/filter capability is enabled.
- Host operations produce new H.264/AAC MP4, AAC M4A, JPEG and JSON manifest files in caller-created random project asset directories. Separation/analysis shot clips are silent; the original full audio is AAC-transcoded separately. No source files are changed. Publication uses exclusive links and rolls back files published by a failed/cancelled operation.
- Analysis decodes every frame at 160×90 and uses FFmpeg scene difference with a numeric threshold plus minimum shot duration. It is not upstream RGB adaptive/flash-suppression analysis and does not include AI annotations/reports. A single midpoint keyframe is emitted per detected shot.
- Bounds: source ≤1GB, dimensions ≤4096 each, ordinary operations ≤30min, analysis ≤10min/120 shots, each new media output <512MB, aggregate media ≤2GB, one active job and existing 20min deadline. Filters, output names, codecs and argv are host-owned. Fixed system binary discovery remains macOS/Linux only.
- Results are saved in the canvas and in `manifest.json`. Rebuild restores missing result nodes without duplicating existing owned paths; if artifact files were deleted, re-analysis regenerates in a fresh directory. Re-analysis retains earlier result nodes/files for undo and user edits. Failed/cancelled requests may leave an empty random asset directory; successfully published files whose HTTP response is lost remain recoverable in the project rather than being automatically deleted.
- Added an explicit managed node allowlist (all eight staged node types), public video-node component/helper exports, workspace dependencies/lockfile and required local-media node checks in the Desktop build entry. Existing source scanning builds the new package and the final inventory includes it automatically.
- Upstream MIT attribution is retained in adapted sources and the new node readme; the module LICENSE continues to ship.

### Verification in this implementation turn

- Server routes regenerated using `bun run routes`; Server and Web typechecks passed.
- OpenSpec strict validation passed using the cached CLI; `git diff --check` passed.
- videoNode, videoGenerationNode and frameAnalysisNode typechecks and individual Vite UMD builds passed.
- Action dialogs/job ownership are mounted outside the selection-only toolbar slot, so deselecting a node does not unmount/cancel its task. Source/canvas changes and node deletion still cancel work.
- Existing Desktop runtime/build suites: 42 passed. Existing managed suite extended in place: 55 passed, including the new node allowlist and route reachability while generic FFmpeg remains denied.
- Temporary 4-second red/blue video with audio: extraction, separation, 0.5–2.5s trim and scene analysis passed; exactly two shots split at 2s. All video/audio/JPEG outputs decoded successfully; manifest readback passed.
- No-overwrite, traversal, URL, arbitrary filter, symlink input, invalid trim, no-audio extraction rejection and cancellation cleanup passed. Silent analysis emitted two shots without audio. Existing export/concat also passed real decode regression.
- An isolated HTTP harness exercised the actual new sidecar route, real hostFetch and real processor through an authenticated mock broker transport: session rejection, ungranted project rejection, arbitrary arguments rejection, generic FFmpeg denial, probe and real trim passed. This is not a running Electron broker/UI test.
- Verification created temporary assets/config only under the approved OS temporary directory and removed them. No cat1 project data was read or changed; no app restart, commit or push occurred.
- Full sidecar/desktop bundle construction and live UI acceptance remain assigned to the main agent. The current running app still uses its previously built resources until that build and an authorized restart. Local checks used installed Bun 1.3.10; release build must use the pinned/trusted Bun 1.3.14.
