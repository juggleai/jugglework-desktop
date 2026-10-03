import { createHash } from "node:crypto";
import {
  REVIEW_SCHEMA_VERSION,
  reviewChecksResponseSchema,
  reviewConnectionStatusSchema,
  reviewDetailSchema,
  reviewFilesResponseSchema,
  reviewListResponseSchema,
  reviewThreadsResponseSchema,
  type ReviewCheck,
  type ReviewConnectionStatus,
  type ReviewFile,
  type ReviewListItem,
  type ReviewRelationship,
  type ReviewThread,
} from "@jugglework/types/reviews";
import { juggleworkCloudMcpConnectionActionSchema } from "@jugglework/types/den/mcp-connection-action";
import { ApiError } from "../errors.js";
import { externalFetch } from "../server-fetch.js";
import { inspectRuntimeOpencodeConfigState, runtimeMcpMap } from "../runtime-opencode-config-store.js";
import type { ServerConfig } from "../types.js";
import {
  JUGGLEWORK_CLOUD_MCP_NAME,
  callCloudMcpTool,
  cloudMcpToolValue,
  openCloudMcpSession,
  type CloudMcpSession,
  type McpFetch,
} from "../connect-cloud-mcp-rpc.js";
import { ReviewMemoryCache } from "./cache.js";
import { decodeReviewId, encodeReviewId, type GithubReviewIdentity } from "./review-id.js";
import type { ReviewInboxInput, ReviewReadProvider, ReviewRequestContext, ReviewTargetInput } from "./types.js";

const SEARCH_NAMES = ["search_pull_requests", "pull_request_read"] as const;
type CapabilityKind = typeof SEARCH_NAMES[number];

type CapabilitySet = {
  connectionId: string;
  connectionName: string;
  credentialKey: string;
  searchPullRequests: string;
  pullRequestRead: string;
};

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown, fallback = "", max = 100_000): string {
  return typeof value === "string" ? value.slice(0, max) : fallback;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function iso(value: unknown): string {
  const date = typeof value === "string" ? new Date(value) : new Date(0);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

function parsePage(cursor: string | undefined): number {
  if (!cursor) return 1;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!isRecord(parsed) || !Number.isInteger(parsed.page) || Number(parsed.page) < 1 || Number(parsed.page) > 1_000) throw new Error("invalid");
    return Number(parsed.page);
  } catch {
    throw new ApiError(400, "invalid_cursor", "Review cursor is invalid.", { retryable: false });
  }
}

function pageCursor(page: number): string {
  return Buffer.from(JSON.stringify({ page }), "utf8").toString("base64url");
}

function connectionIdFromCapability(name: string): string {
  const match = name.match(/^mcp:([^:]+):/);
  return match?.[1] ?? "github";
}

function relationQuery(relationship: ReviewRelationship): string {
  if (relationship === "all") return "is:open involves:@me";
  if (relationship === "authored") return "is:open author:@me";
  if (relationship === "reviewed") return "is:open reviewed-by:@me";
  if (relationship === "team_review_requested") return "is:open team-review-requested:@me";
  return "is:open review-requested:@me";
}

function readItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ["items", "pull_requests", "pullRequests", "results", "files", "check_runs", "checkRuns", "reviewThreads", "threads", "comments", "reviews"]) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
  }
  return [];
}

