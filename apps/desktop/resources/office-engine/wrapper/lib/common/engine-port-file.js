"use strict";
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
exports.STDIO_MCP_BRIDGE_RELATIVE_PATH = exports.TENCENT_DOCS_ENGINE_PORT_FILENAME = exports.TENCENT_DOCS_ENGINE_PORT_FILE_ENV = void 0;
exports.resolveEnginePortFilePath = resolveEnginePortFilePath;
exports.resolveEnginePortFilePathFromEnv = resolveEnginePortFilePathFromEnv;
exports.resolveEnginePortFilePathFromConfigDir = resolveEnginePortFilePathFromConfigDir;
exports.writePortFile = writePortFile;
exports.deletePortFile = deletePortFile;
exports.readPortFile = readPortFile;
exports.buildTencentDocsStdioMcpConfig = buildTencentDocsStdioMcpConfig;
exports.buildTencentDocsHttpMcpConfig = buildTencentDocsHttpMcpConfig;
exports.buildTencentDocsLocalMcpEnv = buildTencentDocsLocalMcpEnv;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const mcp_constants_1 = require("./mcp-constants");
exports.TENCENT_DOCS_ENGINE_PORT_FILE_ENV = 'TENCENT_DOCS_ENGINE_PORT_FILE';
exports.TENCENT_DOCS_ENGINE_PORT_FILENAME = 'tencent-docs-engine.port';
/** Compiled bridge entry relative to the package root (`lib/mcp/...`). */
exports.STDIO_MCP_BRIDGE_RELATIVE_PATH = 'lib/mcp/stdio-mcp-bridge.js';
function resolveEnginePortFilePath(portFileRootDir) {
    return path.join(portFileRootDir, exports.TENCENT_DOCS_ENGINE_PORT_FILENAME);
}
/**
 * Read port file path from process.env.TENCENT_DOCS_ENGINE_PORT_FILE (explicit override).
 */
function resolveEnginePortFilePathFromEnv() {
    return process.env[exports.TENCENT_DOCS_ENGINE_PORT_FILE_ENV];
}
/**
 * Derive port file path from CODEBUDDY_CONFIG_DIR (already present in CLI env).
 * Used as fallback when TENCENT_DOCS_ENGINE_PORT_FILE is not explicitly set.
 */
function resolveEnginePortFilePathFromConfigDir() {
    const configDir = process.env.CODEBUDDY_CONFIG_DIR;
    if (!configDir) {
        return undefined;
    }
    return path.join(configDir, exports.TENCENT_DOCS_ENGINE_PORT_FILENAME);
}
function writePortFile(portFilePath, port) {
    const dir = path.dirname(portFilePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${portFilePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, port, 'utf-8');
    fs.renameSync(tmpPath, portFilePath);
}
function deletePortFile(portFilePath) {
    try {
        fs.unlinkSync(portFilePath);
    }
    catch {
        // file may not exist
    }
}
function readPortFile(portFilePath) {
    try {
        const content = fs.readFileSync(portFilePath, 'utf-8').trim();
        if (/^\d+$/.test(content)) {
            return content;
        }
        return undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Build stdio MCP config JSON for the bridge.
 * Bridge discovers the port file via TENCENT_DOCS_ENGINE_PORT_FILE env (explicit)
 * or falls back to CODEBUDDY_CONFIG_DIR + filename (workbuddy-hosted CLI).
 */
function buildTencentDocsStdioMcpConfig() {
    const raw = path.resolve(__dirname, '../mcp/stdio-mcp-bridge.js');
    // In packaged Electron apps, __dirname points inside app.asar which plain
    // `node` (spawned by the agent CLI) cannot read. The bridge is unpacked to
    // app.asar.unpacked/ by electron-builder's asarUnpack config; rewrite the
    // path so the spawned process hits the real filesystem copy.
    const bridgeScript = raw.replace(/([\\/])app\.asar\1/, '$1app.asar.unpacked$1');
    return JSON.stringify({
        mcpServers: {
            [mcp_constants_1.TENCENT_DOCS_LOCAL_MCP_NAME]: {
                type: 'stdio',
                command: 'node',
                args: [bridgeScript],
            },
        },
    });
}
/**
 * Build HTTP MCP config JSON that connects directly to the engine's
 * streamable-HTTP endpoint at `http://127.0.0.1:<port>/mcp`.
 *
 * Use this when the consumer can reach the engine over localhost (e.g. the
 * sheetagent plugin running in the same host process). Returns an empty
 * string for missing/invalid ports so callers can feed the result through
 * `mergeMcpConfigJson` without crashing.
 */
function buildTencentDocsHttpMcpConfig(port) {
    const portStr = typeof port === 'number' ? String(port) : (port ?? '').trim();
    if (!portStr || !/^\d+$/.test(portStr)) {
        return '';
    }
    return JSON.stringify({
        mcpServers: {
            [mcp_constants_1.TENCENT_DOCS_LOCAL_MCP_NAME]: {
                type: 'http',
                url: `http://127.0.0.1:${portStr}/mcp`,
            },
        },
    });
}
/**
 * Build env-var record for injecting the engine's HTTP MCP endpoint
 * into agent / plugin child processes.
 *
 * Returns `{ TENCENT_DOCS_LOCAL_MCP: "http://127.0.0.1:<port>/mcp",
 *            TENCENT_DOCS_LOCAL_SERVER: "http://127.0.0.1:<port>" }`
 * when the port is valid, or `{}` otherwise.
 *
 * Host apps should call this at session start (after the engine is up)
 * and merge the result into the child-process environment.
 */
function buildTencentDocsLocalMcpEnv(port) {
    const portStr = typeof port === 'number' ? String(port) : (port ?? '').trim();
    if (!portStr || !/^\d+$/.test(portStr)) {
        return {};
    }
    return {
        TENCENT_DOCS_LOCAL_MCP: `http://127.0.0.1:${portStr}/mcp`,
        TENCENT_DOCS_LOCAL_SERVER: `http://127.0.0.1:${portStr}`,
    };
}
//# sourceMappingURL=engine-port-file.js.map