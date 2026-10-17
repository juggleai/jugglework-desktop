"use strict";
/**
 * Constants identifying the local & remote Tencent Docs MCP servers.
 *
 * The routing prompt (`routing-prompt.ts`) uses these to interpolate tool-
 * prefix references; electron-app uses `TENCENT_DOCS_LOCAL_MCP_NAME` to
 * register the server in `McpConfig`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TENCENT_DOCS_REMOTE_MCP_TOOL_PREFIX = exports.TENCENT_DOCS_REMOTE_CONNECTOR_NAME = exports.TENCENT_DOCS_LOCAL_MCP_TOOL_PREFIX = exports.TENCENT_DOCS_LOCAL_MCP_NAME = void 0;
/**
 * Logical name of the local Tencent Docs MCP server in `mcpServers` /
 * `--mcp-config`. The agent-sdk / CodeBuddy CLI exposes this server's tools
 * under the prefix `mcp__<this-name>__<tool>`, so changing this value
 * changes the tool-name prefix the model is told to call. Keep both apps
 * importing this constant — never hard-code the string elsewhere.
 */
exports.TENCENT_DOCS_LOCAL_MCP_NAME = 'tencent_docs_local';
/** Tool-name prefix the agent sees for tools provided by this MCP server. */
exports.TENCENT_DOCS_LOCAL_MCP_TOOL_PREFIX = `mcp__${exports.TENCENT_DOCS_LOCAL_MCP_NAME}__`;
/**
 * Logical name of the remote Tencent Docs connector in the connector-proxy
 * `server_name` mapping. The CLI's transparent-proxy mode exposes its tools
 * as `mcp__<this-name>__<tool>`, mirroring the local convention.
 */
exports.TENCENT_DOCS_REMOTE_CONNECTOR_NAME = 'tencent_docs';
/** Tool-name prefix the agent sees for remote Tencent Docs connector tools. */
exports.TENCENT_DOCS_REMOTE_MCP_TOOL_PREFIX = `mcp__${exports.TENCENT_DOCS_REMOTE_CONNECTOR_NAME}__`;
//# sourceMappingURL=mcp-constants.js.map