function repoFromUrl(value: unknown): { owner: string; name: string } | null {
  if (typeof value !== "string") return null;
  const match = value.match(/\/repos\/([^/]+)\/([^/?#]+)/);
  return match ? { owner: decodeURIComponent(match[1]), name: decodeURIComponent(match[2]) } : null;
}

function normalizeAuthor(value: unknown) {
  const record = isRecord(value) ? value : {};
  const login = string(record.login ?? record.name, "unknown", 256);
  return {
    login,
    ...(typeof record.name === "string" && record.name !== login ? { displayName: string(record.name, "", 256) } : {}),
    ...(typeof record.avatar_url === "string" ? { avatarUrl: string(record.avatar_url, "", 2_048) } : {}),
  };
}

function normalizeListItem(value: unknown, capability: CapabilitySet, relationship: ReviewRelationship, fallback?: GithubReviewIdentity): ReviewListItem | null {
  if (!isRecord(value)) return null;
  const repository = isRecord(value.repository) ? value.repository : {};
  const base = isRecord(value.base) ? value.base : {};
  const baseRepository = isRecord(base.repo) ? base.repo : {};
  const fromUrl = repoFromUrl(value.repository_url ?? value.html_url);
  const fullName = string(repository.full_name ?? baseRepository.full_name ?? value.repository_name, fromUrl ? `${fromUrl.owner}/${fromUrl.name}` : fallback ? `${fallback.owner}/${fallback.repository}` : "", 512);
  const [fullOwner = "", fullRepo = ""] = fullName.split("/");
  const owner = string(repository.owner && isRecord(repository.owner) ? repository.owner.login : value.owner, fromUrl?.owner ?? fullOwner ?? fallback?.owner, 256) || fallback?.owner || "";
  const name = string(repository.name ?? value.repo, fromUrl?.name ?? fullRepo ?? fallback?.repository, 256) || fallback?.repository || "";
  const prNumber = number(value.number, fallback?.number ?? 0);
  if (!owner || !name || !prNumber) return null;
  const hostname = (() => {
    try { return new URL(string(value.html_url, `https://${fallback?.hostname ?? "github.com"}/${owner}/${name}/pull/${prNumber}`)).hostname; } catch { return fallback?.hostname ?? "github.com"; }
  })();
  const head = isRecord(value.head) ? value.head : {};
  const state = value.merged === true ? "merged" : value.state === "closed" ? "closed" : "open";
  const checks = isRecord(value.checks) ? value.checks : null;
  const labels = array(value.labels).slice(0, 100).map((entry) => {
    const label = isRecord(entry) ? entry : {};
    return { name: string(label.name ?? entry, "", 128), ...(typeof label.color === "string" ? { color: label.color.slice(0, 6) } : {}) };
  }).filter((label) => label.name);
  const identity: GithubReviewIdentity = { version: 1, provider: "github", connectionId: capability.connectionId, hostname, owner, repository: name, number: prNumber };
  return {
    id: encodeReviewId(identity),
    provider: "github",
    hostname,
    repository: { id: string(repository.id ?? value.repository_id, `${owner}/${name}`, 256), owner, name, fullName: `${owner}/${name}` },
    number: prNumber,
    title: string(value.title, `Pull request #${prNumber}`, 1_000),
    url: string(value.html_url, `https://${hostname}/${owner}/${name}/pull/${prNumber}`, 2_048),
    author: normalizeAuthor(value.user ?? value.author),
    state,
    draft: value.draft === true,
    relationships: [relationship === "all" ? "review_requested" : relationship],
    reviewDecision: value.review_decision === "APPROVED" ? "approved" : value.review_decision === "CHANGES_REQUESTED" ? "changes_requested" : value.review_decision === "REVIEW_REQUIRED" ? "review_required" : "none",
    headRevision: string(head.sha ?? value.head_sha, "unknown", 128),
    updatedAt: iso(value.updated_at),
    changedFiles: number(value.changed_files),
    additions: number(value.additions),
    deletions: number(value.deletions),
    commentCount: number(value.comments),
    labels,
    ...(checks ? { checks: { state: "unknown" as const, total: number(checks.total), failed: number(checks.failed), pending: number(checks.pending) } } : {}),
  };
}

function normalizePatch(patch: string | undefined) {
  if (!patch) return undefined;
  let oldLine = 0;
  let newLine = 0;
  return patch.split("\n").slice(0, 5_000).map((text) => {
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); return { kind: "meta" as const, text: text.slice(0, 20_000) }; }
    if (text.startsWith("+") && !text.startsWith("+++")) return { kind: "addition" as const, newLine: newLine++, text: text.slice(1, 20_001) };
    if (text.startsWith("-") && !text.startsWith("---")) return { kind: "deletion" as const, oldLine: oldLine++, text: text.slice(1, 20_001) };
    const line = { kind: "context" as const, oldLine: oldLine || undefined, newLine: newLine || undefined, text: text.replace(/^ /, "").slice(0, 20_000) };
    if (oldLine) oldLine += 1;
    if (newLine) newLine += 1;
    return line;
  });
}

function normalizeFile(value: unknown, index: number): ReviewFile | null {
  if (!isRecord(value)) return null;
  const path = string(value.filename ?? value.path, "", 4_096);
  if (!path) return null;
  const patch = typeof value.patch === "string" ? value.patch : undefined;
  const status = ["added", "modified", "removed", "renamed", "copied", "changed"].includes(string(value.status)) ? string(value.status) as ReviewFile["status"] : "unknown";
  return { id: `${index}:${path}`, path, ...(typeof value.previous_filename === "string" ? { previousPath: string(value.previous_filename, "", 4_096) } : {}), status, additions: number(value.additions), deletions: number(value.deletions), changes: number(value.changes), ...(patch ? { patch: normalizePatch(patch) } : {}), patchTruncated: Boolean(patch && patch.split("\n").length > 5_000), binary: !patch && number(value.changes) > 0 };
}

function normalizeCheck(value: unknown, index: number): ReviewCheck | null {
  if (!isRecord(value)) return null;
  const name = string(value.name ?? value.context, "", 512);
  if (!name) return null;
  const raw = string(value.conclusion ?? value.status ?? value.state).toLowerCase();
  const state = raw === "success" ? "success" : ["failure", "failed", "timed_out", "action_required"].includes(raw) ? "failure" : ["in_progress", "running"].includes(raw) ? "running" : raw === "queued" ? "queued" : ["cancelled", "canceled"].includes(raw) ? "cancelled" : "unknown";
  return { id: string(value.id ?? value.node_id, String(index), 512), name, ...(value.output && isRecord(value.output) && typeof value.output.summary === "string" ? { detail: string(value.output.summary, "", 4_000) } : {}), state, ...(typeof value.html_url === "string" || typeof value.target_url === "string" ? { url: string(value.html_url ?? value.target_url, "", 2_048) } : {}), ...(typeof value.started_at === "string" ? { startedAt: iso(value.started_at) } : {}), ...(typeof value.completed_at === "string" ? { completedAt: iso(value.completed_at) } : {}) };
}

function normalizeThread(value: unknown, index: number): ReviewThread | null {
  if (!isRecord(value)) return null;
  const comments = array(value.comments).map((entry) => isRecord(entry) ? { id: string(entry.id ?? entry.node_id, String(index), 512), author: normalizeAuthor(entry.user ?? entry.author), body: string(entry.body, "", 50_000), createdAt: iso(entry.created_at), ...(typeof entry.updated_at === "string" ? { updatedAt: iso(entry.updated_at) } : {}), ...(typeof entry.html_url === "string" ? { url: string(entry.html_url, "", 2_048) } : {}) } : null).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)).slice(0, 100);
  if (!comments.length && typeof value.body === "string") comments.push({ id: string(value.id, String(index), 512), author: normalizeAuthor(value.user), body: string(value.body, "", 50_000), createdAt: iso(value.created_at), ...(typeof value.updated_at === "string" ? { updatedAt: iso(value.updated_at) } : {}), ...(typeof value.html_url === "string" ? { url: string(value.html_url, "", 2_048) } : {}) });
  if (!comments.length) return null;
  const side = string(value.side).toLowerCase();
  return { id: string(value.id ?? value.node_id, String(index), 512), ...(typeof value.path === "string" ? { path: string(value.path, "", 4_096) } : {}), ...(number(value.line) ? { line: number(value.line) } : {}), ...(number(value.start_line) ? { startLine: number(value.start_line) } : {}), ...(["left", "right"].includes(side) ? { side: side as "left" | "right" } : {}), outdated: value.isOutdated === true || value.outdated === true, resolved: value.isResolved === true || value.resolved === true, comments };
}

