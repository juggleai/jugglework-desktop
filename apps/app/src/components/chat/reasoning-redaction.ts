const HIDDEN_JUGGLECHAT_ROUTER_OPERATION = "[JuggleChat IM operation hidden]"

const JUGGLECHAT_ROUTER_ENDPOINT = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):17832\/router\b/i
const FENCED_CODE_BLOCK = /```[\s\S]*?```/g
const INLINE_CODE = /`[^`\r\n]*`/g
const CURL_COMMAND = /(^|\n)([^\n]*\bcurl\b[^\n]*(?:\\\r?\n[^\n]*)*)/gi

function containsJuggleChatRouterEndpoint(value: string) {
  return JUGGLECHAT_ROUTER_ENDPOINT.test(value)
}

export function isJuggleChatRouterCommand(command: string): boolean {
  return containsJuggleChatRouterEndpoint(command) && /\bcurl\b/i.test(command)
}

export function redactSensitiveCommand(command: string): string {
  return isJuggleChatRouterCommand(command)
    ? HIDDEN_JUGGLECHAT_ROUTER_OPERATION
    : command
}

/**
 * Removes the local JuggleChat Router invocation from reasoning shown in the UI.
 * The original message remains untouched so tool execution and persisted history
 * keep their exact values.
 */
export function redactSensitiveReasoning(text: string): string {
  if (!containsJuggleChatRouterEndpoint(text)) {
    return text
  }

  let redacted = text.replace(FENCED_CODE_BLOCK, (block) =>
    containsJuggleChatRouterEndpoint(block) && /\bcurl\b/i.test(block)
      ? HIDDEN_JUGGLECHAT_ROUTER_OPERATION
      : block
  )

  redacted = redacted.replace(INLINE_CODE, (code) =>
    isJuggleChatRouterCommand(code)
      ? HIDDEN_JUGGLECHAT_ROUTER_OPERATION
      : code
  )

  redacted = redacted.replace(CURL_COMMAND, (command, prefix: string) =>
    containsJuggleChatRouterEndpoint(command)
      ? `${prefix}${HIDDEN_JUGGLECHAT_ROUTER_OPERATION}`
      : command
  )

  // Keep the endpoint private even when it appears outside a recognizable curl
  // command (for example while a streamed command is only partially available).
  return redacted.replace(
    new RegExp(JUGGLECHAT_ROUTER_ENDPOINT.source, "gi"),
    HIDDEN_JUGGLECHAT_ROUTER_OPERATION
  )
}
