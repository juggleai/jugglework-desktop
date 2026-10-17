"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTencentDocsLocalMcpEnv = exports.buildTencentDocsHttpMcpConfig = exports.buildTencentDocsStdioMcpConfig = exports.resolveEnginePortFilePathFromConfigDir = exports.resolveEnginePortFilePath = exports.STDIO_MCP_BRIDGE_RELATIVE_PATH = exports.TENCENT_DOCS_ENGINE_PORT_FILENAME = exports.TENCENT_DOCS_ENGINE_PORT_FILE_ENV = exports.renderTencentDocsSelectionPrompt = exports.renderTencentDocsRoutingPrompt = exports.isLocalOfficeFilePath = exports.clearScenarioDetectorCache = exports.hasLocalOfficeBinary = exports.TENCENT_DOCS_REMOTE_MCP_TOOL_PREFIX = exports.TENCENT_DOCS_REMOTE_CONNECTOR_NAME = exports.TENCENT_DOCS_LOCAL_MCP_TOOL_PREFIX = exports.TENCENT_DOCS_LOCAL_MCP_NAME = exports.resolveTencentDocsPreviewLocale = exports.isTencentDocsLocalSdkPreviewUrl = exports.DEFAULT_TENCENT_DOCS_PREVIEW_LOCALE = exports.buildTencentDocsPreviewThemeMessage = exports.buildTencentDocsPreviewLocaleMessage = exports.appendTencentDocsLocalSdkPreviewParams = exports.SCENARIO_DETECTABLE_EXTENSIONS = exports.DEV_NOISY_EXTENSIONS = exports.SUPPORTED_EXTENSIONS = exports.FALLBACK_SUPPORTED_EXTENSIONS = exports.TENCENT_DOCS_ENGINE_SUPPORTED_EXTENSIONS = exports.TENCENT_DOCS_ENGINE_FILE_TYPES = exports.isTencentDocsEngineSupportedExtension = exports.isTencentDocsEngineDocType = exports.getTencentDocsSelectionFileType = exports.getTencentDocsEngineDocType = exports.nodeEditorSdkProcessLauncher = exports.NodeEditorSdkProcessLauncher = exports.TencentDocsService = exports.getGlobalPadIdFromPreviewUrl = void 0;
// Engine lifecycle: spawn-and-supervise wrapper around the bundled
// `editor_sdk` binary, plus the pure helpers we expose for tests and renderer
// adapters that need preview-URL synthesis without paying for a binary spawn.
var tencent_docs_service_1 = require("./tencent-docs-service");
Object.defineProperty(exports, "getGlobalPadIdFromPreviewUrl", { enumerable: true, get: function () { return tencent_docs_service_1.getGlobalPadIdFromPreviewUrl; } });
Object.defineProperty(exports, "TencentDocsService", { enumerable: true, get: function () { return tencent_docs_service_1.TencentDocsService; } });
var editor_sdk_process_launcher_1 = require("./editor-sdk-process-launcher");
Object.defineProperty(exports, "NodeEditorSdkProcessLauncher", { enumerable: true, get: function () { return editor_sdk_process_launcher_1.NodeEditorSdkProcessLauncher; } });
Object.defineProperty(exports, "nodeEditorSdkProcessLauncher", { enumerable: true, get: function () { return editor_sdk_process_launcher_1.nodeEditorSdkProcessLauncher; } });
var document_types_1 = require("./document-types");
Object.defineProperty(exports, "getTencentDocsEngineDocType", { enumerable: true, get: function () { return document_types_1.getTencentDocsEngineDocType; } });
Object.defineProperty(exports, "getTencentDocsSelectionFileType", { enumerable: true, get: function () { return document_types_1.getTencentDocsSelectionFileType; } });
Object.defineProperty(exports, "isTencentDocsEngineDocType", { enumerable: true, get: function () { return document_types_1.isTencentDocsEngineDocType; } });
Object.defineProperty(exports, "isTencentDocsEngineSupportedExtension", { enumerable: true, get: function () { return document_types_1.isTencentDocsEngineSupportedExtension; } });
Object.defineProperty(exports, "TENCENT_DOCS_ENGINE_FILE_TYPES", { enumerable: true, get: function () { return document_types_1.TENCENT_DOCS_ENGINE_FILE_TYPES; } });
Object.defineProperty(exports, "TENCENT_DOCS_ENGINE_SUPPORTED_EXTENSIONS", { enumerable: true, get: function () { return document_types_1.TENCENT_DOCS_ENGINE_SUPPORTED_EXTENSIONS; } });
var extensions_1 = require("./extensions");
Object.defineProperty(exports, "FALLBACK_SUPPORTED_EXTENSIONS", { enumerable: true, get: function () { return extensions_1.FALLBACK_SUPPORTED_EXTENSIONS; } });
Object.defineProperty(exports, "SUPPORTED_EXTENSIONS", { enumerable: true, get: function () { return extensions_1.SUPPORTED_EXTENSIONS; } });
Object.defineProperty(exports, "DEV_NOISY_EXTENSIONS", { enumerable: true, get: function () { return extensions_1.DEV_NOISY_EXTENSIONS; } });
Object.defineProperty(exports, "SCENARIO_DETECTABLE_EXTENSIONS", { enumerable: true, get: function () { return extensions_1.SCENARIO_DETECTABLE_EXTENSIONS; } });
var preview_runtime_1 = require("./preview-runtime");
Object.defineProperty(exports, "appendTencentDocsLocalSdkPreviewParams", { enumerable: true, get: function () { return preview_runtime_1.appendTencentDocsLocalSdkPreviewParams; } });
Object.defineProperty(exports, "buildTencentDocsPreviewLocaleMessage", { enumerable: true, get: function () { return preview_runtime_1.buildTencentDocsPreviewLocaleMessage; } });
Object.defineProperty(exports, "buildTencentDocsPreviewThemeMessage", { enumerable: true, get: function () { return preview_runtime_1.buildTencentDocsPreviewThemeMessage; } });
Object.defineProperty(exports, "DEFAULT_TENCENT_DOCS_PREVIEW_LOCALE", { enumerable: true, get: function () { return preview_runtime_1.DEFAULT_TENCENT_DOCS_PREVIEW_LOCALE; } });
Object.defineProperty(exports, "isTencentDocsLocalSdkPreviewUrl", { enumerable: true, get: function () { return preview_runtime_1.isTencentDocsLocalSdkPreviewUrl; } });
Object.defineProperty(exports, "resolveTencentDocsPreviewLocale", { enumerable: true, get: function () { return preview_runtime_1.resolveTencentDocsPreviewLocale; } });
// MCP server identity constants + cwd-based detector.
var mcp_constants_1 = require("./mcp-constants");
Object.defineProperty(exports, "TENCENT_DOCS_LOCAL_MCP_NAME", { enumerable: true, get: function () { return mcp_constants_1.TENCENT_DOCS_LOCAL_MCP_NAME; } });
Object.defineProperty(exports, "TENCENT_DOCS_LOCAL_MCP_TOOL_PREFIX", { enumerable: true, get: function () { return mcp_constants_1.TENCENT_DOCS_LOCAL_MCP_TOOL_PREFIX; } });
Object.defineProperty(exports, "TENCENT_DOCS_REMOTE_CONNECTOR_NAME", { enumerable: true, get: function () { return mcp_constants_1.TENCENT_DOCS_REMOTE_CONNECTOR_NAME; } });
Object.defineProperty(exports, "TENCENT_DOCS_REMOTE_MCP_TOOL_PREFIX", { enumerable: true, get: function () { return mcp_constants_1.TENCENT_DOCS_REMOTE_MCP_TOOL_PREFIX; } });
var scenario_detector_1 = require("./scenario-detector");
Object.defineProperty(exports, "hasLocalOfficeBinary", { enumerable: true, get: function () { return scenario_detector_1.hasLocalOfficeBinary; } });
Object.defineProperty(exports, "clearScenarioDetectorCache", { enumerable: true, get: function () { return scenario_detector_1.clearScenarioDetectorCache; } });
// User-prompt-side routing block: per-turn `<tencent_docs_editor_context>` hidden
// block carrying the document inventory, the imperative skill pointer, and the
// per-channel priority & fallback policy.
var routing_prompt_1 = require("./routing-prompt");
Object.defineProperty(exports, "isLocalOfficeFilePath", { enumerable: true, get: function () { return routing_prompt_1.isLocalOfficeFilePath; } });
Object.defineProperty(exports, "renderTencentDocsRoutingPrompt", { enumerable: true, get: function () { return routing_prompt_1.renderTencentDocsRoutingPrompt; } });
var selection_prompt_1 = require("./selection-prompt");
Object.defineProperty(exports, "renderTencentDocsSelectionPrompt", { enumerable: true, get: function () { return selection_prompt_1.renderTencentDocsSelectionPrompt; } });
// Port file mechanism for stdio MCP bridge + direct HTTP config builder.
var engine_port_file_1 = require("./engine-port-file");
Object.defineProperty(exports, "TENCENT_DOCS_ENGINE_PORT_FILE_ENV", { enumerable: true, get: function () { return engine_port_file_1.TENCENT_DOCS_ENGINE_PORT_FILE_ENV; } });
Object.defineProperty(exports, "TENCENT_DOCS_ENGINE_PORT_FILENAME", { enumerable: true, get: function () { return engine_port_file_1.TENCENT_DOCS_ENGINE_PORT_FILENAME; } });
Object.defineProperty(exports, "STDIO_MCP_BRIDGE_RELATIVE_PATH", { enumerable: true, get: function () { return engine_port_file_1.STDIO_MCP_BRIDGE_RELATIVE_PATH; } });
Object.defineProperty(exports, "resolveEnginePortFilePath", { enumerable: true, get: function () { return engine_port_file_1.resolveEnginePortFilePath; } });
Object.defineProperty(exports, "resolveEnginePortFilePathFromConfigDir", { enumerable: true, get: function () { return engine_port_file_1.resolveEnginePortFilePathFromConfigDir; } });
Object.defineProperty(exports, "buildTencentDocsStdioMcpConfig", { enumerable: true, get: function () { return engine_port_file_1.buildTencentDocsStdioMcpConfig; } });
Object.defineProperty(exports, "buildTencentDocsHttpMcpConfig", { enumerable: true, get: function () { return engine_port_file_1.buildTencentDocsHttpMcpConfig; } });
Object.defineProperty(exports, "buildTencentDocsLocalMcpEnv", { enumerable: true, get: function () { return engine_port_file_1.buildTencentDocsLocalMcpEnv; } });
//# sourceMappingURL=index.js.map