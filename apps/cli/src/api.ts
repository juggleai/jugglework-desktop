import { randomUUID } from "node:crypto";

export type JsonRecord = Record<string, unknown>;

export class JuggleWorkApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = "JuggleWorkApiError";
  }
}

export type WorkspaceInfo = {
  id: string;
  name?: string;
  displayName?: string;
  path?: string;
  directory?: string;
  workspaceType?: string;
};

export type RuntimeProviderStatus = {
  providerId: string;
  published: boolean | null;
  imported: boolean | null;
  loaded: boolean;
  authenticated: boolean;
  enabled: boolean | null;
  models: Array<{
    id: string;
    published: boolean | null;
    imported: boolean | null;
    loaded: boolean;
    authenticated: boolean;
    enabled: boolean;
    verifiedExecutable: boolean | null;
  }>;
};

export type SessionInfo = {
  id: string;
  title?: string | null;
  slug?: string | null;
  parentID?: string | null;
  directory?: string | null;
  time?: { created?: number; updated?: number; completed?: number; archived?: number };
  status?: SessionSnapshot["status"];
};

export type SessionMessage = {
  info: { id: string; sessionID: string; role: string; time?: Record<string, number> } & JsonRecord;
  parts: Array<{ id: string; type?: string; text?: string; tool?: string; state?: JsonRecord } & JsonRecord>;
};

export type SessionSnapshot = {
  session: SessionInfo;
  messages: SessionMessage[];
  todos: Array<{ content: string; status: string; priority: string } & JsonRecord>;
  status: { type: "idle" | "busy" | "running" | "retry" | "retrying" | "waiting"; attempt?: number; message?: string; next?: number };
};

export type SessionRun = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  generation: number;
  status: string;
};

export type OwnedInteraction = {
  id: string;
  sessionID: string;
  protocol: "legacy" | "v2";
  targetSessionId: string;
  rootSessionId: string;
  permission?: string;
  patterns?: string[];
  always?: string[];
  action?: string;
  resources?: string[];
  save?: string[];
  v2?: { action?: string; resources?: string[]; save?: string[] };
  questions?: Array<{
    id?: string;
    question: string;
    options: Array<{ label: string } & JsonRecord>;
    multiple?: boolean;
    custom?: boolean;
  }>;
} & JsonRecord;

