import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { parseNormalizedModelCapabilities } from "@jugglework/types/media-generation";
import {
  TOON_TEXT_OUTPUT_SCHEMAS,
  toonTextActionOutputSchemas,
  type ToonTextJob,
  type ToonTextJobCreateRequest,
} from "@jugglework/types/toon-factory";
import { ApiError } from "../errors.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { ToonFactoryRepository } from "./repository.js";
import { ToonTextJobRepository } from "./text-job-repository.js";
import { registerToonFactoryTransientSession, unregisterSession } from "./transient-session-registry.js";

type WorkspaceOpencodeClient = ReturnType<typeof createOpencodeClient>;

const TRANSIENT_TITLE_PREFIX = "[Transient Toon Factory]";
const DEFAULT_STALE_AGE_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_CLEANUP_LIMIT = 25;

export type ToonTextJobServiceOptions = {
  config: ServerConfig;
  jobs: ToonTextJobRepository;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  createWorkspaceOpencodeClient: (config: ServerConfig, workspace: WorkspaceInfo) => WorkspaceOpencodeClient;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  staleAgeMs?: number;
  cleanupLimit?: number;
  projectionRepository?: (workspace: WorkspaceInfo) => ToonFactoryRepository;
};

export class ToonTextJobService {
  private readonly active = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private disposed = false;
  private projectionTimer: ReturnType<typeof setTimeout> | null = null;
  private projectionRunning = false;