function nextPage(value: unknown, page: number, itemCount: number, limit: number): string | null {
  if (isRecord(value)) {
    if (typeof value.nextPage === "number") return pageCursor(value.nextPage);
    if (isRecord(value.pageInfo) && value.pageInfo.hasNextPage === true) return typeof value.pageInfo.endCursor === "string" ? value.pageInfo.endCursor : pageCursor(page + 1);
  }
  return itemCount >= limit ? pageCursor(page + 1) : null;
}

function safeAction(value: unknown) {
  return juggleworkCloudMcpConnectionActionSchema.safeParse(value).success ? juggleworkCloudMcpConnectionActionSchema.parse(value) : undefined;
}

function toolErrorValue(error: unknown): unknown {
  return isRecord(error) && isRecord(error.toolResult) ? (() => { try { return cloudMcpToolValue({ ...error.toolResult, isError: false }); } catch { return null; } })() : null;
}

function mapConnectionValue(value: unknown): ReviewConnectionStatus | null {
  if (!isRecord(value)) return null;
  if (value.status === "disabled_in_workspace") return reviewConnectionStatusSchema.parse({ schemaVersion: 1, provider: "github", state: "disabled_in_workspace", hint: string(value.hint, "GitHub is disabled for this workspace.", 1_000) });
  const status = value.kind === "connection_status" ? value.connectionStatus : value.connectionStatus;
  const action = safeAction(status);
  if (!action) return null;
  const state = action.actor === "member" ? "member_authorization_required" : action.actor === "organization_admin" ? "organization_admin_action_required" : "provider_admin_action_required";
  return reviewConnectionStatusSchema.parse({ schemaVersion: 1, provider: "github", state, connectionId: action.connectionId, connectionName: action.connectionName, action });
}

