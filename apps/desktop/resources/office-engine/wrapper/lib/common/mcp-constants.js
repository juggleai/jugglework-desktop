"use strict";
/**
 * Constants identifying the local & remote Office Docs MCP servers.
 *
 * The routing prompt (`routing-prompt.ts`) uses these to interpolate tool-
 * prefix references; electron-app uses `OFFICE_DOCS_LOCAL_MCP_NAME` to
 * register the server in `McpConfig`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OFFICE_DOCS_REMOTE_MCP_TOOL_PREFIX = exports.OFFICE_DOCS_REMOTE_CONNECTOR_NAME = exports.OFFICE_DOCS_LOCAL_MCP_TOOL_PREFIX = exports.OFFICE_DOCS_LOCAL_MCP_NAME = void 0;
/**
 * Logical name of the local Office Docs MCP server in `mcpServers` /
 * `--mcp-config`. The agent-sdk / JuggleWork CLI exposes this server's tools
 * under the prefix `mcp__<this-name>__<tool>`, so changing this value
 * changes the tool-name prefix the model is told to call. Keep both apps
 * importing this constant — never hard-code the string elsewhere.
 */
exports.OFFICE_DOCS_LOCAL_MCP_NAME = 'office_docs_local';
/** Tool-name prefix the agent sees for tools provided by this MCP server. */
exports.OFFICE_DOCS_LOCAL_MCP_TOOL_PREFIX = `mcp__${exports.OFFICE_DOCS_LOCAL_MCP_NAME}__`;
/**
 * Logical name of the remote Office Docs connector in the connector-proxy
 * `server_name` mapping. The CLI's transparent-proxy mode exposes its tools
 * as `mcp__<this-name>__<tool>`, mirroring the local convention.
 */
exports.OFFICE_DOCS_REMOTE_CONNECTOR_NAME = 'office_docs';
/** Tool-name prefix the agent sees for remote Office Docs connector tools. */
exports.OFFICE_DOCS_REMOTE_MCP_TOOL_PREFIX = `mcp__${exports.OFFICE_DOCS_REMOTE_CONNECTOR_NAME}__`;
//# sourceMappingURL=mcp-constants.js.map