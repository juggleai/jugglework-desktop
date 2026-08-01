import { randomUUID } from "node:crypto";
import http from "node:http";

export const ROUTER_PORT = 17832;
export const ROUTER_HOST = "127.0.0.1";

const MAX_BODY_BYTES = 1024 * 1024;

export function normalizeSendMessageArgs(args) {
  if (!args || typeof args !== "object") return args;
  const message = args.message;
  if (!message || typeof message !== "object") return args;

  const normalized = { ...args, message: { ...message } };
  if (normalized.message.name === "text/plain") {
    normalized.message.name = "jg:text";
  }

  const content = normalized.message.content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    if (typeof content.text === "string" && content.content === undefined) {
      normalized.message.content = { content: content.text };
    }
  } else if (typeof content === "string") {
    normalized.message.content = { content };
  }

  return normalized;
}

function errorEnvelope(code, message) {
  return { ok: false, error: { code, message } };
}

export function createRouterServer(invokeJuggleChatSkill, options = {}) {
  if (typeof invokeJuggleChatSkill !== "function") {
    throw new TypeError("[jugglechat-router] invokeJuggleChatSkill must be a function");
  }

  const port = options.port ?? ROUTER_PORT;
  return http.createServer((request, response) => {
    const sendJson = (status, body) => {
      if (response.writableEnded) return;
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };

    const requestUrl = request.url ?? "";
    if (request.method === "GET" && (requestUrl === "/health" || requestUrl.startsWith("/health?"))) {
      const listeningPort = request.socket.localPort ?? port;
      sendJson(200, { ok: true, port: listeningPort, ts: Date.now() });
      return;
    }

    if (request.method !== "POST" || (requestUrl !== "/router" && !requestUrl.startsWith("/router?"))) {
      sendJson(404, errorEnvelope("NOT_FOUND", `unknown path: ${request.method} ${requestUrl}`));
      return;
    }

    let raw = "";
    let receivedBytes = 0;
    let aborted = false;
    request.on("data", (chunk) => {
      if (aborted) return;
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_BODY_BYTES) {
        aborted = true;
        sendJson(413, errorEnvelope("BODY_TOO_LARGE", "request body >1MB"));
        request.destroy();
        return;
      }
      raw += chunk.toString("utf8");
    });

    request.on("end", async () => {
      if (aborted) return;
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch (error) {
        sendJson(400, errorEnvelope("INVALID_JSON", error instanceof Error ? error.message : String(error)));
        return;
      }

      const { source, module, action, args, meta } = body ?? {};
      if (source === undefined || source === null) {
        sendJson(400, errorEnvelope("MISSING_SOURCE", "source is required (the skill that initiated this request)"));
        return;
      }
      if (typeof source !== "string" || !source.trim()) {
        sendJson(400, errorEnvelope("INVALID_SOURCE", "source must be a non-empty string"));
        return;
      }
      if (!module || !action) {
        sendJson(400, errorEnvelope("MISSING_FIELDS", "module and action are required"));
        return;
      }

      const normalizedArgs = module === "message" && action === "sendMessage"
        ? normalizeSendMessageArgs(args ?? {})
        : (args ?? {});
      try {
        const result = await invokeJuggleChatSkill({
          requestId: randomUUID(),
          source: source.trim(),
          module,
          action,
          args: normalizedArgs,
          meta,
        });
        sendJson(200, result);
      } catch (error) {
        sendJson(500, errorEnvelope("INTERNAL", error instanceof Error ? error.message : String(error)));
      }
    });

    request.on("error", (error) => {
      if (!aborted) sendJson(500, errorEnvelope("REQ_ERROR", error.message));
    });
  });
}

export function startRouterServer(invokeJuggleChatSkill, options = {}) {
  const host = options.host ?? ROUTER_HOST;
  const port = options.port ?? ROUTER_PORT;
  const server = createRouterServer(invokeJuggleChatSkill, { port });
  server.on("error", (error) => {
    if ("code" in error && error.code === "EADDRINUSE") {
      console.error(`[jugglechat-router] port ${port} already in use; router disabled`);
      return;
    }
    console.error("[jugglechat-router] server error", error);
  });
  server.listen(port, host, () => {
    console.log(`[jugglechat-router] listening on http://${host}:${port}/router`);
  });
  return server;
}

export function stopRouterServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}
