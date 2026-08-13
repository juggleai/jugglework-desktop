export const agentEngineErrorCodeValues = [
  "runtime_not_found",
  "runtime_duplicate",
  "runtime_unavailable",
  "runtime_capability_unsupported",
  "runtime_configuration_invalid",
  "runtime_session_mismatch",
  "runtime_retry_confirmation_required",
  "runtime_request_failed",
] as const;

export type AgentEngineErrorCode = typeof agentEngineErrorCodeValues[number];

export class AgentEngineError extends Error {
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    public readonly code: AgentEngineErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentEngineError";
    this.details = details;
  }
}
