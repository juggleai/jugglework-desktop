import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { isIP } from "node:net"

import { ZodError, type ZodType } from "zod"

import { ClaudeRunError, type ClaudeRunController } from "./execution.js"
import { ClaudeMcpRuntime, ClaudeMcpRuntimeError } from "./mcp-runtime.js"
import { inspectClaudeSandboxCapability, type ClaudeSandboxCapability } from "./sandbox.js"
import {
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_WORKER_MAX_EVENT_BYTES,
  CLAUDE_WORKER_MAX_HEADER_BYTES,
  CLAUDE_WORKER_MAX_REQUEST_BYTES,
  CLAUDE_WORKER_MAX_RETAINED_EVENTS,
  CLAUDE_WORKER_PROTOCOL_VERSION,
  type ClaudeWorkerCapabilities,
  type ClaudeWorkerErrorResponse,
  type ClaudeWorkerEvent,
  type ClaudeWorkerHealth,
  claudeWorkerAbortRequestSchema,
  claudeWorkerAbortResponseSchema,
  claudeWorkerCapabilitiesSchema,
  claudeWorkerEventSchema,
  claudeWorkerGenerationTokenSchema,
  claudeWorkerHealthSchema,
  claudeWorkerMcpConfigurationSchema,
  claudeWorkerMcpDiagnosticsResponseSchema,
  claudeWorkerMcpRefreshResponseSchema,
  claudeWorkerRunObservationSchema,
  claudeWorkerRunRequestSchema,
  claudeWorkerRunResponseSchema,
  claudeWorkerResolveInteractionRequestSchema,
  claudeWorkerResolveInteractionResponseSchema,
  claudeWorkerStopSubagentRequestSchema,
  claudeWorkerStopSubagentResponseSchema,
  claudeWorkerForkRequestSchema,
  claudeWorkerForkResponseSchema,
  claudeWorkerShutdownRequestSchema,
  claudeWorkerShutdownResponseSchema,
} from "./schemas.js"

export const CLAUDE_WORKER_TOKEN_HEADER = "x-jugglework-worker-token" as const

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"])

export interface StartClaudeWorkerTransportOptions {
  generationToken: string
  cliVersion: string
  host?: "127.0.0.1" | "::1"
  port?: number
  health?: () => ClaudeWorkerHealth | Promise<ClaudeWorkerHealth>
  createRunController?: (
    publishEvent: ClaudeWorkerTransport["publishEvent"],
  ) => ClaudeRunController
  onShutdown?: (reason: string | undefined) => void | Promise<void>
  mcpRuntime?: ClaudeMcpRuntime
  sandboxCapability?: ClaudeSandboxCapability
}

export interface ClaudeWorkerTransport {
  readonly host: "127.0.0.1" | "::1"
  readonly port: number
  readonly url: string
  publishEvent(type: ClaudeWorkerEvent["type"], payload?: Record<string, unknown>): ClaudeWorkerEvent
  close(): Promise<void>
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ClaudeWorkerErrorResponse["error"]["code"],
    message: string,
  ) {
    super(message)
  }
}

export function generateClaudeWorkerGenerationToken(): string {
  return randomBytes(32).toString("base64url")
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address
  return normalized === "127.0.0.1" || normalized === "::1"
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest()
}

