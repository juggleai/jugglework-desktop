"use strict";
/**
 * In-process wrapper around the bundled `editor_sdk` Mach-O / native binary
 * that ships with this package under `bin/<platform>-<arch>/editor_sdk`.
 *
 * The binary boots a single HTTP server (default `--port 39099`) that
 * simultaneously exposes:
 *   - `/mcp`               - JSON-RPC streamable-HTTP MCP endpoint consumed by
 *                            the agent CLI (registered under
 *                            `tencent-docs-local` in the host's MCP config).
 *   - `/static/{type}/...` - editor preview HTML / JS / WASM iframed by the
 *                            renderer. The four `{type}` namespaces are
 *                            `doc`, `sheet`, `slide`, and `pdf`;
 *                            their embedded resource bundles are baked into the
 *                            binary so no external `static/` directory is
 *                            required.
 *
 * Lifecycle:
 *   1. resolve the bundled binary path on disk;
 *   2. scan upward from the preferred port for the first available 127.0.0.1
 *      TCP slot (concurrent desktop instances must not collide on `39099`);
 *   3. `child_process.spawn(binary, ['--port', N, '--cors_origin=<comma-joined>', ...debugArgs])`;
 *   4. wait for either the binary's server-ready stdout line or a loopback TCP
 *      connect plus `/localapi/editor/status` check on the selected port —
 *      Windows builds may not surface stdout;
 *   5. `dispose()` SIGTERM → grace timeout → SIGKILL. Safe to call from
 *      `before-quit`.
 *
 * The native `editor_sdk` binary is downloaded at install time (see
 * `scripts/download-editor-sdk.js`) and resolved from `bin/<platform>-<arch>/`
 * at runtime. Spawn lifecycle, MCP readiness, preview URL helpers, and
 * extension metadata all live in this package so hosts depend on one surface.
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TencentDocsService = exports.SUPPORTED_EXTENSIONS_FROM_BINARY = void 0;
exports.resolveEditorSdkPlatformDir = resolveEditorSdkPlatformDir;
exports.resolveEditorSdkCwd = resolveEditorSdkCwd;
exports.buildPreviewUrl = buildPreviewUrl;
exports.getGlobalPadIdFromPreviewUrl = getGlobalPadIdFromPreviewUrl;
exports.buildEditorSdkSpawnArgs = buildEditorSdkSpawnArgs;
exports.resolveBinaryPath = resolveBinaryPath;
exports.resolveEditorSdkBinaryPath = resolveEditorSdkBinaryPath;
exports.normalizeTencentDocsDebugRestartOptions = normalizeTencentDocsDebugRestartOptions;
exports.findAvailablePort = findAvailablePort;
const node_crypto_1 = require("node:crypto");
const fs = __importStar(require("node:fs"));
const nodeNet = __importStar(require("node:net"));
const path = __importStar(require("node:path"));
const editor_sdk_platforms_js_1 = __importDefault(require("../../scripts/editor-sdk-platforms.js"));
const document_types_1 = require("./document-types");
const engine_port_file_1 = require("./engine-port-file");
const editor_sdk_process_launcher_1 = require("./editor-sdk-process-launcher");
const { resolveEditorSdkPlatformId } = editor_sdk_platforms_js_1.default;
const DEFAULT_PORT = '39099';
const DEFAULT_LOG_TAG = 'tencent-docs';
/**
 * Max time to wait for the binary's health endpoint after `spawn`.
 * The cold-boot path on a fresh machine inflates `Embedded
 * {pdf,doc,sheet,slide}.zip` decode latency; Windows can take ~8s before
 * `/health` returns 200. 60s leaves headroom for slower starts.
 */
const READINESS_TIMEOUT_MS = 60_000;
const READY_PROBE_INTERVAL_MS = 100;
/** Per-request abort for a single `/health` probe; kept separate from the
 * poll interval so a slightly slow reply is not aborted on the tick. */
const READY_PROBE_REQUEST_TIMEOUT_MS = 250;
const READY_PROBE_HOST = '127.0.0.1';
const HEALTH_PATH = '/health';
const LOCAL_EDITOR_STATUS_PATH = '/localapi/editor/status';
/**
 * 本地 editor_sdk HTTP 接口（status / save / close）的单次请求超时。无超时的话，预览关键
 * 路径上 `resolveFileId` 的 status 请求会在引擎冷启动/半死时永久挂起，拖死 `getPreviewUrl`
 * RPC（客户端无超时），renderer 表现为「一直加载中」。超时后最坏只是拿不到 file_id（走既有
 * 异步 hydration），预览 URL 仍能返回出图。
 */
const LOCAL_API_REQUEST_TIMEOUT_MS = 10_000;
/**
 * SIGTERM grace period before escalating to SIGKILL during `dispose()`. The
 * binary handles SIGTERM cleanly; this is just a watchdog for the case where
 * an unrelated bug wedges the loop.
 */
const SHUTDOWN_GRACE_MS = 2_000;
/**
 * How many sequential ports to probe when the preferred one is busy. The
 * range is small on purpose — concurrent desktop instances are a real
 * scenario but unbounded retry would mask real configuration mistakes.
 */
const PORT_SCAN_ATTEMPTS = 100;
/**
 * editor_sdk「就绪前退出」（多实例/残留并发抢同一端口时，bind 失败方会 code=0 立即退出、
 * TCP connection refused）时换下一个端口重试的最大次数。让冷启动在端口竞争下仍能最终起来，
 * 而不是直接判失败、把预览卡在「加载中」。
 */