  constructor(private readonly options: ToonTextJobServiceOptions) {
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  start(): void {
    const activeJobs = this.options.jobs.listActive();
    for (const job of activeJobs) {
      if (job.transientSessionId) registerToonFactoryTransientSession(job.workspaceId, job.transientSessionId);
    }
    void this.cleanupStaleSessions().catch(() => 0).finally(() => {
      for (const job of activeJobs) this.dispatch(job.id);
      this.scheduleProjectionReconcile(0);
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.projectionTimer) clearTimeout(this.projectionTimer);
    this.projectionTimer = null;
    await Promise.allSettled(this.active.values());
  }

  dispatch(jobId: string): void {
    if (this.disposed || this.active.has(jobId)) return;
    const running = this.execute(jobId).finally(() => this.active.delete(jobId));
    this.active.set(jobId, running);
  }

  async cancel(jobId: string): Promise<ToonTextJob> {
    let job = this.options.jobs.requestCancellation(jobId, this.now());
    if (job.status !== "cancel_requested" || !job.transientSessionId) return job;
    const workspace = await this.resolveLocalWorkspace(job.workspaceId);
    const opencode = this.options.createWorkspaceOpencodeClient(this.options.config, workspace);
    const aborted = await opencode.session.abort({ sessionID: job.transientSessionId });
    if (aborted.error !== undefined || aborted.data !== true) {
      throw new ApiError(502, "toon_text_cancel_not_accepted", "OpenCode did not accept Toon Factory cancellation");
    }
    return this.options.jobs.require(jobId);
  }

  async cleanupStaleSessions(): Promise<number> {
    const cutoff = this.now() - (this.options.staleAgeMs ?? DEFAULT_STALE_AGE_MS);
    const limit = Math.max(1, Math.min(100, this.options.cleanupLimit ?? DEFAULT_CLEANUP_LIMIT));
    let removed = 0;
    for (const workspaceRef of this.options.config.workspaces) {
      if (removed >= limit) break;
      if (workspaceRef.workspaceType === "remote") continue;
      let workspace: WorkspaceInfo;
      try { workspace = await this.resolveLocalWorkspace(workspaceRef.id); } catch { continue; }
      const opencode = this.options.createWorkspaceOpencodeClient(this.options.config, workspace);
      const listed = await opencode.session.list({ roots: true, search: TRANSIENT_TITLE_PREFIX, limit: limit - removed }).catch(() => null);
      if (!listed) continue;
      for (const session of listed.data ?? []) {
        if (removed >= limit) break;
        const metadata = session.metadata;
        if (
          !metadata || metadata.kind !== "toon-factory" || metadata.transient !== true
          || typeof session.time?.created !== "number" || session.time.created > cutoff
        ) continue;
        const jobId = typeof metadata.jobId === "string" ? metadata.jobId : "";
        if (jobId) {
          const job = this.options.jobs.get(jobId);
          if (job && ["queued", "running", "cancel_requested"].includes(job.status)) {
            this.options.jobs.fail(job.id, {
              code: "toon_text_session_stale",
              message: "The interrupted Toon Factory text session expired before it could be recovered.",
            }, this.now());
          }
        }
        await this.deleteTransientSession(opencode, workspace.id, session.id);
        removed += 1;
      }
    }
    return removed;
  }

  private async execute(jobId: string): Promise<void> {
    let sessionId: string | undefined;
    let opencode: WorkspaceOpencodeClient | undefined;
    try {
      let job = this.options.jobs.require(jobId);
      if (!["queued", "running", "cancel_requested"].includes(job.status)) return;
      const workspace = await this.resolveLocalWorkspace(job.workspaceId);
      opencode = this.options.createWorkspaceOpencodeClient(this.options.config, workspace);
      const projectRepository = new ToonFactoryRepository(workspace.path);

      if (job.status === "cancel_requested") {
        if (job.transientSessionId) await opencode.session.abort({ sessionID: job.transientSessionId }).catch(() => undefined);
        if (job.transientSessionId) await this.deleteTransientSession(opencode, job.workspaceId, job.transientSessionId);
        await this.reconcileProjection(this.options.jobs.cancelled(job.id, this.now()));
        return;
      }
      if (!await projectRepository.ownsTextJob(job)) {
        throw jobFailure("toon_text_job_target_changed", "The Toon Factory workflow target is unavailable");
      }
      await projectRepository.assertTextJobPrerequisites(job.projectId, job);
      await this.validateRequest(job, projectRepository, opencode);

      const committed = await projectRepository.readCommittedTextJobResult(job);
      if (committed) {
        if (job.transientSessionId) await this.deleteTransientSession(opencode, job.workspaceId, job.transientSessionId);
        this.options.jobs.complete(job.id, committed, this.now());
        sessionId = undefined;
        return;
      }

      sessionId = job.transientSessionId;
      if (sessionId) {
        const existing = await opencode.session.get({ sessionID: sessionId });
        if (!existing.data) throw jobFailure("toon_text_session_lost", "The temporary Toon Factory session is no longer available");
        const recovered = await this.tryReadAuthoritativeOutput(opencode, sessionId, job.action);
        if (recovered !== undefined) {
          const result = await projectRepository.commitTextJobResult(job, recovered);
          await this.deleteTransientSession(opencode, job.workspaceId, sessionId);
          sessionId = undefined;
          await this.reconcileProjection(this.options.jobs.complete(job.id, result, this.now()));
          return;
        }
        if (!this.options.jobs.isDispatched(job.id)) {
          const messages = await opencode.session.messages({ sessionID: sessionId, limit: 20 });
          const correlationId = `toon-${job.id}`;
          if ((messages.data ?? []).some((message) => message.info.id === correlationId
            || "parentID" in message.info && message.info.parentID === correlationId)) {
            this.options.jobs.markDispatched(job.id, this.now());
          } else {
            throw jobFailure("toon_text_submission_unknown", "The Toon Factory prompt dispatch outcome is unknown and will not be resent");
          }
        }
      } else {
        if (job.status === "running") {
          throw jobFailure("toon_text_session_lost", "The temporary Toon Factory session is no longer available");
        }
        const created = await opencode.session.create({
          title: `${TRANSIENT_TITLE_PREFIX} ${job.action} · ${job.id}`,
          model: { id: job.selectedModel.modelID, providerID: job.selectedModel.providerID },
          metadata: { kind: "toon-factory", transient: true, jobId: job.id },
          permission: [{ permission: "*", pattern: "*", action: "deny" }],
        });
        if (!created.data?.id || created.error !== undefined) {
          throw jobFailure("toon_text_session_create_failed", "OpenCode could not create the temporary Toon Factory session");
        }
        sessionId = created.data.id;
        registerToonFactoryTransientSession(job.workspaceId, sessionId);
        job = this.options.jobs.start(job.id, sessionId, this.now());
        const prompted = await opencode.session.promptAsync({
          sessionID: sessionId,
          messageID: `toon-${job.id}`,
          model: { providerID: job.selectedModel.providerID, modelID: job.selectedModel.modelID },
          format: { type: "json_schema", schema: job.outputSchema, retryCount: 2 },
          system: "Return only a complete value matching the requested JSON Schema. Do not call tools. Do not include secrets or credentials.",
          parts: [{ type: "text", text: job.requestSnapshot.prompt }],
        });
        if (prompted.error !== undefined) {
          throw jobFailure("toon_text_prompt_rejected", "OpenCode did not accept the Toon Factory prompt");
        }
        this.options.jobs.markDispatched(job.id, this.now());
      }

      await this.waitForTerminal(opencode, sessionId, job.id);
      if (this.disposed) return;
      job = this.options.jobs.require(job.id);
      if (job.status === "cancel_requested") {
        await this.deleteTransientSession(opencode, job.workspaceId, sessionId);
        sessionId = undefined;
        await this.reconcileProjection(this.options.jobs.cancelled(job.id, this.now()));
        return;
      }
      const output = await this.readAuthoritativeOutput(opencode, sessionId, job.action);
      const result = await projectRepository.commitTextJobResult(job, output);
      await this.deleteTransientSession(opencode, job.workspaceId, sessionId);
      sessionId = undefined;
      await this.reconcileProjection(this.options.jobs.complete(job.id, result, this.now()));
    } catch (error) {
      let job: ToonTextJob | null;
      try { job = this.options.jobs.get(jobId); } catch { return; }
      if (job && !["completed", "failed", "cancelled"].includes(job.status)) {
        if (opencode && sessionId) {
          await this.deleteTransientSession(opencode, job.workspaceId, sessionId);
          sessionId = undefined;
        }
        const failure = normalizeFailure(error);
        const terminal = job.status === "cancel_requested"
          ? this.options.jobs.cancelled(job.id, this.now())
          : this.options.jobs.fail(job.id, failure, this.now());
        await this.reconcileProjection(terminal).catch(() => undefined);
      }
    } finally {
      if (!this.disposed && opencode && sessionId) {
        const job = this.options.jobs.get(jobId);
        if (job) await this.deleteTransientSession(opencode, job.workspaceId, sessionId);
      }
    }
  }

  private async deleteTransientSession(opencode: WorkspaceOpencodeClient, workspaceId: string, sessionId: string): Promise<void> {
    const deleted = await opencode.session.delete({ sessionID: sessionId }).catch(() => null);
    if (deleted && deleted.error === undefined && deleted.data === true) unregisterSession(workspaceId, sessionId);
  }

  private async validateRequest(
    job: ToonTextJob,
    repository: ToonFactoryRepository,
    opencode: WorkspaceOpencodeClient,
  ): Promise<void> {
    const project = await repository.getProject(job.projectId);
    const selected = project.project.selectedModels?.text;
    if (!selected || selected.providerID !== job.selectedModel.providerID || selected.modelID !== job.selectedModel.modelID) {
      throw jobFailure("selected_model_unavailable", "The selected Toon Factory text model changed before execution");
    }
    const expectedSchema = structuredClone(job.outputSchema);
    const canonicalSchema = structuredClone(TOON_TEXT_OUTPUT_SCHEMAS[job.action]);
    if (JSON.stringify(expectedSchema) !== JSON.stringify(canonicalSchema)) {
      throw jobFailure("toon_text_schema_mismatch", "The requested output schema is not the canonical Toon Factory schema");
    }
    const providers = await opencode.provider.list();
    const connected = new Set(providers.data?.connected ?? []);
    const provider = (providers.data?.all ?? []).find((candidate) => candidate.id === job.selectedModel.providerID);
    const model = provider?.models?.[job.selectedModel.modelID];
    if (!provider || !connected.has(provider.id) || !model || !isTextCapable(model)) {
      throw jobFailure("selected_model_unavailable", "The selected Toon Factory text model is unavailable");
    }
  }

  private async waitForTerminal(opencode: WorkspaceOpencodeClient, sessionId: string, jobId: string): Promise<void> {
    const controller = new AbortController();
    let subscription: Awaited<ReturnType<WorkspaceOpencodeClient["event"]["subscribe"]>> | undefined;
    try { subscription = await opencode.event.subscribe(undefined, { signal: controller.signal }); } catch { subscription = undefined; }
    try {
      const polling = this.pollUntilIdle(opencode, sessionId, jobId, controller.signal);
      if (!subscription) return await polling;
      await Promise.race([this.consumeEvents(subscription.stream, sessionId, controller.signal), polling]);
    } finally {
      controller.abort();
    }
  }

  private async consumeEvents(stream: AsyncIterable<unknown>, sessionId: string, signal: AbortSignal): Promise<void> {
    for await (const raw of stream) {
      if (signal.aborted || this.disposed) return;
      const event = sessionEvent(raw);
      if (!event || event.sessionId !== sessionId) continue;
      if (event.type === "session.error") throw jobFailure("toon_text_model_failed", event.message ?? "The text model failed");
      if (event.type === "session.idle" || event.type === "session.status" && event.status === "idle") return;
    }
  }

  private async pollUntilIdle(opencode: WorkspaceOpencodeClient, sessionId: string, jobId: string, signal: AbortSignal): Promise<void> {
    let observedBusy = false;
    let abortSent = false;
    for (let attempt = 0; !signal.aborted && !this.disposed; attempt += 1) {
      await this.wait(attempt === 0 ? 200 : 750);
      if (signal.aborted) return;
      const job = this.options.jobs.require(jobId);
      if (job.status === "cancel_requested" && !abortSent) {
        abortSent = true;
        await opencode.session.abort({ sessionID: sessionId }).catch(() => undefined);
      }
      const statuses = await opencode.session.status();
      if (!statuses.data) throw jobFailure("toon_text_status_unavailable", "OpenCode session status is unavailable");
      const status = statuses.data[sessionId];
      if (status?.type === "busy" || status?.type === "retry") {
        observedBusy = true;
        continue;
      }
      if (observedBusy || attempt >= 1) return;
    }
  }

  private async readAuthoritativeOutput(
    opencode: WorkspaceOpencodeClient,
    sessionId: string,
    action: ToonTextJob["action"],
  ): Promise<unknown> {
    const messages = await opencode.session.messages({ sessionID: sessionId, limit: 20 });
    if (!messages.data) throw jobFailure("toon_text_output_unavailable", "OpenCode did not return session messages");
    const assistant = [...messages.data].reverse().find((message) => message.info.role === "assistant");
    if (!assistant || assistant.info.role !== "assistant") {
      throw jobFailure("toon_text_partial_result", "The text job ended without an authoritative assistant result");
    }
    if (assistant.info.error) throw jobFailure("toon_text_model_failed", errorText(assistant.info.error));
    if (assistant.info.structured === undefined) {
      throw jobFailure("toon_text_partial_result", "The text job ended without a complete structured result");
    }
    const parsed = toonTextActionOutputSchemas[action].safeParse(assistant.info.structured);
    if (!parsed.success) throw jobFailure("toon_text_result_malformed", "The text model returned a malformed structured result");
    return parsed.data;
  }

  private async tryReadAuthoritativeOutput(
    opencode: WorkspaceOpencodeClient,
    sessionId: string,
    action: ToonTextJob["action"],
  ): Promise<unknown | undefined> {
    const messages = await opencode.session.messages({ sessionID: sessionId, limit: 20 });
    const assistant = [...(messages.data ?? [])].reverse().find((message) => message.info.role === "assistant");
    if (!assistant || assistant.info.role !== "assistant" || assistant.info.error || assistant.info.structured === undefined) return undefined;
    const parsed = toonTextActionOutputSchemas[action].safeParse(assistant.info.structured);
    return parsed.success ? parsed.data : undefined;
  }

  private async resolveLocalWorkspace(workspaceId: string): Promise<WorkspaceInfo> {
    const workspace = await this.options.resolveWorkspace(this.options.config, workspaceId);
    if (workspace.workspaceType !== "local") throw jobFailure("workspace_unavailable", "Toon Factory text jobs require a local workspace");
    return workspace;
  }

  private async reconcileProjection(job: ToonTextJob): Promise<void> {
    try {
      const workspace = await this.resolveLocalWorkspace(job.workspaceId);
      await (this.options.projectionRepository?.(workspace) ?? new ToonFactoryRepository(workspace.path)).reconcileTextJob(job);
      this.options.jobs.markProjectionClean(job.id);
    } catch {
      this.options.jobs.markProjectionFailed(job.id, this.now());
    }
  }

  private scheduleProjectionReconcile(delay: number): void {
    if (this.disposed) return;
    if (this.projectionTimer) clearTimeout(this.projectionTimer);
    this.projectionTimer = setTimeout(() => {
      this.projectionTimer = null;
      if (this.projectionRunning) return this.scheduleProjectionReconcile(2_000);
      this.projectionRunning = true;
      void Promise.allSettled(this.options.jobs.listProjectionDirty(this.now()).map((job) => this.reconcileProjection(job)))
        .finally(() => {
          this.projectionRunning = false;
          this.scheduleProjectionReconcile(2_000);
        });
    }, delay);
  }
}

function isTextCapable(model: unknown): boolean {
  const capabilities = parseNormalizedModelCapabilities(model);
  const output = capabilities?.modalities?.output ?? [];
  if ((capabilities?.mediaGeneration || capabilities?.imageGeneration) && !output.includes("text")) return false;
  return !((output.includes("video") || output.includes("image")) && !output.includes("text"));
}

function jobFailure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function normalizeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof ApiError) return { code: error.code, message: sanitizeError(error.message) };
  if (error instanceof Error) return { code: (error as Error & { code?: string }).code ?? "toon_text_execution_failed", message: sanitizeError(error.message) };
  return { code: "toon_text_execution_failed", message: "The Toon Factory text job failed" };
}

function sanitizeError(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(bearer|token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[redacted]@")
    .slice(0, 4_000);
}

function sessionEvent(raw: unknown): { type: string; sessionId?: string; status?: string; message?: string } | null {
  const wrapped = isRecord(raw) && isRecord(raw.data) && typeof raw.type !== "string" ? raw.data : raw;
  if (!isRecord(wrapped) || typeof wrapped.type !== "string") return null;
  const properties = isRecord(wrapped.properties) ? wrapped.properties : isRecord(wrapped.data) ? wrapped.data : {};
  return {
    type: wrapped.type,
    ...(typeof properties.sessionID === "string" ? { sessionId: properties.sessionID } : {}),
    ...(isRecord(properties.status) && typeof properties.status.type === "string" ? { status: properties.status.type } : {}),
    ...(properties.error !== undefined ? { message: sanitizeError(errorText(properties.error)) } : {}),
  };
}

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (isRecord(value)) {
    if (typeof value.message === "string") return value.message;
    if (isRecord(value.data) && typeof value.data.message === "string") return value.data.message;
  }
  return "The text model failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
