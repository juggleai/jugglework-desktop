"use strict";
/**
 * Office-binary file extension constants.
 *
 * Runtime support is derived from `document-types.ts`'s unified type table
 * (which is also consumed by `buildPreviewUrl` to decide the `/static/<type>/pc.html`
 * template). File association metadata is sourced from the package-level
 * `supported-extensions.cjs` so builder configs can reuse the same static list
 * without loading TypeScript or the service runtime.
 *
 * `FALLBACK_SUPPORTED_EXTENSIONS` is kept around as a defensive copy that
 * the spec file pins against. If the unified type table ever drifts the assertion
 * in `extensions.spec.ts` will catch it before the change ships.
 *
 * Three exports:
 *   - `SUPPORTED_EXTENSIONS`            — the live list from
 *     `document-types.ts`.
 *   - `DEV_NOISY_EXTENSIONS`            — extensions in SUPPORTED that look
 *     too dev-noisy to use as a scenario signal (e.g. `.csv` is everywhere
 *     in plain data / analysis projects).
 *   - `SCENARIO_DETECTABLE_EXTENSIONS`  — convenience set: SUPPORTED minus
 *     DEV_NOISY. Hosts feed this to `hasLocalOfficeBinary` or their own collector.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCENARIO_DETECTABLE_EXTENSIONS = exports.DEV_NOISY_EXTENSIONS = exports.SUPPORTED_EXTENSIONS = exports.FALLBACK_SUPPORTED_EXTENSIONS = void 0;
const document_types_1 = require("./document-types");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Shared CJS list is consumed by builder configs.
const supportedExtensionsForAssociation = require('../../supported-extensions.cjs');
/**
 * Defensive copy of the extension list. Pinned by the
 * `FALLBACK_SUPPORTED_EXTENSIONS exact-equals SUPPORTED_EXTENSIONS` test in
 * `extensions.spec.ts` so a silent edit to the unified type table cannot regress
 * the supported file set.
 */
exports.FALLBACK_SUPPORTED_EXTENSIONS = supportedExtensionsForAssociation;
/**
 * Live list of office-binary extensions accepted by the bundled
 * `editor_sdk` binary, sourced from `document-types.ts`.
 * Lower-case, leading-dot.
 */
exports.SUPPORTED_EXTENSIONS = document_types_1.TENCENT_DOCS_ENGINE_SUPPORTED_EXTENSIONS;
/**
 * Extensions in `SUPPORTED_EXTENSIONS` that are too noisy to use as a
 * scenario signal. `.csv` shows up in plain data / analysis projects
 * unrelated to Tencent Docs editing; treating it as a scenario hit would
 * cause widespread false positives in the cwd-gated detector.
 *
 * Hosts running the scenario detector should subtract this set from
 * `SUPPORTED_EXTENSIONS` before feeding the result into
 * `hasLocalOfficeBinary` (or a host-owned scenario collector) — or simply use
 * `SCENARIO_DETECTABLE_EXTENSIONS` below.
 */
exports.DEV_NOISY_EXTENSIONS = new Set(['.csv', '.pdf']);
/**
 * Convenience: `SUPPORTED_EXTENSIONS` minus `DEV_NOISY_EXTENSIONS`, ready to
 * pass to `hasLocalOfficeBinary` or a host-owned scenario collector.
 */
exports.SCENARIO_DETECTABLE_EXTENSIONS = new Set(exports.SUPPORTED_EXTENSIONS.filter((ext) => !exports.DEV_NOISY_EXTENSIONS.has(ext)));
//# sourceMappingURL=extensions.js.map