export class ConnectGithubReviewProvider implements ReviewReadProvider {
  private readonly cache = new ReviewMemoryCache(250);
  private requestId = 10;

  constructor(private readonly options: {
    config: ServerConfig;
    fetcher?: McpFetch;
    now?: () => Date;
    resolveCloudConfig?: (workspaceId: string) => Promise<Record<string, unknown> | null>;
  }) {}

  private now() { return this.options.now?.() ?? new Date(); }
  private fetcher() { return this.options.fetcher ?? externalFetch; }

  private async session(input: ReviewRequestContext): Promise<CloudMcpSession> {
    if (input.workspace.workspaceType === "remote") throw new ApiError(409, "review_workspace_not_owned", "Review requests must be sent to the workspace's owning server.", { retryable: false });
    const config = await (this.options.resolveCloudConfig
      ? await this.options.resolveCloudConfig(input.workspace.id)
      : (() => inspectRuntimeOpencodeConfigState(this.options.config, input.workspace.id, { signal: input.signal })
        .then((inspection) => inspection.status === "available" ? runtimeMcpMap(inspection.config)[JUGGLEWORK_CLOUD_MCP_NAME] ?? null : null))());
    if (!config) throw new ApiError(503, "github_connection_missing", "GitHub is not connected through JuggleWork Connect.", { retryable: false });
    try {
      const session = await openCloudMcpSession(config, this.fetcher(), "jugglework-review-readonly", { signal: input.signal, timeoutMs: 12_000, maxBytes: 1_048_576 });
      if (!session) throw new ApiError(503, "github_provider_unavailable", "JuggleWork Connect is unavailable.", { retryable: true });
      return session;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (input.signal?.aborted) throw error;
      throw new ApiError(503, "github_provider_unavailable", "JuggleWork Connect is unavailable.", { retryable: true });
    }
  }