const ENGINE_START_PORT_ATTEMPTS = 5;
const BINARY_NAME = process.platform === 'win32' ? 'editor_sdk.exe' : 'editor_sdk';
function resolveEditorSdkPlatformDir(platform = process.platform, arch = process.arch) {
    return resolveEditorSdkPlatformId(platform, arch);
}
const BINARY_PLATFORM_DIR = resolveEditorSdkPlatformDir();
async function probeHealthEndpointOnce(port) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), READY_PROBE_REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(`http://${READY_PROBE_HOST}:${port}${HEALTH_PATH}`, {
            signal: controller.signal,
        });
        if (response.status !== 200) {
            return { ready: false, detail: `HTTP ${response.status}` };
        }
        return { ready: true, detail: 'ok' };
    }
    catch (error) {
        return {
            ready: false,
            detail: error instanceof Error ? error.message : String(error),
        };
    }
    finally {
        clearTimeout(timer);
    }
}
/** 给 editor_sdk 本地 HTTP 调用加超时；超时抛 AbortError，由各调用方 try/catch 收敛为失败结果。 */
async function fetchLocalApiWithTimeout(input, init = {}, timeoutMs = LOCAL_API_REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // 组合调用方传入的 signal（如有）：外部取消时一并中断本次请求，避免静默丢弃 caller 的 signal（如 dispose 中断）。
    const externalSignal = init.signal;
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
        if (externalSignal.aborted) {
            controller.abort();
        }
        else {
            externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }
    }
    try {
        return await fetch(input, { ...init, signal: controller.signal });
    }
    finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener('abort', onExternalAbort);
    }
}
function resolveEditorSdkCwd(binaryPath) {
    return path.dirname(binaryPath);
}
const URL_CONFIG_MAP = {
    doc: {
        params: {
            local_edit: '1',
            client: 'sdk_local',
            mode: 'edit',
            toolbar: 'show',
            outline: 'show',
            statusbar: 'show',
        },
        readonlyParams: {
            mode: 'readonly',
            toolbar: 'hide',
            statusbar: 'hide',
        },
    },
    sheet: {
        params: { local_edit: '1', client: 'sdk_local_pure', mode: 'edit' },
        readonlyParams: { mode: 'readonly' },
    },
    slide: {
        params: { local_edit: '1', client: 'sdk_local_wb', hideTitlebar: '1' },
        readonlyParams: { client: 'sdk_local_preview' },
    },
    pdf: { params: {} },
};
function getPreviewUrlParams(type, mode) {
    const config = URL_CONFIG_MAP[type];
    if (mode !== 'readonly' || !config.readonlyParams) {
        return config.params;
    }
    return { ...config.params, ...config.readonlyParams };
}
/**
 * Flat list of every file extension this engine knows how to preview.
 * Lower-case, leading-dot. Used by `extensions.ts` as the live SSOT.
 */
exports.SUPPORTED_EXTENSIONS_FROM_BINARY = document_types_1.TENCENT_DOCS_ENGINE_SUPPORTED_EXTENSIONS;
/**
 * Pure: given an engine port and an absolute local file path, return the
 * `/static/<type>/pc.html?...` URL that the renderer can iframe to preview
 * the file. Throws when the file extension is not in the unified engine type table.
 *
 * Exported (and not tucked behind the class) so callers and unit tests can
 * derive the URL without spawning the engine.
 */
function buildPreviewUrl(port, filePath, options = {}) {
    const type = (0, document_types_1.getTencentDocsEngineDocType)(filePath);
    if (!type) {
        throw new Error(`Unsupported file type: ${path.extname(filePath).toLowerCase()}`);
    }
    const mode = options.mode ?? 'edit';
    const typeParams = getPreviewUrlParams(type, mode);
    // `globalPadId` 是 SDK 侧识别“同一份本地文档”的稳定身份。
    // 不能为了多开 preview 改成随机 per-view ID；同文件跨窗口/iframe 的并发冲突
    // 应由宿主做去重，保持这里的文档身份语义稳定。
    const globalPadId = (0, node_crypto_1.createHash)('md5').update(filePath).digest('hex');
    const docExtras = type === 'doc' ? { editorSdkUrl: `http://127.0.0.1:${port}` } : {};
    const params = new URLSearchParams({
        title: path.basename(filePath),
        localFilePath: filePath,
        globalPadId,
        ...typeParams,
        ...docExtras,
    });
    return `http://127.0.0.1:${port}/static/${type}/pc.html?${params.toString()}`;
}
function getGlobalPadIdFromPreviewUrl(previewUrl) {
    if (!previewUrl) {
        return undefined;
    }
    try {
        const parsed = new URL(previewUrl);
        const globalPadId = parsed.searchParams.get('globalPadId')?.trim();
        return globalPadId || undefined;
    }
    catch {
        return undefined;
    }
}
/** gflags `--cors_origin` 单值：拒绝逗号/空白注入，仅允许 `*` 或合法 origin URL。 */
const EDITOR_SDK_CORS_ORIGIN_RE = /^[a-z][a-z0-9+.-]*:\/\/[^\s,]+$/i;
function isSafeEditorSdkCorsOrigin(origin) {
    return origin === '*' || EDITOR_SDK_CORS_ORIGIN_RE.test(origin);
}
function normalizeEditorSdkCorsOrigins(origins) {
    return origins?.map((o) => o.trim()).filter((o) => o && isSafeEditorSdkCorsOrigin(o)) ?? [];
}
function buildEditorSdkSpawnArgs(port, staticDirOrOptions, legacyEnableTdProxy) {
    // Back-compat: historical signature was `(port, staticDir)`. Accept
    // either a string (legacy) or an options object so existing callers
    // (and the snapshot tests in `tencent-docs-service.spec.ts`) keep
    // working unchanged.
    const options = typeof staticDirOrOptions === 'string' || staticDirOrOptions === undefined
        ? { staticDir: staticDirOrOptions, enableTdProxy: legacyEnableTdProxy }
        : staticDirOrOptions;
    const args = ['--port', port];
    const corsOrigins = normalizeEditorSdkCorsOrigins(options.corsOrigins);
    if (corsOrigins.length > 0) {
        // spawn 不经 shell，勿给值加引号，否则 editor_sdk 会收到字面量 `"https://..."`。
        args.push(`--cors_origin=${corsOrigins.join(',')}`);
    }
    const normalizedStaticDir = options.staticDir?.trim();
    if (normalizedStaticDir) {
        args.push(`--static_dir=${normalizedStaticDir}`);
    }
    const normalizedLogDir = options.logDir?.trim();
    if (normalizedLogDir) {
        args.push('--log_dir', normalizedLogDir);
    }
    // Strict `=== true` so accidental truthy values (e.g. the string
    // `'false'` from a config file, `null`, `1`) cannot silently flip the
    // proxy flag on. Default behavior — omit the flag — is the safe path.
    if (options.enableTdProxy === true) {
        args.push('-td_proxy=true');
    }
    return args;
}
/**
 * Resolve the absolute path to the bundled `editor_sdk` binary for this
 * platform/arch, or null if it is not shipped (e.g. running on linux-x64
 * with no matching directory yet).
 *
 * Two candidate roots are tried, in order:
 *   1. `<package>/bin/<platform>-<arch>/<binary>` — works for both `src/`
 *      (under ts-node / mocha) and `lib/` (after `tsc` compile) because
 *      both files land two directories below the package root, so the
 *      relative `../../bin/...` shape is identical.
 *   2. `app.asar.unpacked` rewrite of (1) — electron-builder unpacks
 *      anything matched by `asarUnpack` into `app.asar.unpacked/...` at
 *      package time, so the dev path `<asar>/.../bin/...` becomes
 *      `<asar.unpacked>/.../bin/...` at runtime. macOS / Linux in dev
 *      ignore the rewrite (no `app.asar` segment); production with asar
 *      packaging picks it up.
 *
 * Exported for unit tests; not part of the public package surface.
 */
