import { publishVideoArtifact } from "./artifact-publisher.js";
import { MediaGenerationRepository } from "./repository.js";
import type { VideoGenerationAdapter, VideoGenerationJob } from "./types.js";

export class MediaGenerationWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<void> | null = null;
  private stopped = true;
  private readonly controllers = new Set<AbortController>();
  constructor(private readonly options: {
    repository: MediaGenerationRepository;
    adapters: VideoGenerationAdapter[];
    workspaceRoot: (workspaceId: string) => string | null;
    pollIntervalMs?: number;
    maxOutputBytes?: number;
  }) {}
  start() { if (!this.stopped) return; this.stopped = false; this.schedule(0); }
  wake() { if (!this.stopped) this.schedule(0); }
  async dispose() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.controllers) controller.abort();
    await this.active?.catch(() => undefined);
  }
  private schedule(delay: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.active = this.pass().finally(() => { this.active = null; this.schedule(this.options.pollIntervalMs ?? 5_000); }); }, delay);
  }
  private async pass() {
    for (const job of this.options.repository.listReconcilable(Date.now())) {
      if (this.stopped) break;
      await this.reconcile(job).catch(() => undefined);
    }
  }
  private async reconcile(job: VideoGenerationJob) {
    const adapter = this.options.adapters.find((candidate) => candidate.matches(job.model));
    if (!adapter || !job.providerJobId) return;
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      if (job.status === "cancel_requested") {
        if (adapter.cancel) await adapter.cancel(job.providerJobId, controller.signal);
        else {
          const state = await adapter.inspect(job.providerJobId, controller.signal);
          if (state.status === "submitted" || state.status === "running") {
            this.options.repository.transition(job.id, job.revision, "cancel_requested", { progress: state.progress, incrementPollAttempts: true, nextPollAt: Date.now() + backoff(job.pollAttempts) });
            return;
          }
        }
      }
      const latest = this.options.repository.get(job.id);
      if (!latest || !latest.providerJobId) return;
      const state = await adapter.inspect(latest.providerJobId, controller.signal);
      if (state.status === "submitted" || state.status === "running") {
        this.options.repository.transition(latest.id, latest.revision, state.status, { progress: state.progress, incrementPollAttempts: true, nextPollAt: Date.now() + backoff(latest.pollAttempts) });
      } else if (state.status === "cancelled") {
        this.options.repository.transition(latest.id, latest.revision, "cancelled");
      } else if (state.status === "failed") {
        this.options.repository.transition(latest.id, latest.revision, "failed", { error: state.error });
      } else if (state.status === "completed") {
        const downloading = this.options.repository.transition(latest.id, latest.revision, "downloading");
        const root = this.options.workspaceRoot(latest.workspaceId);
        if (!root) throw new Error("video_workspace_not_found");
        const response = await adapter.acquireResult(state.resultReference, controller.signal);
        const artifact = await publishVideoArtifact({ response, workspaceRoot: root, jobId: latest.id, maxBytes: this.options.maxOutputBytes ?? 512 * 1024 * 1024 });
        this.options.repository.transition(downloading.id, downloading.revision, "completed", { artifact });
      }
    } catch (error) {
      const latest = this.options.repository.get(job.id);
      if (latest && !["completed", "failed", "cancelled"].includes(latest.status)) {
        this.options.repository.transition(latest.id, latest.revision, "failed", { error: { code: "video_reconciliation_failed", message: error instanceof Error ? error.message.slice(0, 500) : "Video reconciliation failed.", retryable: true } });
      }
    } finally { clearTimeout(timeout); this.controllers.delete(controller); }
  }
}

function backoff(attempts: number) { return Math.min(30_000, 2_000 * 2 ** Math.min(attempts, 4)); }