function authenticate(request: IncomingMessage, expectedTokenDigest: Buffer): void {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    throw new RequestError(403, "forbidden_client", "Worker transport accepts loopback clients only")
  }
  if (request.headers.origin || request.headers["sec-fetch-site"]) {
    throw new RequestError(403, "forbidden_client", "Browser and Renderer requests are not accepted")
  }
  const supplied = request.headers[CLAUDE_WORKER_TOKEN_HEADER]
  const token = Array.isArray(supplied) ? "" : supplied ?? ""
  const parsed = claudeWorkerGenerationTokenSchema.safeParse(token)
  const suppliedDigest = tokenDigest(parsed.success ? parsed.data : "invalid")
  if (!parsed.success || !timingSafeEqual(expectedTokenDigest, suppliedDigest)) {
    throw new RequestError(401, "unauthorized", "Worker authentication failed")
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body)
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(encoded),
    "content-type": "application/json; charset=utf-8",
  })
  response.end(encoded)
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy()
    return
  }
  if (error instanceof RequestError) {
    sendJson(response, error.status, { error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof ClaudeRunError) {
    const code = error.code === "session_mismatch" ? "internal_error" : error.code
    const status = code === "run_not_found" || code === "interaction_not_found" ? 404
      : code === "session_busy" || code === "already_resolved" ? 409
        : code === "unsupported_capability" ? 422 : 500
    sendJson(response, status, { error: { code, message: error.message } })
    return
  }
  if (error instanceof ClaudeMcpRuntimeError) {
    const status = error.code === "mcp_not_found" ? 404 : 409
    sendJson(response, status, { error: { code: error.code, message: error.message } })
    return
  }
  sendJson(response, 500, { error: { code: "internal_error", message: "Worker request failed" } })
}

async function readJson<T>(request: IncomingMessage, schema: ZodType<T>): Promise<T> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase()
  if (contentType !== "application/json") {
    throw new RequestError(415, "invalid_content_type", "Content-Type must be application/json")
  }

  const contentLength = Number(request.headers["content-length"] ?? "0")
  if (Number.isFinite(contentLength) && contentLength > CLAUDE_WORKER_MAX_REQUEST_BYTES) {
    throw new RequestError(413, "payload_too_large", "Worker request exceeds the size limit")
  }

  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    received += buffer.byteLength
    if (received > CLAUDE_WORKER_MAX_REQUEST_BYTES) {
      throw new RequestError(413, "payload_too_large", "Worker request exceeds the size limit")
    }
    chunks.push(buffer)
  }

  try {
    const parsed = received === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"))
    return schema.parse(parsed)
  } catch (error) {
    if (error instanceof RequestError) throw error
    const message = error instanceof ZodError ? "Worker request does not match its schema" : "Worker request is not valid JSON"
    throw new RequestError(400, "invalid_request", message)
  }
}

function requestPath(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://worker.local")
}

function parseEventCursor(request: IncomingMessage, url: URL): number {
  const raw = url.searchParams.get("cursor") ?? request.headers["last-event-id"] ?? "0"
  const value = Array.isArray(raw) ? Number.NaN : Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RequestError(400, "event_cursor_invalid", "Event cursor must be a non-negative integer")
  }
  return value
}

function sseFrame(event: ClaudeWorkerEvent): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

function methodAllowed(request: IncomingMessage, expected: string): void {
  if (request.method !== expected) {
    throw new RequestError(405, "method_not_allowed", `Method must be ${expected}`)
  }
}

