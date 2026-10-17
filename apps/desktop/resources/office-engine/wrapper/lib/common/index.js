"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildOfficeDocsLocalMcpEnv = exports.buildOfficeDocsHttpMcpConfig = exports.buildOfficeDocsStdioMcpConfig = exports.resolveEnginePortFilePathFromConfigDir = exports.resolveEnginePortFilePath = exports.STDIO_MCP_BRIDGE_RELATIVE_PATH = exports.OFFICE_DOCS_ENGINE_PORT_FILENAME = exports.OFFICE_DOCS_ENGINE_PORT_FILE_ENV = exports.renderOfficeDocsSelectionPrompt = exports.renderOfficeDocsRoutingPrompt = exports.isLocalOfficeFilePath = exports.clearScenarioDetectorCache = exports.hasLocalOfficeBinary = exports.OFFICE_DOCS_REMOTE_MCP_TOOL_PREFIX = exports.OFFICE_DOCS_REMOTE_CONNECTOR_NAME = exports.OFFICE_DOCS_LOCAL_MCP_TOOL_PREFIX = exports.OFFICE_DOCS_LOCAL_MCP_NAME = exports.resolveOfficeDocsPreviewLocale = exports.isOfficeDocsLocalSdkPreviewUrl = exports.DEFAULT_OFFICE_DOCS_PREVIEW_LOCALE = exports.buildOfficeDocsPreviewThemeMessage = exports.buildOfficeDocsPreviewLocaleMessage = exports.appendOfficeDocsLocalSdkPreviewParams = exports.SCENARIO_DETECTABLE_EXTENSIONS = exports.DEV_NOISY_EXTENSIONS = exports.SUPPORTED_EXTENSIONS = exports.FALLBACK_SUPPORTED_EXTENSIONS = exports.OFFICE_DOCS_ENGINE_SUPPORTED_EXTENSIONS = exports.OFFICE_DOCS_ENGINE_FILE_TYPES = exports.isOfficeDocsEngineSupportedExtension = exports.isOfficeDocsEngineDocType = exports.getOfficeDocsSelectionFileType = exports.getOfficeDocsEngineDocType = exports.nodeEditorSdkProcessLauncher = exports.NodeEditorSdkProcessLauncher = exports.OfficeDocsService = exports.getGlobalPadIdFromPreviewUrl = void 0;
// Engine lifecycle: spawn-and-supervise wrapper around the bundled
// `editor_sdk` binary, plus the pure helpers we expose for tests and renderer
// adapters that need preview-URL synthesis without paying for a binary spawn.
var office_docs_service_1 = require("./office-docs-service");
Object.defineProperty(exports, "getGlobalPadIdFromPreviewUrl", { enumerable: true, get: function () { return office_docs_service_1.getGlobalPadIdFromPreviewUrl; } });
Object.defineProperty(exports, "OfficeDocsService", { enumerable: true, get: function () { return office_docs_service_1.OfficeDocsService; } });
var editor_sdk_process_launcher_1 = require("./editor-sdk-process-launcher");
Object.defineProperty(exports, "NodeEditorSdkProcessLauncher", { enumerable: true, get: function () { return editor_sdk_process_launcher_1.NodeEditorSdkProcessLauncher; } });
Object.defineProperty(exports, "nodeEditorSdkProcessLauncher", { enumerable: true, get: function () { return editor_sdk_process_launcher_1.nodeEditorSdkProcessLauncher; } });
var document_types_1 = require("./document-types");
Object.defineProperty(exports, "getOfficeDocsEngineDocType", { enumerable: true, get: function () { return document_types_1.getOfficeDocsEngineDocType; } });
Object.defineProperty(exports, "getOfficeDocsSelectionFileType", { enumerable: true, get: function () { return document_types_1.getOfficeDocsSelectionFileType; } });
Object.defineProperty(exports, "isOfficeDocsEngineDocType", { enumerable: true, get: function () { return document_types_1.isOfficeDocsEngineDocType; } });
Object.defineProperty(exports, "isOfficeDocsEngineSupportedExtension", { enumerable: true, get: function () { return document_types_1.isOfficeDocsEngineSupportedExtension; } });
Object.defineProperty(exports, "OFFICE_DOCS_ENGINE_FILE_TYPES", { enumerable: true, get: function () { return document_types_1.OFFICE_DOCS_ENGINE_FILE_TYPES; } });
Object.defineProperty(exports, "OFFICE_DOCS_ENGINE_SUPPORTED_EXTENSIONS", { enumerable: true, get: function () { return document_types_1.OFFICE_DOCS_ENGINE_SUPPORTED_EXTENSIONS; } });
var extensions_1 = require("./extensions");
Object.defineProperty(exports, "FALLBACK_SUPPORTED_EXTENSIONS", { enumerable: true, get: function () { return extensions_1.FALLBACK_SUPPORTED_EXTENSIONS; } });
Object.defineProperty(exports, "SUPPORTED_EXTENSIONS", { enumerable: true, get: function () { return extensions_1.SUPPORTED_EXTENSIONS; } });
Object.defineProperty(exports, "DEV_NOISY_EXTENSIONS", { enumerable: true, get: function () { return extensions_1.DEV_NOISY_EXTENSIONS; } });
Object.defineProperty(exports, "SCENARIO_DETECTABLE_EXTENSIONS", { enumerable: true, get: function () { return extensions_1.SCENARIO_DETECTABLE_EXTENSIONS; } });
var preview_runtime_1 = require("./preview-runtime");
Object.defineProperty(exports, "appendOfficeDocsLocalSdkPreviewParams", { enumerable: true, get: function () { return preview_runtime_1.appendOfficeDocsLocalSdkPreviewParams; } });
Object.defineProperty(exports, "buildOfficeDocsPreviewLocaleMessage", { enumerable: true, get: function () { return preview_runtime_1.buildOfficeDocsPreviewLocaleMessage; } });
Object.defineProperty(exports, "buildOfficeDocsPreviewThemeMessage", { enumerable: true, get: function () { return preview_runtime_1.buildOfficeDocsPreviewThemeMessage; } });
Object.defineProperty(exports, "DEFAULT_OFFICE_DOCS_PREVIEW_LOCALE", { enumerable: true, get: function () { return preview_runtime_1.DEFAULT_OFFICE_DOCS_PREVIEW_LOCALE; } });
Object.defineProperty(exports, "isOfficeDocsLocalSdkPreviewUrl", { enumerable: true, get: function () { return preview_runtime_1.isOfficeDocsLocalSdkPreviewUrl; } });
Object.defineProperty(exports, "resolveOfficeDocsPreviewLocale", { enumerable: true, get: function () { return preview_runtime_1.resolveOfficeDocsPreviewLocale; } });
// MCP server identity constants + cwd-based detector.
var mcp_constants_1 = require("./mcp-constants");
Object.defineProperty(exports, "OFFICE_DOCS_LOCAL_MCP_NAME", { enumerable: true, get: function () { return mcp_constants_1.OFFICE_DOCS_LOCAL_MCP_NAME; } });
Object.defineProperty(exports, "OFFICE_DOCS_LOCAL_MCP_TOOL_PREFIX", { enumerable: true, get: function () { return mcp_constants_1.OFFICE_DOCS_LOCAL_MCP_TOOL_PREFIX; } });
Object.defineProperty(exports, "OFFICE_DOCS_REMOTE_CONNECTOR_NAME", { enumerable: true, get: function () { return mcp_constants_1.OFFICE_DOCS_REMOTE_CONNECTOR_NAME; } });
Object.defineProperty(exports, "OFFICE_DOCS_REMOTE_MCP_TOOL_PREFIX", { enumerable: true, get: function () { return mcp_constants_1.OFFICE_DOCS_REMOTE_MCP_TOOL_PREFIX; } });
var scenario_detector_1 = require("./scenario-detector");
Object.defineProperty(exports, "hasLocalOfficeBinary", { enumerable: true, get: function () { return scenario_detector_1.hasLocalOfficeBinary; } });
Object.defineProperty(exports, "clearScenarioDetectorCache", { enumerable: true, get: function () { return scenario_detector_1.clearScenarioDetectorCache; } });
// User-prompt-side routing block: per-turn `<office_docs_editor_context>` hidden
// block carrying the document inventory, the imperative skill pointer, and the
// per-channel priority & fallback policy.
var routing_prompt_1 = require("./routing-prompt");
Object.defineProperty(exports, "isLocalOfficeFilePath", { enumerable: true, get: function () { return routing_prompt_1.isLocalOfficeFilePath; } });
Object.defineProperty(exports, "renderOfficeDocsRoutingPrompt", { enumerable: true, get: function () { return routing_prompt_1.renderOfficeDocsRoutingPrompt; } });
var selection_prompt_1 = require("./selection-prompt");
Object.defineProperty(exports, "renderOfficeDocsSelectionPrompt", { enumerable: true, get: function () { return selection_prompt_1.renderOfficeDocsSelectionPrompt; } });
// Port file mechanism for stdio MCP bridge + direct HTTP config builder.
var engine_port_file_1 = require("./engine-port-file");
Object.defineProperty(exports, "OFFICE_DOCS_ENGINE_PORT_FILE_ENV", { enumerable: true, get: function () { return engine_port_file_1.OFFICE_DOCS_ENGINE_PORT_FILE_ENV; } });
Object.defineProperty(exports, "OFFICE_DOCS_ENGINE_PORT_FILENAME", { enumerable: true, get: function () { return engine_port_file_1.OFFICE_DOCS_ENGINE_PORT_FILENAME; } });
Object.defineProperty(exports, "STDIO_MCP_BRIDGE_RELATIVE_PATH", { enumerable: true, get: function () { return engine_port_file_1.STDIO_MCP_BRIDGE_RELATIVE_PATH; } });
Object.defineProperty(exports, "resolveEnginePortFilePath", { enumerable: true, get: function () { return engine_port_file_1.resolveEnginePortFilePath; } });
Object.defineProperty(exports, "resolveEnginePortFilePathFromConfigDir", { enumerable: true, get: function () { return engine_port_file_1.resolveEnginePortFilePathFromConfigDir; } });
Object.defineProperty(exports, "buildOfficeDocsStdioMcpConfig", { enumerable: true, get: function () { return engine_port_file_1.buildOfficeDocsStdioMcpConfig; } });
Object.defineProperty(exports, "buildOfficeDocsHttpMcpConfig", { enumerable: true, get: function () { return engine_port_file_1.buildOfficeDocsHttpMcpConfig; } });
Object.defineProperty(exports, "buildOfficeDocsLocalMcpEnv", { enumerable: true, get: function () { return engine_port_file_1.buildOfficeDocsLocalMcpEnv; } });
//# sourceMappingURL=index.js.map