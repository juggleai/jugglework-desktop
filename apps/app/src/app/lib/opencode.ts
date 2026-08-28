import {
  createOpencodeClient,
  type Message,
  type Part,
  type PermissionRequest,
  type QuestionRequest,
  type QuestionV2Request,
  type Session,
  type Todo,
} from "@opencode-ai/sdk/v2/client";

import { desktopFetch } from "./desktop";
import {
  createJuggleWorkServerClient,
  JuggleWorkServerError,
  type JuggleWorkSessionRun,
  type JuggleWorkSessionRunObservation,
} from "./jugglework-server";
import { isDesktopRuntime } from "./runtime-env";

type FieldsResult<T> =
  | ({ data: T; error?: undefined } & { request: Request; response: Response })
  | ({ data?: undefined; error: unknown } & { request: Request; response: Response });

type PromptAsyncParameters = Parameters<ReturnType<typeof createOpencodeClient>["session"]["promptAsync"]>[0] & {
  reasoning_effort?: string;
};

type CommandParameters = {
  sessionID: string;
  directory?: string;
  messageID?: string;
  agent?: string;
  model?: string;
  arguments?: string;
  command?: string;
  variant?: string;
  parts?: unknown[];
  reasoning_effort?: string;
};

type SessionListParameters = {
  directory?: string;
  roots?: boolean;
  start?: number;
  search?: string;
  limit?: number;
};

type SessionLookupParameters = {
  sessionID: string;
  directory?: string;
};

type SessionMessagesParameters = {
  sessionID: string;
  directory?: string;
  limit?: number;
};

type SessionAbortParameters = {
  sessionID: string;
  directory?: string;
};

type MutationOptions = { throwOnError?: boolean };
type LegacyPermissionReplyParameters = Parameters<ReturnType<typeof createOpencodeClient>["permission"]["reply"]>[0];
type V2PermissionReplyParameters = Parameters<ReturnType<typeof createOpencodeClient>["v2"]["session"]["permission"]["reply"]>[0];
type LegacyQuestionReplyParameters = Parameters<ReturnType<typeof createOpencodeClient>["question"]["reply"]>[0];
type V2QuestionReplyParameters = Parameters<ReturnType<typeof createOpencodeClient>["v2"]["session"]["question"]["reply"]>[0];

export type OpencodeAuth = {
  username?: string;
  password?: string;
  token?: string;
  mode?: "basic" | "jugglework";
};

const DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS = 10_000;
const OAUTH_OPENCODE_REQUEST_TIMEOUT_MS = 5 * 60_000;
const MCP_AUTH_OPENCODE_REQUEST_TIMEOUT_MS = 90_000;
const SESSION_LONG_RUNNING_URL_RE = /\/session\/[^/?#]+\/(?:command|prompt_async|summarize)(?:[?#]|$)/;

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return String(input);
}

function resolveRequestTimeoutMs(input: RequestInfo | URL, fallbackMs: number): number {
  const url = getRequestUrl(input);
  if (SESSION_LONG_RUNNING_URL_RE.test(url)) {
    return 0;
  }
  if (/\/provider\/oauth\//.test(url) || /\/mcp\/auth\/callback\b/.test(url)) {
    return Math.max(fallbackMs, OAUTH_OPENCODE_REQUEST_TIMEOUT_MS);
  }
  if (/\/mcp\/.*auth\b/.test(url)) {
    return Math.max(fallbackMs, MCP_AUTH_OPENCODE_REQUEST_TIMEOUT_MS);
  }
  return fallbackMs;
}


function buildDirectoryHeader(directory?: string) {
  if (!directory?.trim()) return undefined;
  const trimmed = directory.trim();
  return /[^\x00-\x7F]/.test(trimmed) ? encodeURIComponent(trimmed) : trimmed;
}