  private async search(session: CloudMcpSession, query: string, signal?: AbortSignal): Promise<unknown> {
    const result = await callCloudMcpTool(this.fetcher(), session, this.requestId++, "search_capabilities", { query, limit: 20 }, { signal, timeoutMs: 15_000, maxBytes: 1_048_576 });
    return cloudMcpToolValue(result);
  }

  private async capabilities(input: ReviewRequestContext): Promise<{ session: CloudMcpSession; capabilities: CapabilitySet }> {
    const session = await this.session(input);
    const credentialKey = createHash("sha256").update(session.headers.authorization ?? session.headers.Authorization ?? "anonymous").digest("hex").slice(0, 24);
    const { value } = await this.cache.getOrLoad(`capabilities:${input.workspace.id}:${session.url}:${credentialKey}`, 30_000, async () => {
      const values = await Promise.all(SEARCH_NAMES.map((name) => this.search(session, `GitHub ${name.replaceAll("_", " ")}`, input.signal)));
      const matches = values.flatMap((value) => isRecord(value) ? array(value.matches) : []).filter(isRecord);
      for (const match of matches) {
        const connection = mapConnectionValue(match);
        if (connection) throw new ApiError(409, connection.state === "disabled_in_workspace" ? "github_connection_disabled_in_workspace" : connection.state === "member_authorization_required" ? "github_member_authorization_required" : connection.state === "organization_admin_action_required" ? "github_organization_admin_action_required" : "github_provider_admin_action_required", connection.hint ?? "GitHub connection requires attention.", { retryable: false, connectionId: connection.connectionId, ...(connection.action ? { action: connection.action } : {}) });
      }
      const exact = (suffix: CapabilityKind) => {
        const names = [...new Set(matches.map((match) => string(match.name, "", 1_000)).filter((name) => name.endsWith(`:${suffix}`)))];
        if (names.length !== 1) throw new ApiError(502, "review_contract_unsupported", `GitHub ${suffix} capability is unavailable or ambiguous.`, { retryable: false });
        return names[0];
      };
      const searchPullRequests = exact("search_pull_requests");
      const pullRequestRead = exact("pull_request_read");
      return { connectionId: connectionIdFromCapability(searchPullRequests), connectionName: "GitHub", credentialKey, searchPullRequests, pullRequestRead };
    });
    return { session, capabilities: value };
  }

  private async execute(session: CloudMcpSession, name: string, body: RecordValue, signal?: AbortSignal): Promise<unknown> {
    try {
      const result = await callCloudMcpTool(this.fetcher(), session, this.requestId++, "execute_capability", { name, body }, { signal, timeoutMs: 25_000, maxBytes: 4_194_304 });
      return cloudMcpToolValue(result);
    } catch (error) {
      const remote = toolErrorValue(error);
      const connection = mapConnectionValue(remote);
      if (connection) throw new ApiError(409, connection.state === "member_authorization_required" ? "github_member_authorization_required" : "github_provider_unavailable", connection.hint ?? "GitHub connection requires attention.", { retryable: false, connectionId: connection.connectionId, ...(connection.action ? { action: connection.action } : {}) });
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (message.includes("rate") || message.includes("429")) throw new ApiError(429, "github_rate_limited", "GitHub rate limit reached.", { retryable: true });
      if (message.includes("timed out") || message.includes("timeout")) throw new ApiError(504, "github_provider_timeout", "GitHub request timed out.", { retryable: true });
      throw new ApiError(502, "github_invalid_response", "GitHub returned an invalid response.", { retryable: true });
    }
  }