export class JuggleWorkApiClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly hostToken: string | null,
    private readonly timeoutMs = 30_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    if (this.hostToken) headers.set("X-JuggleWork-Host-Token", this.hostToken);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      const timeoutMs = init.timeoutMs ?? this.timeoutMs;
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: init.signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined),
      });
    } catch (error) {
      throw new JuggleWorkApiError(
        `Unable to reach JuggleWork Server at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
        0,
        "connection_failed",
      );
    }
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = text; }
    }
    if (!response.ok) {
      const body = payload && typeof payload === "object" ? payload as JsonRecord : null;
      const message = typeof body?.message === "string" ? body.message : `JuggleWork Server returned HTTP ${response.status}`;
      throw new JuggleWorkApiError(message, response.status, typeof body?.code === "string" ? body.code : null, body?.details);
    }
    return payload as T;
  }

  health() { return this.request<{ ok: boolean; version: string; opencodeVersion?: string }>("/health"); }
  preflightProviderAuthority(workspaceId: string) {
    return this.request<{ ok: true }>(`/workspace/${encodeURIComponent(workspaceId)}/provider-auth`);
  }
  upsertUserEnvironment(entries: Array<{ key: string; value: string }>) {
    return this.request<{ ok: true; count: number }>("/env", { method: "PUT", body: JSON.stringify({ entries }) });
  }
  removeUserEnvironment(key: string) {
    return this.request<{ ok: true }>(`/env/${encodeURIComponent(key)}`, { method: "DELETE" });
  }
  setProviderAuth(workspaceId: string, providerId: string, key: string) {
    return this.request<{ ok: true }>(`/workspace/${encodeURIComponent(workspaceId)}/provider-auth/${encodeURIComponent(providerId)}`, {
      method: "PUT", body: JSON.stringify({ type: "api", key }),
    });
  }
  removeProviderAuth(workspaceId: string, providerId: string) {
    return this.request<{ ok: true }>(`/workspace/${encodeURIComponent(workspaceId)}/provider-auth/${encodeURIComponent(providerId)}`, { method: "DELETE" });
  }
  patchWorkspaceConfig(workspaceId: string, payload: { opencode?: JsonRecord; jugglework?: JsonRecord }) {
    return this.request<{ updatedAt: number }>(`/workspace/${encodeURIComponent(workspaceId)}/config`, {
      method: "PATCH", body: JSON.stringify(payload),
    });
  }
  reloadEngine(workspaceId: string) {
    return this.request<{ ok: true; reloadedAt: number }>(`/workspace/${encodeURIComponent(workspaceId)}/engine/reload`, { method: "POST" });
  }
  providerStatus(workspaceId: string, providerId: string) {
    return this.request<RuntimeProviderStatus>(`/workspace/${encodeURIComponent(workspaceId)}/provider-status/${encodeURIComponent(providerId)}`);
  }
  getCloudProviderImport(workspaceId: string, cloudProviderId: string) {
    return this.request<{ item: JsonRecord | null }>(`/workspace/${encodeURIComponent(workspaceId)}/cloud-provider-imports/${encodeURIComponent(cloudProviderId)}`);
  }
  setCloudProviderImport(workspaceId: string, cloudProviderId: string, item: JsonRecord) {
    return this.request<{ ok: true; item: JsonRecord }>(`/workspace/${encodeURIComponent(workspaceId)}/cloud-provider-imports/${encodeURIComponent(cloudProviderId)}`, {
      method: "PUT", body: JSON.stringify({ item }),
    });
  }
  removeCloudProviderImport(workspaceId: string, cloudProviderId: string) {
    return this.request<{ ok: true }>(`/workspace/${encodeURIComponent(workspaceId)}/cloud-provider-imports/${encodeURIComponent(cloudProviderId)}`, { method: "DELETE" });
  }
  status() { return this.request<JsonRecord>("/status"); }
  listWorkspaces() { return this.request<{ items: WorkspaceInfo[]; activeId?: string | null }>("/workspaces"); }
  addLocalWorkspace(folderPath: string) {
    return this.request<{ activeId: string; workspaces: WorkspaceInfo[]; persisted: boolean }>("/workspaces/local", {
      method: "POST", body: JSON.stringify({ folderPath }),
    });
  }
  activateWorkspace(workspaceId: string) {
    return this.request<{ activeId: string; workspace: WorkspaceInfo; persisted: boolean }>(`/workspaces/${encodeURIComponent(workspaceId)}/activate?persist=true`, {
      method: "POST", body: JSON.stringify({}),
    });
  }
  runtimeConfig(workspaceId: string) { return this.request<JsonRecord>(`/workspace/${encodeURIComponent(workspaceId)}/runtime-config`); }
  listSessions(workspaceId: string, limit = 20) {
    return this.request<{ items: SessionInfo[] }>(`/workspace/${encodeURIComponent(workspaceId)}/sessions?roots=false&limit=${limit}`);
  }
  createSession(workspaceId: string, title: string) {
    return this.request<{ item: SessionInfo; started: boolean }>(`/workspace/${encodeURIComponent(workspaceId)}/sessions`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
  }
  getSnapshot(workspaceId: string, sessionId: string) {
    return this.request<{ item: SessionSnapshot }>(`/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/snapshot?limit=200`);
  }
  forkSession(workspaceId: string, sessionId: string, messageId?: string) {
    return this.request<{ item: SessionInfo }>(`/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/fork`, {
      method: "POST", body: JSON.stringify(messageId ? { messageId } : {}),
    });
  }
  updateSession(workspaceId: string, sessionId: string, input: { title?: string; archived?: boolean }) {
    return this.request<{ item: SessionInfo }>(`/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH", body: JSON.stringify(input),
    });
  }
  deleteSession(workspaceId: string, sessionId: string) {
    return this.request<{ ok: true }>(`/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  }
  queuePrompt(workspaceId: string, sessionId: string, prompt: string) {
    return this.request<{ disposition: "enqueued"; admissionId: string }>(`/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/queue`, {
      method: "POST",
      body: JSON.stringify({ id: randomUUID(), prompt }),
    });
  }
  startRun(workspaceId: string, sessionId: string, input: JsonRecord, admissionTimeoutMs?: number) {
    return this.request<{ disposition: "started"; run: SessionRun } | { disposition: "steered"; admissionId: string }>(
      `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/runs/start`,
      { method: "POST", body: JSON.stringify(input), timeoutMs: admissionTimeoutMs },
    );
  }
  listActiveRuns(workspaceId: string) {
    return this.request<{ items: SessionRun[] }>(`/workspace/${encodeURIComponent(workspaceId)}/session-runs`);
  }
  observeRun(workspaceId: string, sessionId: string, runId: string, status: string) {
    return this.request<{ cleared: boolean; run: SessionRun | null; terminalStatus: "completed" | "failed" | "aborted" | null }>(
      `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/observations`,
      { method: "POST", body: JSON.stringify({ status }) },
    );
  }
  abortRun(workspaceId: string, sessionId: string, runId: string, correlationId: string) {
    return this.request<{ run?: SessionRun; abortRequested?: boolean; accepted?: boolean }>(
      `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/abort`,
      { method: "POST", body: JSON.stringify({ abortCommandCorrelationId: correlationId }) },
    );
  }
  getInteractions(workspaceId: string, rootSessionId: string) {
    return this.request<{ item: { permissions: OwnedInteraction[]; questions: OwnedInteraction[] } }>(
      `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(rootSessionId)}/interactions/snapshot?includeDescendants=true`,
    );
  }
  replyPermission(workspaceId: string, interaction: OwnedInteraction, response: "allow_once" | "always" | "reject") {
    return this.request<JsonRecord>(
      `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(interaction.targetSessionId)}/interactions/${encodeURIComponent(interaction.id)}/permission/reply`,
      { method: "POST", body: JSON.stringify({ origin: "local-renderer", commandCorrelationId: randomUUID(), response }) },
    );
  }
  grantPermission(workspaceId: string, interaction: OwnedInteraction) {
    return this.request<JsonRecord>(
      `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(interaction.targetSessionId)}/interactions/${encodeURIComponent(interaction.id)}/permission/grant-reply`,
      { method: "POST" },
    );
  }
  replyQuestion(workspaceId: string, interaction: OwnedInteraction, answers: Array<{ questionId: string; values: string[] }>) {
    return this.request<JsonRecord>(
      `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(interaction.targetSessionId)}/interactions/${encodeURIComponent(interaction.id)}/question/reply`,
      { method: "POST", body: JSON.stringify({ origin: "local-renderer", commandCorrelationId: randomUUID(), answers }) },
    );
  }
  getPermissionMode(workspaceId: string, sessionId: string) {
    return this.request<{ state: { authorityRevision: number; effectiveMode?: string } | null; supported: boolean; profileVersion: number }>(
      `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/permission-mode`,
    );
  }
  setRequestApproval(workspaceId: string, sessionId: string, expectedRevision: number) {
    return this.request<JsonRecord>(
      `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/permission-mode`,
      { method: "PUT", body: JSON.stringify({ requestedMode: "request-approval", expectedRevision }) },
    );
  }
  compactSession(workspaceId: string, sessionId: string, model: { providerID: string; modelID: string }) {
    return this.request<JsonRecord>(
      `/workspace/${encodeURIComponent(workspaceId)}/opencode/session/${encodeURIComponent(sessionId)}/summarize`,
      { method: "POST", body: JSON.stringify(model), timeoutMs: 0 },
    );
  }
  setFullAccess(workspaceId: string, sessionId: string, expectedRevision: number, profileVersion: number) {
    return this.request<JsonRecord>(
      `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/permission-mode`,
      {
        method: "PUT",
        body: JSON.stringify({
          requestedMode: "full-access",
          expectedRevision,
          acknowledgement: { profileVersion, acknowledgedAt: Date.now() },
        }),
      },
    );
  }
}