async function postSessionRequest<T>(
  fetchImpl: typeof globalThis.fetch,
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  options?: { headers?: Record<string, string>; directory?: string; throwOnError?: boolean },
): Promise<FieldsResult<T>> {
  const headers = new Headers(options?.headers);
  headers.set("Content-Type", "application/json");
  const directoryHeader = buildDirectoryHeader(options?.directory);
  if (directoryHeader) {
    headers.set("x-opencode-directory", directoryHeader);
  }

  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const request = new Request(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (response.ok) {
    const data = response.status === 204 ? ({} as T) : ((await response.json()) as T);
    return { data, request, response };
  }

  const text = await response.text();
  let error: unknown = text;
  try {
    error = text ? JSON.parse(text) : text;
  } catch {
    // ignore
  }
  if (options?.throwOnError) throw error;
  return { error, request, response };
}

function resolveJuggleWorkWorkspaceMount(baseUrl: string): { baseUrl: string; workspaceId: string } | null {
  try {
    const url = new URL(baseUrl);
    const match = url.pathname
      .replace(/\/+$/, "")
      .match(/^(.*)\/(?:w|workspace)\/([^/]+)\/opencode$/);
    if (!match || match[1] === undefined || !match[2]) return null;
    url.pathname = match[1] || "/";
    url.search = "";
    return {
      baseUrl: url.toString().replace(/\/+$/, ""),
      workspaceId: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

function createSyntheticResult<T>(
  url: string,
  method: string,
  input:
    | { ok: true; data: T; status?: number }
    | { ok: false; error: unknown; status?: number },
): FieldsResult<T> {
  const request = new Request(url, { method });
  const response = new Response(input.ok ? JSON.stringify(input.data) : null, {
    status: input.status ?? (input.ok ? 200 : 500),
    headers: { "Content-Type": "application/json" },
  });
  if (input.ok) {
    return { data: input.data, request, response };
  }
  return { error: input.error, request, response };
}

async function wrapJuggleWorkMutation<T>(
  url: string,
  mutation: () => Promise<T>,
  options?: { throwOnError?: boolean },
): Promise<FieldsResult<T>> {
  try {
    return createSyntheticResult(url, "POST", { ok: true, data: await mutation() });
  } catch (error) {
    if (options?.throwOnError) throw error;
    return createSyntheticResult(url, "POST", {
      ok: false,
      error,
      status: error instanceof JuggleWorkServerError ? error.status : 500,
    });
  }
}

function shouldFallbackToLegacySessionRead(error: unknown): boolean {
  if (!(error instanceof JuggleWorkServerError)) return false;
  return error.status === 404 || error.status === 405 || error.status === 501;
}

function sessionRunKey(mount: { baseUrl: string; workspaceId: string }, sessionId: string): string {
  return `${mount.baseUrl}\0${mount.workspaceId}\0${sessionId}`;
}

type MountedSessionRunFence = Pick<JuggleWorkSessionRun, "runId" | "generation">;

const mountedSessionRuns = new Map<string, MountedSessionRunFence>();
const mountedSessionObservationQueues = new Map<string, Promise<void>>();
const mountedSessionRunRevisions = new Map<string, number>();

function bumpMountedSessionRunRevision(key: string): void {
  mountedSessionRunRevisions.set(key, (mountedSessionRunRevisions.get(key) ?? 0) + 1);
}

function rememberMountedSessionRun(key: string, run: MountedSessionRunFence): MountedSessionRunFence {
  const current = mountedSessionRuns.get(key);
  if (!current || run.generation >= current.generation) {
    const next = { runId: run.runId, generation: run.generation };
    if (!current || current.runId !== next.runId || current.generation !== next.generation) {
      bumpMountedSessionRunRevision(key);
    }
    mountedSessionRuns.set(key, next);
    return next;
  }
  return current;
}

function forgetMountedSessionRun(key: string, runId: string): void {
  if (mountedSessionRuns.get(key)?.runId === runId) {
    mountedSessionRuns.delete(key);
    bumpMountedSessionRunRevision(key);
  }
}

function mountedSessionRunPrefix(mount: { baseUrl: string; workspaceId: string }): string {
  return `${mount.baseUrl}\0${mount.workspaceId}\0`;
}

function sessionRunMismatchCurrentId(error: JuggleWorkServerError): string | null | undefined {
  if (error.code !== "run_mismatch" || !error.details || typeof error.details !== "object") return undefined;
  const currentRunId = "currentRunId" in error.details
    ? (error.details as { currentRunId?: unknown }).currentRunId
    : undefined;
  return typeof currentRunId === "string" || currentRunId === null ? currentRunId : undefined;
}

function observationRetryDelay(attempt: number): number {
  return [100, 500, 2_000][attempt] ?? 2_000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandCorrelationId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  if (globalThis.crypto?.getRandomValues) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  throw new Error("Secure correlation ID generation is unavailable.");
}

function sdkData<T>(result: { data?: T; error?: unknown }): T {
  if (result.error !== undefined) throw result.error;
  if (result.data !== undefined) return result.data;
  throw new Error("OpenCode returned no data.");
}

function interactionNotFound(interactionId: string): JuggleWorkServerError {
  return new JuggleWorkServerError(404, "interaction_not_found", `Pending interaction ${interactionId} was not found.`);
}

function normalizedQuestionId(question: { question: string; id?: string }): string {
  return question.id || `q_${question.question.slice(0, 32)}`;
}

function semanticQuestionAnswers(
  pending: QuestionRequest | QuestionV2Request,
  answers: string[][] | undefined,
): Array<{ questionId: string; values: string[] }> {
  const values = answers ?? [];
  if (values.length > pending.questions.length) {
    throw new JuggleWorkServerError(400, "invalid_question_answers", "Question answers do not match the pending question schema.");
  }
  return values.map((answer, index) => ({
    questionId: normalizedQuestionId(pending.questions[index]!),
    values: answer,
  }));
}

function sessionRunObservation(raw: unknown): { sessionId: string; status: JuggleWorkSessionRunObservation } | null {
  if (!raw || typeof raw !== "object") return null;
  const event = "payload" in raw && raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
  if (!("type" in event) || typeof event.type !== "string") return null;
  const properties = "properties" in event && event.properties && typeof event.properties === "object" ? event.properties : null;
  if (!properties || !("sessionID" in properties) || typeof properties.sessionID !== "string") return null;
  if (event.type === "session.idle") return { sessionId: properties.sessionID, status: "idle" };
  if (event.type === "session.error") return { sessionId: properties.sessionID, status: "failed" };
  if (event.type !== "session.status" || !("status" in properties)) return null;
  const status = properties.status && typeof properties.status === "object" && "type" in properties.status
    ? properties.status.type
    : properties.status;
  if (status === "busy") return { sessionId: properties.sessionID, status: "running" };
  if (status === "retry") return { sessionId: properties.sessionID, status: "retrying" };
  if (status === "running" || status === "retrying" || status === "waiting" ||
    status === "idle" || status === "completed" || status === "failed" || status === "aborted") {
    return { sessionId: properties.sessionID, status };
  }
  return null;
}

async function wrapJuggleWorkReadWithFallback<T>(
  url: string,
  read: () => Promise<T>,
  fallback: () => Promise<FieldsResult<T>>,
  options?: { throwOnError?: boolean },
): Promise<FieldsResult<T>> {
  try {
    return createSyntheticResult(url, "GET", { ok: true, data: await read() });
  } catch (error) {
    if (!shouldFallbackToLegacySessionRead(error)) {
      if (options?.throwOnError) throw error;
      return createSyntheticResult(url, "GET", {
        ok: false,
        error,
        status: error instanceof JuggleWorkServerError ? error.status : 500,
      });
    }
    return fallback();
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
) {
  const effectiveTimeoutMs = resolveRequestTimeoutMs(input, timeoutMs);
  if (!Number.isFinite(effectiveTimeoutMs) || effectiveTimeoutMs <= 0) {
    return fetchImpl(input, init);
  }

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const signal = controller?.signal;
  const initWithSignal = signal && !init?.signal ? { ...(init ?? {}), signal } : init;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // ignore
      }
      reject(new Error("Request timed out."));
    }, effectiveTimeoutMs);
  });

  try {
    return await Promise.race([fetchImpl(input, initWithSignal), timeoutPromise]);
  } catch (error) {
    const name = (error && typeof error === "object" && "name" in error ? (error as any).name : "") as string;
    if (name === "AbortError") {
      throw new Error("Request timed out.");
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

const encodeBasicAuth = (auth?: OpencodeAuth) => {
  if (!auth?.username || !auth?.password) return null;
  const token = `${auth.username}:${auth.password}`;
  if (typeof btoa === "function") return btoa(token);
  const buffer = (globalThis as { Buffer?: { from: (input: string, encoding: string) => { toString: (encoding: string) => string } } })
    .Buffer;
  return buffer ? buffer.from(token, "utf8").toString("base64") : null;
};

const resolveAuthHeader = (auth?: OpencodeAuth) => {
  if (auth?.mode === "jugglework" && auth.token) {
    return `Bearer ${auth.token}`;
  }
  const encoded = encodeBasicAuth(auth);
  return encoded ? `Basic ${encoded}` : null;
};

/**
 * URLs whose response body we must stream chunk-by-chunk (SSE, long-running
 * message streams, event subscriptions). The Tauri HTTP plugin's
 * `fetch_read_body` IPC call blocks until the entire body is delivered, so
 * pointing it at an infinite stream freezes the webview's main thread for
 * minutes. For these endpoints we always use the webview's native fetch —
 * CORS is already wide open on the jugglework/opencode stack, so there's no
 * reason to route them through the plugin.
 */
const STREAM_URL_RE = /\/(event|stream)(\b|\/|$|\?)/;

function requestIsStreaming(input: RequestInfo | URL, init?: RequestInit): boolean {
  const url = getRequestUrl(input);
  if (STREAM_URL_RE.test(url)) return true;
  const accept =
    input instanceof Request
      ? input.headers.get("accept") ?? input.headers.get("Accept")
      : new Headers(init?.headers).get("accept") ?? new Headers(init?.headers).get("Accept");
  return typeof accept === "string" && accept.toLowerCase().includes("text/event-stream");
}

function nativeFetchRef(): typeof globalThis.fetch {
  if (typeof window !== "undefined" && typeof window.fetch === "function") return window.fetch.bind(window);
  return globalThis.fetch as typeof globalThis.fetch;
}

const createDesktopFetch = (auth?: OpencodeAuth) => {
  const authHeader = resolveAuthHeader(auth);
  const addAuth = (headers: Headers) => {
    if (!authHeader || headers.has("Authorization")) return;
    headers.set("Authorization", authHeader);
  };

  return (input: RequestInfo | URL, init?: RequestInit) => {
    // Streams must go through the webview's native fetch to avoid the
    // Tauri HTTP plugin's `fetch_read_body` hang on never-closing bodies.
    const shouldStream = requestIsStreaming(input, init);
    const underlyingFetch = shouldStream
      ? nativeFetchRef()
      : desktopFetch;
    // Streams should never be timed out at the transport layer; the caller
    // aborts via AbortSignal when the subscription unmounts.
    const timeoutMs = shouldStream ? 0 : DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS;

    if (input instanceof Request) {
      const headers = new Headers(input.headers);
      addAuth(headers);
      const request = new Request(input, { headers });
      return fetchWithTimeout(underlyingFetch, request, undefined, timeoutMs);
    }

    const headers = new Headers(init?.headers);
    addAuth(headers);
    return fetchWithTimeout(
      underlyingFetch,
      input,
      {
        ...init,
        headers,
      },
      timeoutMs,
    );
  };
};

export function unwrap<T>(result: FieldsResult<T>): NonNullable<T> {
  if (result.data !== undefined) {
    return result.data as NonNullable<T>;
  }
  const message =
    result.error instanceof Error
      ? result.error.message
      : typeof result.error === "string"
        ? result.error
        : JSON.stringify(result.error);
  throw new Error(message || "Unknown error");
}

export function createClient(baseUrl: string, directory?: string, auth?: OpencodeAuth) {
  const headers: Record<string, string> = {};
  if (!isDesktopRuntime()) {
    const authHeader = resolveAuthHeader(auth);
    if (authHeader) {
      headers.Authorization = authHeader;
    }
  }

  const fetchImpl = isDesktopRuntime()
    ? createDesktopFetch(auth)
    : (input: RequestInfo | URL, init?: RequestInit) =>
        fetchWithTimeout(globalThis.fetch, input, init, DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS);
  const client = createOpencodeClient({
    baseUrl,
    directory,
    headers: Object.keys(headers).length ? headers : undefined,
    fetch: fetchImpl,
  });

  const session = client.session as typeof client.session;
  const juggleworkMount = auth?.mode === "jugglework" ? resolveJuggleWorkWorkspaceMount(baseUrl) : null;
  const juggleworkSessionClient = juggleworkMount
    ? createJuggleWorkServerClient({ baseUrl: juggleworkMount.baseUrl, token: auth?.token })
    : null;

  if (juggleworkMount && juggleworkSessionClient) {
    const permission = client.permission;
    const legacyPermissionList = permission.list.bind(permission);
    (permission as any).reply = (
      parameters: LegacyPermissionReplyParameters,
      options?: MutationOptions,
    ) => {
      const url = `${juggleworkMount.baseUrl}/workspace/${encodeURIComponent(juggleworkMount.workspaceId)}/interactions/${encodeURIComponent(parameters.requestID)}/permission/reply`;
      return wrapJuggleWorkMutation(url, async () => {
        const pending = sdkData(await legacyPermissionList()).find((item) => item.id === parameters.requestID);
        if (!pending) throw interactionNotFound(parameters.requestID);
        await juggleworkSessionClient.replyPermissionInteraction(
          juggleworkMount.workspaceId,
          pending.sessionID,
          parameters.requestID,
          {
            origin: "local-renderer",
            commandCorrelationId: commandCorrelationId(),
            response: parameters.reply === "once" ? "allow_once" : parameters.reply ?? "reject",
          },
        );
        return true;
      }, options);
    };

    const v2Permission = client.v2.session.permission;
    (v2Permission as any).reply = (
      parameters: V2PermissionReplyParameters,
      options?: MutationOptions,
    ) => {
      const url = `${juggleworkMount.baseUrl}/workspace/${encodeURIComponent(juggleworkMount.workspaceId)}/sessions/${encodeURIComponent(parameters.sessionID)}/interactions/${encodeURIComponent(parameters.requestID)}/permission/reply`;
      return wrapJuggleWorkMutation(url, async () => {
        await juggleworkSessionClient.replyPermissionInteraction(
          juggleworkMount.workspaceId,
          parameters.sessionID,
          parameters.requestID,
          {
            origin: "local-renderer",
            commandCorrelationId: commandCorrelationId(),
            response: parameters.reply === "once" ? "allow_once" : parameters.reply ?? "reject",
          },
        );
      }, options);
    };

    const question = client.question;
    const legacyQuestionList = question.list.bind(question);
    (question as any).reply = (
      parameters: LegacyQuestionReplyParameters,
      options?: MutationOptions,
    ) => {
      const url = `${juggleworkMount.baseUrl}/workspace/${encodeURIComponent(juggleworkMount.workspaceId)}/interactions/${encodeURIComponent(parameters.requestID)}/question/reply`;
      return wrapJuggleWorkMutation(url, async () => {
        const pending = sdkData(await legacyQuestionList()).find((item) => item.id === parameters.requestID);
        if (!pending) throw interactionNotFound(parameters.requestID);
        await juggleworkSessionClient.replyQuestionInteraction(
          juggleworkMount.workspaceId,
          pending.sessionID,
          parameters.requestID,
          {
            origin: "local-renderer",
            commandCorrelationId: commandCorrelationId(),
            answers: semanticQuestionAnswers(pending, parameters.answers),
          },
        );
        return true;
      }, options);
    };

    const v2Question = client.v2.session.question;
    const v2QuestionList = v2Question.list.bind(v2Question);
    (v2Question as any).reply = (
      parameters: V2QuestionReplyParameters,
      options?: MutationOptions,
    ) => {
      const url = `${juggleworkMount.baseUrl}/workspace/${encodeURIComponent(juggleworkMount.workspaceId)}/sessions/${encodeURIComponent(parameters.sessionID)}/interactions/${encodeURIComponent(parameters.requestID)}/question/reply`;
      return wrapJuggleWorkMutation(url, async () => {
        const listed = sdkData(await v2QuestionList({ sessionID: parameters.sessionID }));
        const pending = listed.data.find((item) => item.id === parameters.requestID);
        if (!pending) throw interactionNotFound(parameters.requestID);
        await juggleworkSessionClient.replyQuestionInteraction(
          juggleworkMount.workspaceId,
          parameters.sessionID,
          parameters.requestID,
          {
            origin: "local-renderer",
            commandCorrelationId: commandCorrelationId(),
            answers: semanticQuestionAnswers(pending, parameters.questionV2Reply.answers),
          },
        );
      }, options);
    };
  }
  // TODO(2026-04-12): remove the old-server compatibility path here once all
  // JuggleWork servers expose the workspace-scoped session read APIs.
  const sessionOverrides = session as any as {
    list: (parameters?: SessionListParameters, options?: { throwOnError?: boolean }) => Promise<FieldsResult<Session[]>>;
    get: (parameters: SessionLookupParameters, options?: { throwOnError?: boolean }) => Promise<FieldsResult<Session>>;
    messages: (parameters: SessionMessagesParameters, options?: { throwOnError?: boolean }) => Promise<FieldsResult<Array<{ info: Message; parts: Part[] }>>>;
    todo: (parameters: SessionLookupParameters, options?: { throwOnError?: boolean }) => Promise<FieldsResult<Todo[]>>;
    promptAsync: (parameters: PromptAsyncParameters, options?: { throwOnError?: boolean }) => Promise<FieldsResult<{}>>;
    abort: (parameters: SessionAbortParameters, options?: { throwOnError?: boolean }) => Promise<FieldsResult<boolean>>;
    command: (parameters: CommandParameters, options?: { throwOnError?: boolean }) => Promise<FieldsResult<{}>>;
  };

  const listOriginal = sessionOverrides.list.bind(session);
  sessionOverrides.list = (parameters?: SessionListParameters, options?: { throwOnError?: boolean }) => {
    if (!juggleworkMount || !juggleworkSessionClient) {
      return listOriginal(parameters, options);
    }
    const query = new URLSearchParams();
    if (typeof parameters?.roots === "boolean") query.set("roots", String(parameters.roots));
    if (typeof parameters?.start === "number") query.set("start", String(parameters.start));
    if (parameters?.search?.trim()) query.set("search", parameters.search.trim());
    if (typeof parameters?.limit === "number") query.set("limit", String(parameters.limit));
    const url = `${juggleworkMount.baseUrl}/workspace/${encodeURIComponent(juggleworkMount.workspaceId)}/sessions${query.size ? `?${query.toString()}` : ""}`;
    return wrapJuggleWorkReadWithFallback(
      url,
      async () => (await juggleworkSessionClient.listSessions(juggleworkMount.workspaceId, parameters)).items,
      () => listOriginal(parameters, options),
      options,
    );
  };

  const getOriginal = sessionOverrides.get.bind(session);
  sessionOverrides.get = (parameters: SessionLookupParameters, options?: { throwOnError?: boolean }) => {
    if (!juggleworkMount || !juggleworkSessionClient) {
      return getOriginal(parameters, options);
    }
    const url = `${juggleworkMount.baseUrl}/workspace/${encodeURIComponent(juggleworkMount.workspaceId)}/sessions/${encodeURIComponent(parameters.sessionID)}`;
    return wrapJuggleWorkReadWithFallback(
      url,
      async () => (await juggleworkSessionClient.getSession(juggleworkMount.workspaceId, parameters.sessionID)).item,
      () => getOriginal(parameters, options),
      options,
    );
  };

  const messagesOriginal = sessionOverrides.messages.bind(session);
  sessionOverrides.messages = (parameters: SessionMessagesParameters, options?: { throwOnError?: boolean }) => {
    if (!juggleworkMount || !juggleworkSessionClient) {
      return messagesOriginal(parameters, options);
    }
    const query = new URLSearchParams();
    if (typeof parameters.limit === "number") query.set("limit", String(parameters.limit));
    const url = `${juggleworkMount.baseUrl}/workspace/${encodeURIComponent(juggleworkMount.workspaceId)}/sessions/${encodeURIComponent(parameters.sessionID)}/messages${query.size ? `?${query.toString()}` : ""}`;
    return wrapJuggleWorkReadWithFallback(
      url,
      async () =>
        (await juggleworkSessionClient.getSessionMessages(juggleworkMount.workspaceId, parameters.sessionID, {
          limit: parameters.limit,
        })).items,
      () => messagesOriginal(parameters, options),
      options,
    );
  };

  const todoOriginal = sessionOverrides.todo.bind(session);
  sessionOverrides.todo = (parameters: SessionLookupParameters, options?: { throwOnError?: boolean }) => {
    if (!juggleworkMount || !juggleworkSessionClient) {
      return todoOriginal(parameters, options);
    }
    const url = `${juggleworkMount.baseUrl}/workspace/${encodeURIComponent(juggleworkMount.workspaceId)}/sessions/${encodeURIComponent(parameters.sessionID)}/snapshot`;
    return wrapJuggleWorkReadWithFallback(
      url,
      async () => (await juggleworkSessionClient.getSessionSnapshot(juggleworkMount.workspaceId, parameters.sessionID)).item.todos,
      () => todoOriginal(parameters, options),
      options,
    );
  };

  const promptAsyncOriginal = sessionOverrides.promptAsync.bind(session);
  sessionOverrides.promptAsync = (parameters: PromptAsyncParameters, options?: { throwOnError?: boolean }) => {
    if (!juggleworkMount && !("reasoning_effort" in parameters)) {
      return promptAsyncOriginal(parameters, options);
    }
    const { sessionID, directory: requestDirectory, workspace: _requestWorkspace, ...body } = parameters;
    if (juggleworkMount && juggleworkSessionClient) {
      const url = `${juggleworkMount.baseUrl}/workspace/${encodeURIComponent(juggleworkMount.workspaceId)}/sessions/${encodeURIComponent(sessionID)}/runs/start`;
      return wrapJuggleWorkMutation(url, async () => {
        const result = await juggleworkSessionClient.startSessionRun(juggleworkMount.workspaceId, sessionID, {
          origin: "local-renderer",
          startCommandCorrelationId: commandCorrelationId(),
          prompt: body,
        });
        rememberMountedSessionRun(sessionRunKey(juggleworkMount, sessionID), result.run);
        return {};
      }, options);
    }
    return postSessionRequest(fetchImpl, baseUrl, `/session/${encodeURIComponent(sessionID)}/prompt_async`, body, {
      headers: Object.keys(headers).length ? headers : undefined,
      directory: requestDirectory ?? directory,
      throwOnError: options?.throwOnError,
    });
  };

  const abortOriginal = sessionOverrides.abort.bind(session);
  sessionOverrides.abort = async (parameters: SessionAbortParameters, options?: { throwOnError?: boolean }) => {
    if (!juggleworkMount || !juggleworkSessionClient) return abortOriginal(parameters, options);
    const url = `${juggleworkMount.baseUrl}/workspace/${encodeURIComponent(juggleworkMount.workspaceId)}/sessions/${encodeURIComponent(parameters.sessionID)}/runs/active/abort`;
    return wrapJuggleWorkMutation(url, async () => {
      const key = sessionRunKey(juggleworkMount, parameters.sessionID);
      const activeRunId = (await juggleworkSessionClient.listActiveSessionRuns(juggleworkMount.workspaceId)).items
        .find((run) => run.sessionId === parameters.sessionID);
      if (!activeRunId) {
        const stale = mountedSessionRuns.get(key);
        if (stale) forgetMountedSessionRun(key, stale.runId);
        return false;
      }
      rememberMountedSessionRun(key, activeRunId);
      await juggleworkSessionClient.abortSessionRun(juggleworkMount.workspaceId, parameters.sessionID, activeRunId.runId, {
        abortCommandCorrelationId: commandCorrelationId(),
      });
      return true;
    }, options);
  };

  const commandOriginal = sessionOverrides.command.bind(session);
  sessionOverrides.command = (parameters: CommandParameters, options?: { throwOnError?: boolean }) => {
    if (!juggleworkMount && !("reasoning_effort" in parameters)) {
      return commandOriginal(parameters, options);
    }
    const { sessionID, directory: requestDirectory, ...body } = parameters;
    return postSessionRequest(fetchImpl, baseUrl, `/session/${encodeURIComponent(sessionID)}/command`, body, {
      headers: Object.keys(headers).length ? headers : undefined,
      directory: requestDirectory ?? directory,
      throwOnError: options?.throwOnError,
    });
  };

  if (juggleworkMount && juggleworkSessionClient) {
    const hydrateMountedSessionRuns = async () => {
      const prefix = mountedSessionRunPrefix(juggleworkMount);
      const revisionsAtStart = new Map<string, number>();
      for (const key of mountedSessionRuns.keys()) {
        if (key.startsWith(prefix)) revisionsAtStart.set(key, mountedSessionRunRevisions.get(key) ?? 0);
      }
      const items = (await juggleworkSessionClient.listActiveSessionRuns(juggleworkMount.workspaceId)).items;
      const activeKeys = new Set<string>();
      for (const run of items) {
        const key = sessionRunKey(juggleworkMount, run.sessionId);
        activeKeys.add(key);
        rememberMountedSessionRun(key, run);
      }
      for (const key of mountedSessionRuns.keys()) {
        if (key.startsWith(prefix) && !activeKeys.has(key) &&
          revisionsAtStart.get(key) === (mountedSessionRunRevisions.get(key) ?? 0)) {
          mountedSessionRuns.delete(key);
          bumpMountedSessionRunRevision(key);
        }
      }
      return items;
    };

    const observeMountedSessionRun = async (input: {
      observation: { sessionId: string; status: JuggleWorkSessionRunObservation };
      fence: MountedSessionRunFence;
    }) => {
      const { observation, fence } = input;
      const key = sessionRunKey(juggleworkMount, observation.sessionId);

      for (let attempt = 0; attempt < 4; attempt++) {
        const current = mountedSessionRuns.get(key);
        if (!current || current.runId !== fence.runId || current.generation !== fence.generation) return;
        try {
          const result = await juggleworkSessionClient.observeSessionRun(
            juggleworkMount.workspaceId,
            observation.sessionId,
            fence.runId,
            { status: observation.status },
          );
          if (result.cleared) forgetMountedSessionRun(key, fence.runId);
          return;
        } catch (error) {
          if (error instanceof JuggleWorkServerError) {
            const currentRunId = sessionRunMismatchCurrentId(error);
            if (currentRunId !== undefined) {
              forgetMountedSessionRun(key, fence.runId);
              if (currentRunId) {
                try {
                  const replacement = (await hydrateMountedSessionRuns())
                    .find((run) => run.sessionId === observation.sessionId && run.runId === currentRunId);
                  if (replacement) rememberMountedSessionRun(key, replacement);
                } catch {
                  // A later event or explicit reconciliation will hydrate it.
                }
              }
              return;
            }
            if (error.status < 500) return;
          }
          const retryFence = mountedSessionRuns.get(key);
          if (attempt === 3 || !retryFence || retryFence.runId !== fence.runId || retryFence.generation !== fence.generation) return;
          await delay(observationRetryDelay(attempt));
        }
      }
    };

    const enqueueMountedSessionObservation = (observation: { sessionId: string; status: JuggleWorkSessionRunObservation }) => {
      const key = sessionRunKey(juggleworkMount, observation.sessionId);
      const bindFence = async (): Promise<MountedSessionRunFence | null> => {
        const current = mountedSessionRuns.get(key);
        if (current) return { ...current };
        // A terminal event without a known run identity must not be rebound to
        // a later generation. Server-side authoritative idle reconciliation
        // safely recovers this missed pre-registration terminal.
        if (observation.status === "idle" || observation.status === "completed" ||
          observation.status === "failed" || observation.status === "aborted") return null;
        try {
          const active = (await hydrateMountedSessionRuns())
            .find((run) => run.sessionId === observation.sessionId);
          if (!active) return null;
          return { ...rememberMountedSessionRun(key, active) };
        } catch {
          return null;
        }
      };
      const bound = bindFence();
      const previous = mountedSessionObservationQueues.get(key) ?? Promise.resolve();
      const queued = previous.catch(() => undefined).then(async () => {
        const fence = await bound;
        if (fence) await observeMountedSessionRun({ observation, fence });
      });
      mountedSessionObservationQueues.set(key, queued);
      void queued.finally(() => {
        if (mountedSessionObservationQueues.get(key) === queued) mountedSessionObservationQueues.delete(key);
      });
    };

    const eventClient = client.event as any;
    const subscribeOriginal = eventClient.subscribe.bind(eventClient);
    eventClient.subscribe = async (...args: unknown[]) => {
      const subscription = await subscribeOriginal(...args);
      try {
        await hydrateMountedSessionRuns();
      } catch {
        // Events can still hydrate individual sessions after a reconnect.
      }
      const stream = subscription.stream as AsyncIterable<unknown>;
      return {
        ...subscription,
        stream: (async function* () {
          for await (const event of stream) {
            const observation = sessionRunObservation(event);
            if (observation) enqueueMountedSessionObservation(observation);
            yield event;
          }
        })(),
      };
    };
  }

  return client;
}

export async function waitForHealthy(
  client: ReturnType<typeof createClient>,
  options?: { timeoutMs?: number; pollMs?: number },
) {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const pollMs = options?.pollMs ?? 250;

  const start = Date.now();
  let lastError: string | null = null;

  while (Date.now() - start < timeoutMs) {
    try {
      const health = unwrap(await client.global.health());
      if (health.healthy) {
        return health;
      }
      lastError = "Server reported unhealthy";
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown error";
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(lastError ?? "Timed out waiting for server health");
}