  async getConnection(input: ReviewRequestContext) {
    try {
      const { capabilities } = await this.capabilities(input);
      return reviewConnectionStatusSchema.parse({ schemaVersion: 1, provider: "github", state: "ready", connectionId: capabilities.connectionId, connectionName: capabilities.connectionName });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const details = isRecord(error.details) ? error.details : {};
      const state = error.code === "github_connection_disabled_in_workspace" ? "disabled_in_workspace" : error.code === "github_member_authorization_required" ? "member_authorization_required" : error.code === "github_organization_admin_action_required" ? "organization_admin_action_required" : error.code === "github_provider_admin_action_required" ? "provider_admin_action_required" : error.code === "github_connection_missing" ? "not_connected" : "unavailable";
      return reviewConnectionStatusSchema.parse({ schemaVersion: 1, provider: "github", state, connectionId: typeof details.connectionId === "string" ? details.connectionId : undefined, connectionName: "GitHub", hint: error.message, action: safeAction(details.action) });
    }
  }

  async listInbox(input: ReviewInboxInput) {
    const page = parsePage(input.cursor);
    const { session, capabilities } = await this.capabilities(input);
    const query = `${relationQuery(input.relationship)}${input.query?.trim() ? ` ${input.query.trim().slice(0, 256)}` : ""}`;
    const key = `inbox:${input.workspace.id}:${capabilities.connectionId}:${capabilities.credentialKey}:${input.relationship}:${query}:${page}:${input.limit}`;
    const { value, cacheHit } = await this.cache.getOrLoad(key, 30_000, async () => this.execute(session, capabilities.searchPullRequests, { query, sort: "updated", order: "desc", page, perPage: input.limit, fields: ["number", "title", "state", "draft", "html_url", "user", "labels", "comments", "created_at", "updated_at", "repository_url"] }, input.signal));
    if (!isRecord(value) && !Array.isArray(value)) throw new ApiError(502, "github_invalid_response", "GitHub pull request search response is invalid.", { retryable: true });
    const items = readItems(value).slice(0, input.limit).map((entry) => normalizeListItem(entry, capabilities, input.relationship)).filter((entry): entry is ReviewListItem => Boolean(entry));
    return reviewListResponseSchema.parse({ schemaVersion: REVIEW_SCHEMA_VERSION, items, nextCursor: nextPage(value, page, items.length, input.limit), snapshotAt: this.now().toISOString(), source: { provider: "github", connectionId: capabilities.connectionId, connectionName: capabilities.connectionName }, cache: { source: cacheHit ? "memory" : "provider", fetchedAt: this.now().toISOString(), stale: false } });
  }

  private async target(input: ReviewTargetInput) {
    const identity = decodeReviewId(input.reviewId);
    const context = await this.capabilities(input);
    if (identity.connectionId !== context.capabilities.connectionId) throw new ApiError(404, "github_review_not_found", "Pull request not found.", { retryable: false });
    return { identity, ...context };
  }

  async getDetail(input: ReviewTargetInput) {
    const { identity, session, capabilities } = await this.target(input);
    const { value, cacheHit } = await this.cache.getOrLoad(`detail:${input.workspace.id}:${capabilities.credentialKey}:${input.reviewId}`, 20_000, () => this.execute(session, capabilities.pullRequestRead, { method: "get", owner: identity.owner, repo: identity.repository, pullNumber: identity.number }, input.signal));
    const raw = isRecord(value) && isRecord(value.pull_request) ? value.pull_request : value;
    const list = normalizeListItem(raw, capabilities, "review_requested", identity);
    if (!list || !isRecord(raw)) throw new ApiError(502, "github_invalid_response", "GitHub pull request response is invalid.", { retryable: true });
    const head = isRecord(raw.head) ? raw.head : {};
    const base = isRecord(raw.base) ? raw.base : {};
    return reviewDetailSchema.parse({ schemaVersion: 1, item: { ...list, body: string(raw.body, "", 100_000), baseBranch: string(base.ref, "", 512), headBranch: string(head.ref, "", 512), mergeable: raw.mergeable === true ? "mergeable" : raw.mergeable === false ? "conflicting" : "unknown", viewerPermission: "unknown" }, cache: { source: cacheHit ? "memory" : "provider", fetchedAt: this.now().toISOString(), stale: false } });
  }