export async function startClaudeWorkerTransport(
  options: StartClaudeWorkerTransportOptions,
): Promise<ClaudeWorkerTransport> {
  const generationToken = claudeWorkerGenerationTokenSchema.parse(options.generationToken)
  const expectedTokenDigest = tokenDigest(generationToken)
  const generationId = expectedTokenDigest.toString("base64url").slice(0, 16)
  const host = options.host ?? "127.0.0.1"
  if (!LOOPBACK_HOSTS.has(host) || isIP(host) === 0) {
    throw new Error("Claude worker transport must bind to an explicit loopback IP address")
  }
  const requestedPort = options.port ?? 0
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error("Claude worker transport port is invalid")
  }

  let status: ClaudeWorkerHealth["status"] = "starting"
  let sequence = 0
  let closing: Promise<void> | null = null
  const events: ClaudeWorkerEvent[] = []
  const eventClients = new Set<ServerResponse>()

  const currentHealth = async (): Promise<ClaudeWorkerHealth> => {
    if (options.health) return claudeWorkerHealthSchema.parse(await options.health())
    const reasonCode = status === "healthy" ? "worker_ready" : status === "stopping" ? "worker_stopping" : "worker_starting"
    return claudeWorkerHealthSchema.parse({
      protocolVersion: CLAUDE_WORKER_PROTOCOL_VERSION,
      status,
      checkedAt: new Date().toISOString(),
      reasonCode,
      message: status === "healthy" ? "Claude Agent Worker is ready." : `Claude Agent Worker is ${status}.`,
    })
  }

  const capabilities = (): ClaudeWorkerCapabilities => {
    const advanced = runController?.advancedCapabilities?.() ?? {
      prewarm: false,
      residentSession: false,
      protocolInterrupt: false,
      queuedInput: false,
      steer: false,
      dynamicModel: false,
      dynamicEffort: false,
      dynamicPermissionMode: false,
      subagentProjection: false,
      subagentProgress: false,
      subagentStop: false,
      planMode: false,
      fileCheckpointing: false,
      rewind: false,
      nativeFork: false,
    }
    return claudeWorkerCapabilitiesSchema.parse({
    protocolVersion: CLAUDE_WORKER_PROTOCOL_VERSION,
    sdkVersion: CLAUDE_AGENT_SDK_VERSION,
    cliVersion: options.cliVersion,
    nodeVersion: process.versions.node,
    transport: "loopback-http",
    limits: {
      maxHeaderBytes: CLAUDE_WORKER_MAX_HEADER_BYTES,
      maxRequestBytes: CLAUDE_WORKER_MAX_REQUEST_BYTES,
      maxEventBytes: CLAUDE_WORKER_MAX_EVENT_BYTES,
      maxRetainedEvents: CLAUDE_WORKER_MAX_RETAINED_EVENTS,
    },
    operations: {
      health: true,
      capabilities: true,
      events: true,
      shutdown: true,
      run: Boolean(runController),
      abort: Boolean(runController),
      interactions: Boolean(runController),
      configurationRefresh: Boolean(options.mcpRuntime),
      currentTurnConfiguration: advanced.dynamicModel || advanced.dynamicEffort || advanced.dynamicPermissionMode || advanced.planMode,
      stopSubagent: advanced.subagentStop && typeof runController?.stopSubagent === "function",
      nativeFork: advanced.nativeFork && typeof runController?.forkSession === "function",
    },
    advanced: {
      ...advanced,
      subagentStop: advanced.subagentStop && typeof runController?.stopSubagent === "function",
      nativeFork: advanced.nativeFork && typeof runController?.forkSession === "function",
      partialFallback: true,
      filesystemState: "shared-working-tree",
    },
    sandbox: options.sandboxCapability ?? inspectClaudeSandboxCapability(),
  })
  }

  const publishEvent = (
    type: ClaudeWorkerEvent["type"],
    payload: Record<string, unknown> = {},
  ): ClaudeWorkerEvent => {
    const event = claudeWorkerEventSchema.parse({
      protocolVersion: CLAUDE_WORKER_PROTOCOL_VERSION,
      sequence: ++sequence,
      id: `worker-${generationId}-${sequence}`,
      type,
      createdAt: new Date().toISOString(),
      payload,
    })
    if (Buffer.byteLength(JSON.stringify(event)) > CLAUDE_WORKER_MAX_EVENT_BYTES) {
      sequence -= 1
      throw new Error("Claude worker event exceeds the size limit")
    }
    events.push(event)
    if (events.length > CLAUDE_WORKER_MAX_RETAINED_EVENTS) events.shift()
    const frame = sseFrame(event)
    for (const client of eventClients) client.write(frame)
    return event
  }

  const runController = options.createRunController?.(publishEvent)

  let server: Server
  const close = (): Promise<void> => {
    if (closing) return closing
    closing = (async () => {
      let cleanupError: unknown
      try {
        await runController?.closeAll()
      } catch (error) {
        cleanupError = error
      }
      await new Promise<void>((resolve, reject) => {
        for (const client of eventClients) client.end()
        eventClients.clear()
        server.close((error) => error ? reject(error) : resolve())
        server.closeIdleConnections()
      })
      if (cleanupError) throw cleanupError
    })()
    return closing
  }

  server = createServer({ maxHeaderSize: CLAUDE_WORKER_MAX_HEADER_BYTES }, (request, response) => {
    void (async () => {
      authenticate(request, expectedTokenDigest)
      const url = requestPath(request)

      if (url.pathname === "/v1/health") {
        methodAllowed(request, "GET")
        sendJson(response, 200, await currentHealth())
        return
      }
      if (url.pathname === "/v1/capabilities") {
        methodAllowed(request, "GET")
        sendJson(response, 200, capabilities())
        return
      }
      if (url.pathname === "/v1/configuration/refresh") {
        methodAllowed(request, "POST")
        if (!options.mcpRuntime) throw new RequestError(404, "not_found", "MCP configuration is not configured")
        const body = await readJson(request, claudeWorkerMcpConfigurationSchema)
        sendJson(response, 200, claudeWorkerMcpRefreshResponseSchema.parse(await options.mcpRuntime.refresh(body)))
        return
      }
      const diagnosticsMatch = /^\/v1\/workspaces\/([^/]+)\/mcp\/diagnostics$/.exec(url.pathname)
      if (diagnosticsMatch) {
        methodAllowed(request, "GET")
        if (!options.mcpRuntime) throw new RequestError(404, "not_found", "MCP diagnostics are not configured")
        const workspaceId = decodeURIComponent(diagnosticsMatch[1] ?? "")
        sendJson(response, 200, claudeWorkerMcpDiagnosticsResponseSchema.parse(options.mcpRuntime.diagnostics(workspaceId)))
        return
      }
      const reconnectMatch = /^\/v1\/workspaces\/([^/]+)\/mcp\/([^/]+)\/reconnect$/.exec(url.pathname)
      if (reconnectMatch) {
        methodAllowed(request, "POST")
        if (!options.mcpRuntime) throw new RequestError(404, "not_found", "MCP reconnect is not configured")
        const workspaceId = decodeURIComponent(reconnectMatch[1] ?? "")
        const serverName = decodeURIComponent(reconnectMatch[2] ?? "")
        const body = await readJson(request, claudeWorkerMcpConfigurationSchema.pick({ workspaceId: true }).strict())
        if (body.workspaceId !== workspaceId) throw new RequestError(400, "invalid_request", "Workspace identifier does not match the route")
        await options.mcpRuntime.reconnect(workspaceId, serverName)
        sendJson(response, 200, { accepted: true })
        return
      }
      if (url.pathname === "/v1/events") {
        methodAllowed(request, "GET")
        const cursor = parseEventCursor(request, url)
        response.writeHead(200, {
          "cache-control": "no-cache, no-store",
          connection: "keep-alive",
          "content-type": "text/event-stream; charset=utf-8",
          "x-accel-buffering": "no",
        })
        response.flushHeaders()
        for (const event of events) {
          if (event.sequence > cursor) response.write(sseFrame(event))
        }
        eventClients.add(response)
        request.once("close", () => eventClients.delete(response))
        return
      }
      if (url.pathname === "/v1/runs") {
        methodAllowed(request, "POST")
        if (!runController) throw new RequestError(404, "not_found", "Run execution is not configured")
        const body = await readJson(request, claudeWorkerRunRequestSchema)
        sendJson(response, 202, claudeWorkerRunResponseSchema.parse(await runController.start(body)))
        return
      }
      const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname)
      if (runMatch) {
        methodAllowed(request, "GET")
        if (!runController) throw new RequestError(404, "not_found", "Run execution is not configured")
        const runId = decodeURIComponent(runMatch[1] ?? "")
        const observation = runController.observe(runId)
        if (!observation) throw new RequestError(404, "run_not_found", "Claude run was not found")
        sendJson(response, 200, claudeWorkerRunObservationSchema.parse(observation))
        return
      }
      const abortMatch = /^\/v1\/runs\/([^/]+)\/abort$/.exec(url.pathname)
      if (abortMatch) {
        methodAllowed(request, "POST")
        if (!runController) throw new RequestError(404, "not_found", "Run execution is not configured")
        const runId = decodeURIComponent(abortMatch[1] ?? "")
        const body = await readJson(request, claudeWorkerAbortRequestSchema)
        if (body.runId !== runId) throw new RequestError(400, "invalid_request", "Abort run identifier does not match the route")
        await runController.abort(body.sessionId, body.runId)
        sendJson(response, 202, claudeWorkerAbortResponseSchema.parse({ accepted: true, runId, status: "aborting" }))
        return
      }
      const stopSubagentMatch = /^\/v1\/runs\/([^/]+)\/subagents\/([^/]+)\/stop$/.exec(url.pathname)
      if (stopSubagentMatch) {
        methodAllowed(request, "POST")
        if (!runController?.stopSubagent) throw new RequestError(422, "unsupported_capability", "Subagent stop is not supported")
        const runId = decodeURIComponent(stopSubagentMatch[1] ?? "")
        const taskId = decodeURIComponent(stopSubagentMatch[2] ?? "")
        const body = await readJson(request, claudeWorkerStopSubagentRequestSchema)
        if (body.runId !== runId || body.taskId !== taskId) throw new RequestError(400, "invalid_request", "Subagent identifiers do not match the route")
        await runController.stopSubagent!(body.sessionId, runId, taskId)
        sendJson(response, 202, claudeWorkerStopSubagentResponseSchema.parse({ accepted: true, taskId, status: "stopping" }))
        return
      }
      if (url.pathname === "/v1/sessions/fork") {
        methodAllowed(request, "POST")
        if (!runController?.forkSession) throw new RequestError(422, "unsupported_capability", "Native fork is not supported")
        const body = await readJson(request, claudeWorkerForkRequestSchema)
        sendJson(response, 201, claudeWorkerForkResponseSchema.parse(await runController.forkSession(body)))
        return
      }
      const interactionMatch = /^\/v1\/interactions\/([^/]+)\/resolve$/.exec(url.pathname)
      if (interactionMatch) {
        methodAllowed(request, "POST")
        if (!runController) throw new RequestError(404, "not_found", "Run execution is not configured")
        const interactionId = decodeURIComponent(interactionMatch[1] ?? "")
        const body = await readJson(request, claudeWorkerResolveInteractionRequestSchema)
        await runController.resolveInteraction(interactionId, body.sessionId, body.runId, body.resolution)
        sendJson(response, 200, claudeWorkerResolveInteractionResponseSchema.parse({ accepted: true, interactionId }))
        return
      }
      if (url.pathname === "/v1/shutdown") {
        methodAllowed(request, "POST")
        const body = await readJson(request, claudeWorkerShutdownRequestSchema)
        if (status !== "stopping") {
          status = "stopping"
          publishEvent("worker.stopping", { reason: body.reason ?? "requested" })
        }
        sendJson(response, 202, claudeWorkerShutdownResponseSchema.parse({ accepted: true, status: "stopping" }))
        response.once("finish", () => {
          void Promise.resolve()
            .then(() => options.onShutdown?.(body.reason))
            .finally(() => close())
            .catch(() => undefined)
        })
        return
      }
      throw new RequestError(404, "not_found", "Worker endpoint was not found")
    })().catch((error) => sendError(response, error))
  })

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(requestedPort, host, () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === "string") {
    await close()
    throw new Error("Claude worker transport did not obtain a TCP address")
  }
  status = "healthy"
  const urlHost = host === "::1" ? `[${host}]` : host
  const transport: ClaudeWorkerTransport = {
    host,
    port: address.port,
    url: `http://${urlHost}:${address.port}`,
    publishEvent,
    close,
  }
  publishEvent("worker.ready", { transport: "loopback-http" })
  return transport
}