function resolveBinaryPath(hotUpdateDir) {
    // 1. Try hot-update directory (OTA-pushed newer binary)
    const normalizedHotDir = hotUpdateDir?.trim();
    if (normalizedHotDir) {
        const hotBinary = path.join(normalizedHotDir, BINARY_NAME);
        try {
            if (fs.statSync(hotBinary).isFile()) {
                return hotBinary;
            }
        }
        catch {
            // Hot-update dir missing or incomplete — fall through to bundled.
        }
    }
    // 2. Fall back to bundled bin path
    const baseRel = path.join(__dirname, '..', '..', 'bin', BINARY_PLATFORM_DIR, BINARY_NAME);
    const asarUnpacked = baseRel.replace(/([\\/])app\.asar\1/, '$1app.asar.unpacked$1');
    // In packaged Electron apps, `fs.statSync()` can see files inside
    // `app.asar`, but native `spawn()` cannot execute that virtual path.
    // Prefer the real unpacked path whenever the asar rewrite applies.
    const candidates = baseRel === asarUnpacked ? [baseRel] : [asarUnpacked, baseRel];
    for (const candidate of candidates) {
        try {
            if (fs.statSync(candidate).isFile()) {
                return candidate;
            }
        }
        catch {
            // statSync throws on missing path; try next candidate.
        }
    }
    return null;
}
function resolveEditorSdkBinaryPath(editorSdkPath, hotUpdateDir) {
    const normalizedEditorSdkPath = editorSdkPath?.trim();
    if (normalizedEditorSdkPath) {
        try {
            if (fs.statSync(normalizedEditorSdkPath).isFile()) {
                return normalizedEditorSdkPath;
            }
        }
        catch {
            // editorSdkPath missing or not a file — fall through to resolveBinaryPath.
        }
    }
    return resolveBinaryPath(hotUpdateDir);
}
function normalizeTencentDocsDebugRestartOptions({ staticDir, editorSdkPath, }) {
    const normalizedStaticDir = staticDir?.trim() || undefined;
    const normalizedEditorSdkPath = editorSdkPath?.trim() || undefined;
    if (!normalizedStaticDir && !normalizedEditorSdkPath) {
        throw new Error('Tencent Docs debug restart requires static_dir or editor_sdk path');
    }
    return {
        ...(normalizedStaticDir ? { staticDir: normalizedStaticDir } : {}),
        ...(normalizedEditorSdkPath ? { editorSdkPath: normalizedEditorSdkPath } : {}),
    };
}
/**
 * Try to bind a TCP server on the given (port, host) pair and immediately
 * release it. Returns `true` iff the bind succeeded. `host=undefined` uses
 * Node's default unspecified address (`'::'` — dual-stack IPv6 on macOS /
 * Linux unless `IPV6_V6ONLY` is forced).
 */