  async listFiles(input: ReviewTargetInput & { cursor?: string; limit: number }) {
    const page = parsePage(input.cursor);
    const { identity, session, capabilities } = await this.target(input);
    const { value, cacheHit } = await this.cache.getOrLoad(`files:${input.workspace.id}:${capabilities.credentialKey}:${input.reviewId}:${page}:${input.limit}`, 60_000, () => this.execute(session, capabilities.pullRequestRead, { method: "get_files", owner: identity.owner, repo: identity.repository, pullNumber: identity.number, page, perPage: input.limit }, input.signal));
    const files = readItems(value).slice(0, input.limit).map(normalizeFile).filter((entry): entry is ReviewFile => Boolean(entry));
    const headRevision = isRecord(value) ? string(value.head_sha ?? value.headRevision, "unknown", 128) : "unknown";
    return reviewFilesResponseSchema.parse({ schemaVersion: 1, items: files, nextCursor: nextPage(value, page, files.length, input.limit), snapshotAt: this.now().toISOString(), source: { provider: "github", connectionId: capabilities.connectionId, connectionName: capabilities.connectionName }, cache: { source: cacheHit ? "memory" : "provider", fetchedAt: this.now().toISOString(), stale: false }, headRevision, truncated: files.some((file) => file.patchTruncated) });
  }

  async getChecks(input: ReviewTargetInput) {
    const { identity, session, capabilities } = await this.target(input);
    const { value, cacheHit } = await this.cache.getOrLoad(`checks:${input.workspace.id}:${capabilities.credentialKey}:${input.reviewId}`, 10_000, () => this.execute(session, capabilities.pullRequestRead, { method: "get_check_runs", owner: identity.owner, repo: identity.repository, pullNumber: identity.number, perPage: 100 }, input.signal));
    const checks = readItems(value).slice(0, 500).map(normalizeCheck).filter((entry): entry is ReviewCheck => Boolean(entry));
    const headRevision = isRecord(value) ? string(value.head_sha ?? value.headRevision, "unknown", 128) : "unknown";
    return reviewChecksResponseSchema.parse({ schemaVersion: 1, headRevision, items: checks, cache: { source: cacheHit ? "memory" : "provider", fetchedAt: this.now().toISOString(), stale: false } });
  }

  async listThreads(input: ReviewTargetInput & { cursor?: string; limit: number }) {
    const { identity, session, capabilities } = await this.target(input);
    const { value, cacheHit } = await this.cache.getOrLoad(`threads:${input.workspace.id}:${capabilities.credentialKey}:${input.reviewId}:${input.cursor ?? ""}:${input.limit}`, 30_000, () => this.execute(session, capabilities.pullRequestRead, { method: "get_review_comments", owner: identity.owner, repo: identity.repository, pullNumber: identity.number, perPage: input.limit, ...(input.cursor ? { after: input.cursor } : {}) }, input.signal));
    const threads = readItems(value).slice(0, input.limit).map(normalizeThread).filter((entry): entry is ReviewThread => Boolean(entry));
    const pageInfo = isRecord(value) && isRecord(value.pageInfo) ? value.pageInfo : {};
    return reviewThreadsResponseSchema.parse({ schemaVersion: 1, items: threads, nextCursor: pageInfo.hasNextPage === true && typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null, snapshotAt: this.now().toISOString(), source: { provider: "github", connectionId: capabilities.connectionId, connectionName: capabilities.connectionName }, cache: { source: cacheHit ? "memory" : "provider", fetchedAt: this.now().toISOString(), stale: false }, headRevision: isRecord(value) ? string(value.head_sha ?? value.headRevision, "unknown", 128) : "unknown", truncated: false });
  }

  dispose(): void {
    this.cache.clear();
  }
}
