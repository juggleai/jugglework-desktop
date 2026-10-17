"use strict";
/**
 * Scenario detector for the local Tencent Docs editing scenario.
 *
 * Strategy (S1): scan the **top level** of `cwd` once and check for any
 * "office binary" file. If at least one is found, the scenario is
 * considered active.
 *
 * Default extension set: this module ships with a deliberately small core
 * (`OFFICE_BINARY_EXTENSIONS` = `.docx` / `.xlsx` / `.pptx` / `.pdf`) as a
 * **fallback for callers that haven't taken on the engine layer's curated
 * extension set yet**. The 4-extension fallback excludes formats that show
 * up in unrelated projects (`.md`, `.csv`, legacy `.doc`/`.xls`/`.ppt`) so
 * we don't flag plain dev / data-analysis workspaces as "local-doc-editing".
 *
 * Production hosts should NOT rely on this fallback: they should pass the
 * curated `SCENARIO_DETECTABLE_EXTENSIONS` set re-exported from this package's
 * own `extensions.ts` (= the engine's `SUPPORTED_EXTENSIONS` minus
 * `DEV_NOISY_EXTENSIONS`) via either:
 *   - `hasLocalOfficeBinary(cwd, { extensions: SCENARIO_DETECTABLE_EXTENSIONS })`
 *     when calling the detector directly. Hosts that wrap a collector around this
 *     helper should pass the same extension set to their own collector wiring.
 * Doing so widens the detector to the engine's true supported set (≈25
 * extensions, including legacy formats and Tencent's `.wps` family).
 *
 * Topology: we do NOT recurse — recursion would balloon cost on big
 * workspaces and the false-positive risk grows quickly.
 *
 * Caching: results are memoised per `cwd` for `CACHE_TTL_MS` (default 60s)
 * so a burst of `prompt-renderer` invocations does not re-scan the dir on
 * every query. Cache misses are silently re-evaluated. Note that the cache
 * key is `cwd` only — if a single process queries the same `cwd` with two
 * different extension sets, the second query gets the first's cached value.
 * In practice each host process pins one extension set, so this is fine;
 * tests that exercise multiple sets should call
 * `clearScenarioDetectorCache()` between invocations.
 *
 * Failure mode: any IO error (cwd missing, no permission) returns `false`
 * without throwing — collectors should always degrade gracefully.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasLocalOfficeBinary = hasLocalOfficeBinary;
exports.clearScenarioDetectorCache = clearScenarioDetectorCache;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const OFFICE_BINARY_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx']);
const DEFAULT_CACHE_TTL_MS = 60_000;
const cache = new Map();
/**
 * Returns `true` if `cwd`'s top level contains at least one office binary
 * file. `false` on any IO failure or empty/missing input.
 */
async function hasLocalOfficeBinary(cwd, opts = {}) {
    if (!cwd) {
        return false;
    }
    const cacheKey = path.resolve(cwd);
    const ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const cached = cache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
        return cached.value;
    }
    const exts = opts.extensions ?? OFFICE_BINARY_EXTENSIONS;
    let value = false;
    try {
        const entries = await fs.readdir(cacheKey, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile()) {
                continue;
            }
            const ext = path.extname(entry.name).toLowerCase();
            if (exts.has(ext)) {
                value = true;
                break;
            }
        }
    }
    catch {
        value = false;
    }
    cache.set(cacheKey, { expiresAt: now + ttl, value });
    return value;
}
/** Test helper: drop the in-process cache. */
function clearScenarioDetectorCache() {
    cache.clear();
}
//# sourceMappingURL=scenario-detector.js.map