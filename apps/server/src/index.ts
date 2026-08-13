/**
 * Library entry point for the JuggleWork server.
 *
 * ```ts
 * import { startEmbeddedServer } from "jugglework-server";
 *
 * const handle = await startEmbeddedServer({
 *   host: "127.0.0.1",
 *   port: 0,
 *   workspaces: ["/path/to/workspace"],
 *   token: clientToken,
 *   hostToken: hostToken,
 *   manageOpencode: true,
 *   opencodeBin: "/path/to/opencode",
 * });
 *
 * console.log(`Server at ${handle.url}`);
 * handle.stop();
 * ```
 */
export { startEmbeddedServer, type EmbeddedServerHandle, type EmbeddedServerOptions } from "./embedded.js";
export { startServer } from "./server.js";
export { resolveServerConfig } from "./config.js";
export type { ServeResult } from "./serve-node.js";
export { ClaudeWorkerClient, ClaudeWorkerClientError } from "./claude-worker-client.js";
export { startClaudeInternalToolsServer, type ClaudeInternalToolsServer } from "./claude-internal-tools-server.js";
export {
  createClaudeMcpRuntimeConfiguration,
  inspectClaudeMcpRuntimeConfiguration,
  type ClaudeMcpCredentialBroker,
  type ClaudeMcpCredentialLease,
} from "./claude-mcp-runtime-config.js";
export {
  ANTHROPIC_API_KEY_SECRET,
  AWS_ACCESS_KEY_ID_SECRET,
  AWS_BEARER_TOKEN_BEDROCK_SECRET,
  AWS_SECRET_ACCESS_KEY_SECRET,
  AWS_SESSION_TOKEN_SECRET,
  CLAUDE_GATEWAY_CREDENTIAL_SECRET,
  FOUNDRY_API_KEY_SECRET,
  FOUNDRY_AUTH_TOKEN_SECRET,
  ApprovedGatewayCredentialBroker,
  AnthropicByokCredentialBroker,
  AwsBedrockCredentialBroker,
  ClaudeCredentialError,
  GoogleVertexCredentialBroker,
  MicrosoftFoundryCredentialBroker,
  type ClaudeCredentialAuthMethod,
  type ClaudeCredentialBroker,
  type ClaudeCredentialLease,
  type ClaudeCredentialPolicy,
  type ClaudeCredentialProvider,
  type ClaudeCredentialReadiness,
  type ClaudeSecretName,
  type ClaudeSecretProvider,
} from "./claude-credentials.js";
export { ClaudeAgentEngineAdapter, CLAUDE_AGENT_RUNTIME_ID } from "./agent-engine/claude-adapter.js";
export {
  ClaudeWorkerProcessManager,
  ClaudeWorkerProcessError,
  createClaudeWorkerProcessManagerFromEnv,
} from "./claude-worker-process-manager.js";
export {
  CLAUDE_AGENT_INTERNAL_COHORT_ENV,
  CLAUDE_AGENT_ROLLOUT_STAGE_ENV,
  CLAUDE_AGENT_RUNTIME_KILL_SWITCH,
  CLAUDE_AGENT_USER_OPT_IN_ENV,
  resolveClaudeAgentRollout,
} from "@jugglework/types/agent-runtime";