function tryBind(port, host) {
    return new Promise((resolve) => {
        const server = nodeNet.createServer();
        server.unref();
        const onError = () => {
            server.removeAllListeners();
            resolve(false);
        };
        server.once('error', onError);
        server.once('listening', () => {
            server.removeListener('error', onError);
            server.close(() => resolve(true));
        });
        if (host === undefined) {
            server.listen(port);
        }
        else {
            server.listen(port, host);
        }
    });
}
/**
 * Verify that `port` is free for `editor_sdk` to take AND for the agent CLI
 * to actually reach over `http://127.0.0.1:<port>/mcp`.
 *
 * Two probes are required, in order, because of how BSD / macOS routes TCP
 * accept() between listeners of different families on the same port:
 *
 *   1. **dual-stack `:::port`** — matches the family `editor_sdk` itself
 *      binds (Node-style unspecified IPv6 with `IPV6_V6ONLY=0`). If this
 *      probe fails, the binary's own bind would also fail and `--port`
 *      cannot take the slot; skip the candidate.
 *
 *   2. **IPv4 single-bind `127.0.0.1:port`** — the address family the
 *      `--mcp-config` URL and `buildPreviewUrl` hand to the CLI / renderer.
 *      BSD routes accept() to the *most specific* matching listener: a
 *      dual-stack IPv6 occupant lets an IPv4 single-bind on the same port
 *      succeed (the more specific 4-tuple wins), and any IPv4 traffic to
 *      127.0.0.1:port is then silently captured by that IPv4 imposter
 *      instead of reaching our dual-stack `editor_sdk`. The MCP request
 *      lands on an unrelated service that returns its own 4xx — the CLI
 *      sees an empty `tools/list` and the local-doc scenario collapses to
 *      a misleading Bash / Read fallback with no error breadcrumb.
 *
 *      Observed in the wild when this repo's workbuddy dev and
 *      `electron-app` dev (which runs its own IPv4 IPC server on the same
 *      port range) coexist: workbuddy spawned `editor_sdk` on `:::39100`,
 *      `electron-app` already held `127.0.0.1:39100`, the dual-stack-only
 *      probe reported "free", and the agent's MCP calls were routed into
 *      electron-app's `{"error":"not_found"}` endpoint instead.
 *
 * A small TOCTOU window remains between the two probes and the binary's
 * subsequent bind. The 10s readiness watcher catches the rare case where
 * another process steals the port between probe and spawn; we don't harden
 * further because pre-flight false-negatives just push the scan to the
 * next candidate (cheap) while false-positives silently route MCP traffic
 * into a foreign service (expensive — exactly the bug this guard fixes).
 */
async function isPortFree(port) {
    if (!(await tryBind(port))) {
        return false;
    }
    if (!(await tryBind(port, '127.0.0.1'))) {
        return false;
    }
    return true;
}
/**
 * Scan from `preferred` upward for the first free port. Throws when
 * `attempts` consecutive ports are all busy: a real configuration problem
 * the caller should surface, not paper over.
 *
 * Exported for unit tests; not part of the public package surface.
 */
async function findAvailablePort(preferred, attempts = PORT_SCAN_ATTEMPTS) {
    for (let i = 0; i < attempts; i++) {
        const candidate = preferred + i;
        if (await isPortFree(candidate)) {
            return candidate;
        }
    }
    throw new Error(`No free port found in range ${preferred}..${preferred + attempts - 1}`);
}
/**
 * Subscribe to a child-process readable stream and invoke `onLine` once
 * per newline-terminated chunk. Returns an unsubscribe function that
 * detaches the listener and flushes any trailing partial line so the
 * final pre-EOF log isn't dropped on dispose.
 *
 * Used to forward `editor_sdk`'s stdout/stderr into the host's
 * `EngineLogger`. Without an active reader the OS pipe buffer (~64KB on
 * macOS) eventually fills and the binary blocks on `write()`, so this
 * also doubles as the engine's stream drain.
 *
 * Empty lines are skipped — the binary occasionally emits trailing
 * blank lines after structured output, and surfacing them as bare
 * `info('')` calls only adds noise to TDLog.
 */
function subscribeLines(stream, onLine) {
    if (!stream) {
        return () => {
            /* no-op */
        };
    }
    let buf = '';
    const onData = (chunk) => {
        buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
            const raw = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
            if (line.length > 0) {
                onLine(line);
            }
            nl = buf.indexOf('\n');
        }
    };
    stream.on('data', onData);
    return () => {
        stream.removeListener('data', onData);
        if (buf.length > 0) {
            const line = buf.endsWith('\r') ? buf.slice(0, -1) : buf;
            buf = '';
            if (line.length > 0) {
                onLine(line);
            }
        }
    };
}
function defaultConsoleLogger(tag) {
    const prefix = `[${tag}]`;
    return {
        info: (message, extra) => {
            if (extra) {
                console.info(prefix, message, extra);
            }
            else {
                console.info(prefix, message);
            }
        },
        warn: (message, extra) => {
            if (extra) {
                console.warn(prefix, message, extra);
            }
            else {
                console.warn(prefix, message);
            }
        },
    };
}
async function readJsonBody(response) {
    try {
        const body = await response.json();
        return body && typeof body === 'object' && !Array.isArray(body)
            ? body
            : undefined;
    }
    catch {
        return undefined;
    }
}
function readString(value) {
    return typeof value === 'string' ? value : undefined;
}
function readNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function readBoolean(value) {
    return typeof value === 'boolean' ? value : undefined;
}
function readOpenEditors(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.flatMap((item) => {
        if (!item || typeof item !== 'object') {
            return [];
        }
        const editor = item;
        const fileId = readString(editor.file_id);
        const filePath = readString(editor.file_path);
        const type = readString(editor.type);
        const isDirty = readBoolean(editor.is_dirty);
        if (!fileId || filePath === undefined || !type || isDirty === undefined) {
            return [];
        }
        return [
            {
                file_id: fileId,
                file_path: filePath,
                type,
                is_dirty: isDirty,
                last_saved_ms: readNumber(editor.last_saved_ms),
            },
        ];
    });
}
/**
 * Wrapper around the bundled `editor_sdk` binary that owns lazy boot,
 * stdout-based readiness detection, and graceful shutdown.
 */
