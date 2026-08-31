## 1. Context Measurement Model

- [x] 1.1 Add deterministic transcript token estimation and verify unit coverage for multilingual text, tools, files, and empty sessions
- [x] 1.2 Combine estimates with matching provider reports and verify source selection for initial, streaming, completed, interrupted, and model-switch states
- [x] 1.3 Detect completed compaction boundaries and verify pre-compaction content is excluded only after the replacement summary is available

## 2. Session Surface Integration

- [x] 2.1 Pass the merged live transcript and streaming state into the context meter and verify live deltas can change the displayed estimate
- [x] 2.2 Preserve raw snapshot messages for provider accounting and verify loaded-history totals remain independent from current context

## 3. Context Details Presentation

- [x] 3.1 Update the meter tooltip and dialog to identify estimated, streaming, provider-reported, and post-compaction measurements
- [x] 3.2 Separate current context, latest-call calibration, and loaded-history diagnostics and verify unsupported optional provider fields are not shown as exact zero
- [x] 3.3 Remove redundant explanatory copy and verify Chinese and English layouts remain readable

## 4. Verification

- [x] 4.1 Run the focused context-usage test suite and application typecheck with no failures
- [x] 4.2 Validate the OpenSpec change strictly and leave the implementation uncommitted for product verification
