## Context

The composer currently reads raw messages only from the persisted snapshot, whose history is capped, and calculates its headline from the latest matching `step-finish`. Live message events update a separate UI transcript, so the meter neither reacts during streaming nor has enough data to estimate a context before a completed call. Provider token shapes also vary, and compaction summaries are represented in both raw snapshot parts and live UI metadata.

## Goals / Non-Goals

**Goals:**
- Build one deterministic calculation that combines raw provider accounting with a serializable view of the active UI transcript.
- Keep provider-reported values exact and local estimates visibly approximate.
- Reset local estimation at a completed compaction summary without losing loaded-history diagnostics.
- Preserve existing server and OpenCode SDK contracts.

**Non-Goals:**
- Reproduce each provider's tokenizer exactly in the renderer.
- Attribute hidden system prompts, tool schemas, skills, or MCP definitions to separate categories.
- Turn the loaded snapshot into a complete lifetime billing ledger.
- Change automatic compaction thresholds or model context-limit discovery.

## Decisions

### Use the merged UI transcript for local estimation

The surface already merges the persisted snapshot with live transcript events and applies the revert cursor. The context component will receive this merged transcript in addition to the raw snapshot. Estimation will count serializable text, reasoning, file metadata, tool names, tool inputs, tool outputs, and errors from that visible/retained transcript.

The alternative was updating raw snapshot messages for every SSE event. That would duplicate the established transcript merge logic and risk reviving stale snapshot state.

### Use a conservative UTF-8 heuristic instead of a tokenizer dependency

Local estimates will derive tokens from text length with separate ASCII-word and non-ASCII character weighting plus a small per-part structural overhead. This is fast, deterministic, language-aware enough for a progress indicator, and requires no model-specific assets.

The alternative was bundling tokenizers per provider. That would increase application size and still fail to account precisely for provider-side prompt wrappers and hidden tool/system content.

### Keep provider reports and estimates as separate facts

The result model will contain a current measurement with a source status plus an optional latest matching provider report. A usable matching provider report is the calibrated current basis only when it is newer than any estimated active content. Otherwise the estimate is the headline and the provider report remains a diagnostic baseline.

This avoids adding a completed call's reported output to an input count that may already include that output, while allowing newly streamed or user content to move the meter immediately.

### Treat completed compaction summaries as estimation boundaries

The estimator will locate the latest completed compaction-summary message and count it plus subsequent messages. A running compaction marker does not become a boundary. The provider accounting ledger remains unchanged so loaded-history diagnostics can still explain the reports in memory.

### Infer provider category availability conservatively

Core input and output remain part of a reported call. Optional categories such as cache write and reasoning are considered available only when a loaded report contains a positive value. Zero-only optional fields render as unavailable because the SDK's numeric zero cannot distinguish unsupported from genuinely measured zero.

## Risks / Trade-offs

- [Local estimates can differ materially from provider tokenization and hidden prompt overhead] → Label every local value as estimated and replace it with a usable provider report at the authoritative boundary.
- [A capped snapshot can omit the compaction summary or older active context] → Describe the estimate and diagnostics as based on loaded history; never claim full-session precision.
- [Tool UI parts have heterogeneous payload shapes] → Serialize only bounded, JSON-safe fields and tolerate unknown part kinds.
- [Streaming updates could make transcript-wide estimation expensive] → Memoize by transcript identity and use a linear, allocation-conscious estimator over the already loaded window.

## Migration Plan

Ship as a renderer-only behavioral update. No persisted data migration is needed. Rollback consists of reverting the context component and calculation helper changes.