class TencentDocsService {
    constructor(options = {}) {
        this.proc = null;
        this.started = false;
        this.starting = null;
        /**
         * Unsubscribe handles for the persistent stdout/stderr line pumps
         * attached in `doStart()`. Survives readiness (the readiness watcher
         * only owns its own raw-chunk listener) so the binary's terminal
         * logs continue to flow into `this.logger` for the lifetime of the
         * child. Disposed in the `doStart` failure path and from `dispose()`
         * to flush trailing partial lines and avoid handler leaks across
         * re-spawn cycles.
         */
        this.streamLogDisposers = [];
        /**
         * Disposer for the permanent post-readiness `proc.on('exit'|'error')`
         * watcher installed at the end of `doStart()`. Detached by `dispose()`
         * BEFORE the SIGTERM kill so the deliberate teardown path doesn't trip
         * the unexpected-exit branch. Stored as a single closure (not pair of
         * listener refs) so the cleanup is symmetric with the install site and
         * survives re-spawn cycles without leaking handlers.
         */
        this.exitWatcherDisposer = null;
        const requested = options.port ?? DEFAULT_PORT;
        this.port = /^\d+$/.test(requested) ? requested : DEFAULT_PORT;
        this.staticDir = options.staticDir?.trim() || undefined;
        this.logDir = options.logDir?.trim() || undefined;
        this.enableTdProxy = options.enableTdProxy === true;
        this.corsOrigins = options.corsOrigins ?? [];
        this.editorSdkPath = options.editorSdkPath?.trim() || undefined;
        this.editorSdkHotUpdateDir = options.editorSdkHotUpdateDir?.trim() || undefined;
        this.editorSdkProcessLauncher =
            options.editorSdkProcessLauncher ?? editor_sdk_process_launcher_1.nodeEditorSdkProcessLauncher;
        const tag = options.logTag ?? DEFAULT_LOG_TAG;
        this.logger = options.logger ?? defaultConsoleLogger(tag);
        this.onUnexpectedExit = options.onUnexpectedExit;
        this.onEngineReady = options.onEngineReady;
        if (options.portFileRootDir) {
            this.portFilePath = (0, engine_port_file_1.resolveEnginePortFilePath)(options.portFileRootDir);
        }
    }
    /**
     * Pre-flight check used by prompt-render hot paths: verifies the bundled
     * `editor_sdk` binary exists for the current platform/arch so we don't
     * inject a system prompt that points at tools the runtime cannot reach.
     * Read-only; does NOT actually start the binary.
     */
    async canEnsureStart() {
        if (this.started || this.starting) {
            return true;
        }
        // 与 doStart() / restartWithStaticDir() 实际启动路径用同一组解析规则：
        // 既看 hot-update 目录、也看显式注入的 editorSdkPath，避免仅靠 editorSdkPath
        // 调试覆盖时把场景预检 gate 在 false。
        return resolveEditorSdkBinaryPath(this.editorSdkPath, this.editorSdkHotUpdateDir) !== null;
    }
    /** Whether the binary has reached a started state. */
    isStarted() {
        return this.started;
    }
    /**
     * Engine HTTP port (decimal string, e.g. `'39099'`). Returns the
     * preferred port before `ensureStarted()` resolves and the
     * actually-bound port after — call sites that need URL accuracy should
     * `await ensureStarted()` first (see `TencentDocsServiceOptions.port`).
     */
    getPort() {
        return this.port;
    }
    /**
     * Idempotent start: the first call spawns the binary and waits for its
     * ready-marker stdout line; subsequent calls await the cached promise.
     */
    async ensureStarted() {
        if (this.started) {
            return;
        }
        if (this.starting) {
            await this.starting;
            return;
        }
        this.starting = this.doStart();
        await this.starting;
    }
    async restartWithStaticDir(staticDir, editorSdkPath) {
        const config = normalizeTencentDocsDebugRestartOptions({ staticDir, editorSdkPath });
        if (this.starting) {
            try {
                await this.starting;
            }
            catch {
                // The dispose path below resets partial start state before retrying.
            }
        }
        await this.dispose();
        this.staticDir = config.staticDir;
        this.editorSdkPath = config.editorSdkPath;
        await this.ensureStarted();
    }
    /**
     * Resolve a `static/<type>/pc.html` preview URL for the given absolute
     * file path. Implicitly calls `ensureStarted()`. Throws synchronously
     * (after the start completes) when the file extension is not supported.
     */
    async getPreviewUrl(filePath, options = {}) {
        await this.ensureStarted();
        return buildPreviewUrl(this.port, filePath, options);
    }
    /**
     * Query the editor pool by the local path registered through the preview
     * page's SDK open flow. This is the HTTP equivalent of MCP
     * `get_pool_status`, but scoped inside the Tencent Docs engine wrapper so
     * WorkBuddy callers do not need to know the SDK endpoint shape.
     */
    async getEditorStatusByFilePath(filePath) {
        return this.getEditorStatus({ filePath });
    }
    async getEditorStatusByFileId(fileId) {
        return this.getEditorStatus({ fileId });
    }
    async getEditorStatus(params) {
        if (!this.started) {
            return { success: false, error: 'Tencent Docs editor_sdk is not started' };
        }
        const url = new URL(`http://127.0.0.1:${this.port}${LOCAL_EDITOR_STATUS_PATH}`);
        if (params.fileId) {
            url.searchParams.set('file_id', params.fileId);
        }
        try {
            const response = await fetchLocalApiWithTimeout(url);
            const body = await readJsonBody(response);
            if (response.status === 404) {
                return {
                    success: true,
                    status: response.status,
                    notFound: true,
                    message: readString(body?.message),
                    openEditors: [],
                };
            }
            if (!response.ok) {
                return {
                    success: false,
                    status: response.status,
                    message: readString(body?.message),
                    error: `editor status failed with HTTP ${response.status}`,
                };
            }
            const allOpenEditors = readOpenEditors(body?.open_editors);
            const openEditors = params.filePath
                ? allOpenEditors.filter((editor) => editor.file_path === params.filePath)
                : allOpenEditors;
            if (params.filePath && openEditors.length === 0) {
                return {
                    success: true,
                    status: response.status,
                    notFound: true,
                    message: `no editor open for file_path=${params.filePath}`,
                    poolSize: readNumber(body?.pool_size),
                    openEditors: [],
                };
            }
            return {
                success: true,
                status: response.status,
                message: readString(body?.message),
                poolSize: readNumber(body?.pool_size),
                openEditors,
            };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    /**
     * Save one opened editor through editor_sdk's HTTP API. This intentionally
     * uses `/localapi/save` directly instead of invoking the MCP `save_file`
     * tool so host UI actions do not depend on agent tool routing.
     */
    async saveEditor(fileId, options = {}) {
        if (!this.started) {
            return { success: false, fileId, error: 'Tencent Docs editor_sdk is not started' };
        }
        try {
            const response = await fetchLocalApiWithTimeout(`http://127.0.0.1:${this.port}/localapi/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_id: fileId,
                    ...(options.filePath ? { file_path: options.filePath } : {}),
                    ...(options.content ? { content: options.content } : {}),
                }),
            });
            const body = await readJsonBody(response);
            if (!response.ok || readNumber(body?.code) === -1) {
                return {
                    success: false,
                    status: response.status,
                    fileId: readString(body?.file_id) ?? fileId,
                    filePath: readString(body?.file_path),
                    message: readString(body?.message),
                    error: readString(body?.message) ?? `editor save failed with HTTP ${response.status}`,
                };
            }
            return {
                success: true,
                status: response.status,
                fileId: readString(body?.file_id) ?? fileId,
                filePath: readString(body?.file_path),
                message: readString(body?.message),
            };
        }
        catch (error) {
            return {
                success: false,
                fileId,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    /**
     * Close one editor in the local SDK pool.
     *
     * Current WorkBuddy preview close policy is forceful: when a user
     * closes the independent window we release the SDK editor even if it is
     * dirty. If this changes to non-force close later, the caller must add a
     * save/discard/cancel interaction before passing `force: false`; simply
     * flipping this boolean would turn dirty files into silent 409 failures.
     */
    async closeEditor(fileId, options = {}) {
        if (!this.started) {
            return { success: false, fileId, error: 'Tencent Docs editor_sdk is not started' };
        }
        try {
            const response = await fetchLocalApiWithTimeout(`http://127.0.0.1:${this.port}/localapi/editor/close`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_id: fileId,
                    ...(options.force ? { force: true } : {}),
                }),
            });
            const body = await readJsonBody(response);
            if (response.status === 404) {
                return {
                    success: true,
                    status: response.status,
                    fileId,
                    notFound: true,
                    message: readString(body?.message),
                };
            }
            if (!response.ok) {
                return {
                    success: false,
                    status: response.status,
                    fileId,
                    message: readString(body?.message),
                    isDirty: readBoolean(body?.is_dirty),
                    error: `editor close failed with HTTP ${response.status}`,
                };
            }
            return {
                success: true,
                status: response.status,
                fileId: readString(body?.file_id) ?? fileId,
                message: readString(body?.message),
                wasDirty: readBoolean(body?.was_dirty),
            };
        }
        catch (error) {
            return {
                success: false,
                fileId,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    /** Graceful shutdown. Safe to call from `app.on('before-quit')`. */
    async dispose() {
        // Detach the post-readiness watcher BEFORE we kill so the SIGTERM
        // exit doesn't fire the "unexpected exit" branch on the host. The
        // dispose's own `proc.once('exit', ...)` below still observes the
        // child's actual departure for the SIGKILL escalation timer.
        this.detachExitWatcher();
        const { proc } = this;
        if (proc && !proc.killed) {
            try {
                proc.requestStop();
                await new Promise((resolve) => {
                    const escalate = setTimeout(() => {
                        try {
                            proc.forceStop();
                        }
                        catch {
                            /* already gone */
                        }
                        resolve();
                    }, SHUTDOWN_GRACE_MS);
                    proc.once('exit', () => {
                        clearTimeout(escalate);
                        resolve();
                    });
                });
            }
            catch (err) {
                this.logger.warn('engine stop error', String(err?.message || err));
            }
        }
        this.detachStreamLog();
        this.deletePortFileIfConfigured();
        this.proc = null;
        this.started = false;
        this.starting = null;
    }
    writePortFileIfConfigured() {
        if (this.portFilePath) {
            try {
                (0, engine_port_file_1.writePortFile)(this.portFilePath, this.port);
            }
            catch (err) {
                this.logger.warn('failed to write port file', String(err?.message || err));
            }
        }
    }
    deletePortFileIfConfigured() {
        if (this.portFilePath) {
            (0, engine_port_file_1.deletePortFile)(this.portFilePath);
        }
    }
    async doStart() {
        const binaryPath = resolveEditorSdkBinaryPath(this.editorSdkPath, this.editorSdkHotUpdateDir);
        if (!binaryPath) {
            if (this.editorSdkPath) {
                throw new Error(`Tencent Docs editor_sdk path is not a file: ${this.editorSdkPath}`);
            }
            // Binary missing for this platform: leave us "unstarted" so
            // callers and env-checks degrade gracefully. Reset `starting`
            // so a future call can retry once the binary lands.
            this.logger.warn('editor_sdk binary not bundled for this platform', `looked under bin/${BINARY_PLATFORM_DIR}/${BINARY_NAME}`);
            this.starting = null;
            return;
        }
        const binaryCwd = resolveEditorSdkCwd(binaryPath);
        const preferred = parseInt(this.port, 10);
        let scanFrom = preferred;
        let lastError;
        // editor_sdk 在就绪前退出时换端口重试：多实例/残留并发抢同一端口时，bind 失败的一方会
        // code=0 立即退出（TCP connection refused）。换下一个端口重试，让冷启动最终能起来，
        // 而不是直接判失败、把预览卡在「加载中」。只对「就绪前退出」换端口；就绪超时等不重试。
        for (let attempt = 0; attempt < ENGINE_START_PORT_ATTEMPTS; attempt++) {
            let actual;
            try {
                actual = await findAvailablePort(scanFrom);
            }
            catch (err) {
                lastError = err;
                break;
            }
            if (actual !== preferred && attempt === 0) {
                this.logger.info('preferred port busy, falling back', `from=${preferred} to=${actual}`);
            }
            this.port = String(actual);
            const spawnArgs = buildEditorSdkSpawnArgs(this.port, {
                staticDir: this.staticDir,
                logDir: this.logDir,
                corsOrigins: this.corsOrigins,
                enableTdProxy: this.enableTdProxy,
            });
            const corsOriginArg = spawnArgs.find((arg) => arg.startsWith('--cors_origin='));
            const corsOriginLog = corsOriginArg?.slice('--cors_origin='.length);
            this.logger.info('spawning editor_sdk', `port=${this.port} bin=${binaryPath} cwd=${binaryCwd}` +
                `${this.staticDir ? ` staticDir=${this.staticDir}` : ''}` +
                `${this.enableTdProxy ? ' tdProxy=true' : ''}` +
                `${corsOriginLog ? ` corsOrigin=${corsOriginLog}` : ''}` +
                `${attempt > 0 ? ` attempt=${attempt + 1}` : ''}`);
            // 完整 argv 便于对照进程命令行 / 排查 cors_origin 是否按预期下发。
            this.logger.info('editor_sdk spawn argv', JSON.stringify({ binary: binaryPath, cwd: binaryCwd, args: spawnArgs }));
            const proc = this.editorSdkProcessLauncher.launch({
                binaryPath,
                args: spawnArgs,
                cwd: binaryCwd,
            });
            this.proc = proc;
            this.attachStreamLog(proc);
            try {
                await this.waitForReady(proc);
            }
            catch (err) {
                lastError = err;
                const message = String(err?.message || err);
                // 仅「就绪前退出」（疑似端口被抢占）才换端口重试；其余错误或末次尝试由循环后统一清理。
                if (!message.includes('exited before ready') || attempt >= ENGINE_START_PORT_ATTEMPTS - 1) {
                    break;
                }
                // 换端口重试前先清理当前进程与日志管道。
                await this.killProcQuietly();
                this.detachStreamLog();
                scanFrom = actual + 1;
                this.logger.warn('editor_sdk exited before ready, retrying on next port', `failedPort=${actual} attempt=${attempt + 1}`);
                continue;
            }
            this.started = true;
            this.writePortFileIfConfigured();
            this.logger.info('engine started', `port=${this.port}`);
            try {
                this.onEngineReady?.();
            }
            catch (err) {
                this.logger.warn('onEngineReady callback threw', String(err?.message || err));
            }
            // Permanent watcher for the running phase. Must be installed
            // AFTER `waitForReady` (whose own short-lived `onExit`/`onError`
            // listeners are detached on settle) so the two don't race on
            // the same event. See `installExitWatcher` for the reset
            // semantics that close the silent-failure window where the
            // child crashed but `started` stayed `true`.
            this.installExitWatcher(proc);
            return;
        }
        this.logger.warn('engine start failed', String(lastError?.message || lastError));
        await this.killProcQuietly();
        this.detachStreamLog();
        this.detachExitWatcher();
        this.starting = null;
        throw lastError ?? new Error('editor_sdk did not become ready');
    }
    async killProcQuietly() {
        const { proc } = this;
        if (proc && !proc.killed) {
            try {
                proc.forceStop();
            }
            catch {
                /* already gone */
            }
        }
        this.proc = null;
    }
    /**
     * Bridge `editor_sdk`'s stdout/stderr to `this.logger`. stdout lines
     * land on `info` (the binary's normal status output) and stderr lines
     * on `warn` (anything the binary chose to send to fd 2 is at least
     * surfaced even if not strictly an error). The `extra` field carries
     * the originating stream name so adapters that bridge to richer
     * loggers (electron-app's `TDLog`) can tag the source without
     * reparsing the message.
     *
     * Runs alongside `waitForReady`'s own raw-chunk listener; Node
     * dispatches `data` to both consumers so readiness detection and log
     * forwarding stay independent (the readiness watcher detaches itself
     * on settle; this pump survives until `dispose`).
     */
    attachStreamLog(proc) {
        this.detachStreamLog();
        this.streamLogDisposers = [
            subscribeLines(proc.stdout, (line) => this.logger.info(line, 'stdout')),
            subscribeLines(proc.stderr, (line) => this.logger.warn(line, 'stderr')),
        ];
    }
    detachStreamLog() {
        for (const dispose of this.streamLogDisposers) {
            try {
                dispose();
            }
            catch {
                /* best-effort flush */
            }
        }
        this.streamLogDisposers = [];
    }
    /**
     * Install the permanent post-readiness exit/error watcher. Closes the
     * silent-failure window where the child died after `waitForReady`
     * resolved (crash / OOM-kill / external SIGKILL / IPC EPIPE / ...).
     * Without this, `started` would stay pinned at `true`, `getPort()` /
     * `getPreviewUrl()` would happily return URLs that point at a dead
     * port, and the renderer would just see `ECONNREFUSED` with zero
     * service-side breadcrumbs explaining why.
     *
     * Reset semantics on fire (matching what `dispose()` does, minus the
     * SIGTERM block since the child is already gone):
     *   1. WARN-log `port / code / signal / uptimeMs` so production logs
     *      explain the death;
     *   2. clear `proc / started / starting` so the next `ensureStarted()`
     *      truly re-spawns instead of short-circuiting on the cached
     *      "already running" flag (the resolved `starting` promise would
     *      otherwise let `ensureStarted` no-op forever);
     *   3. flush the stdout/stderr line pumps via `detachStreamLog()`
     *      so any final pre-EOF stderr line lands in the host log;
     *   4. invoke the host's `onUnexpectedExit` callback (if any) with
     *      a snapshot of code/signal/uptime/port so the host can decide
     *      whether to immediately re-arm the engine.
     *
     * The `this.proc === proc` guards everywhere defend against a race
     * where the host disposes-and-respawns between our exit event being
     * queued and this handler running — we must not clobber state that
     * a fresh spawn already owns.
     */
    installExitWatcher(proc) {
        this.detachExitWatcher();
        const startedAtMs = Date.now();
        const handle = (code, signal, error) => {
            cleanup();
            const uptimeMs = Date.now() - startedAtMs;
            const { port } = this;
            if (error) {
                this.logger.warn('editor_sdk child error', `port=${port} uptimeMs=${uptimeMs} error=${error.message}`);
            }
            else {
                this.logger.warn('editor_sdk exited unexpectedly', `port=${port} code=${code} signal=${signal} uptimeMs=${uptimeMs}`);
            }
            if (this.proc === proc) {
                this.proc = null;
                this.started = false;
                this.starting = null;
                this.detachStreamLog();
                this.deletePortFileIfConfigured();
            }
            const callback = this.onUnexpectedExit;
            if (callback) {
                try {
                    callback({ code, signal, uptimeMs, port, error });
                }
                catch (cbErr) {
                    this.logger.warn('onUnexpectedExit callback threw', String(cbErr?.message || cbErr));
                }
            }
        };
        const onExit = (code, signal) => handle(code, signal);
        const onError = (err) => handle(null, null, err);
        const cleanup = () => {
            proc.removeListener('exit', onExit);
            proc.removeListener('error', onError);
        };
        proc.on('exit', onExit);
        proc.on('error', onError);
        this.exitWatcherDisposer = cleanup;
    }
    detachExitWatcher() {
        const dispose = this.exitWatcherDisposer;
        this.exitWatcherDisposer = null;
        if (dispose) {
            try {
                dispose();
            }
            catch {
                /* best-effort */
            }
        }
    }
    /**
     * Resolves when the selected loopback port's health endpoint returns HTTP
     * 200. Rejects on binary error / early exit / readiness timeout. The caller
     * is responsible for tearing down the process on rejection (see `doStart`'s
     * catch).
     */
    waitForReady(proc) {
        return new Promise((resolve, reject) => {
            let stdoutBuffer = '';
            let stderrBuffer = '';
            let lastHealthProbe = 'not attempted';
            let lastLoggedHealthProbe = null;
            let settled = false;
            let healthProbeTimer = null;
            let healthProbeInFlight = false;
            const onStdout = (chunk) => {
                stdoutBuffer += chunk.toString('utf8');
            };
            const onStderr = (chunk) => {
                stderrBuffer += chunk.toString('utf8');
            };
            const onExit = (code, signal) => {
                settle(() => reject(new Error(`editor_sdk exited before ready (code=${code} signal=${signal}). ` +
                    `last health probe: ${lastHealthProbe}. ` +
                    `stderr: ${stderrBuffer.slice(0, 500)}`)));
            };
            const onError = (err) => settle(() => reject(err));
            const probeHealthEndpoint = async () => {
                if (settled || healthProbeInFlight) {
                    return;
                }
                healthProbeInFlight = true;
                try {
                    const healthProbe = await probeHealthEndpointOnce(this.port);
                    if (settled) {
                        return;
                    }
                    lastHealthProbe = healthProbe.detail;
                    if (!healthProbe.ready) {
                        if (lastLoggedHealthProbe !== healthProbe.detail) {
                            lastLoggedHealthProbe = healthProbe.detail;
                            this.logger.warn('editor_sdk health endpoint not ready', `port=${this.port} detail=${healthProbe.detail}`);
                        }
                        return;
                    }
                    this.logger.info('editor_sdk health endpoint ready', `port=${this.port}`);
                    settle(() => resolve());
                }
                catch (error) {
                    if (settled) {
                        return;
                    }
                    lastHealthProbe = error instanceof Error ? error.message : String(error);
                }
                finally {
                    healthProbeInFlight = false;
                }
            };
            const timer = setTimeout(() => settle(() => reject(new Error(`editor_sdk did not become ready within ${READINESS_TIMEOUT_MS}ms ` +
                `on port ${this.port}. last stdout: ${stdoutBuffer.slice(-200)} ` +
                `last stderr: ${stderrBuffer.slice(-200)} ` +
                `last health probe: ${lastHealthProbe}`))), READINESS_TIMEOUT_MS);
            const cleanup = () => {
                clearTimeout(timer);
                if (healthProbeTimer) {
                    clearInterval(healthProbeTimer);
                    healthProbeTimer = null;
                }
                proc.stdout?.removeListener('data', onStdout);
                proc.stderr?.removeListener('data', onStderr);
                proc.removeListener('exit', onExit);
                proc.removeListener('error', onError);
            };
            const settle = (handler) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                handler();
            };
            proc.stdout?.on('data', onStdout);
            proc.stderr?.on('data', onStderr);
            proc.on('exit', onExit);
            proc.on('error', onError);
            probeHealthEndpoint().catch((error) => {
                lastHealthProbe = error instanceof Error ? error.message : String(error);
            });
            healthProbeTimer = setInterval(() => {
                probeHealthEndpoint().catch((error) => {
                    lastHealthProbe = error instanceof Error ? error.message : String(error);
                });
            }, READY_PROBE_INTERVAL_MS);
            healthProbeTimer.unref?.();
        });
    }
}
exports.TencentDocsService = TencentDocsService;
//# sourceMappingURL=tencent-docs-service.js.map