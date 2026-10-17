import { createHash } from "node:crypto";
import { toonModelPolicySnapshotSchema, type ToonModelPolicySnapshot, type ToonModelReference } from "@jugglework/types/toon-factory";
import { ApiError } from "../errors.js";
import type { ToonWorkspaceRuntimeStore } from "./workspace-runtime-store.js";

const DEFAULT_MAX_AGE_MS = 10 * 60 * 1_000;

export class ToonModelPolicyStore {
  private readonly snapshots = new Map<string, ToonModelPolicySnapshot>();
  private readonly staleAtByWorkspace = new Map<string, number>();
  private readonly listeners = new Set<(workspaceId: string) => void>();

  constructor(
    private readonly persistence?: Pick<ToonWorkspaceRuntimeStore, "listModelPolicies" | "saveModelPolicy">,
    private readonly maxAgeMs = DEFAULT_MAX_AGE_MS,
  ) {
    for (const stored of persistence?.listModelPolicies() ?? []) {
      const parsed = toonModelPolicySnapshotSchema.safeParse(stored.snapshot);
      if (!parsed.success || digestFor(parsed.data) !== parsed.data.digest) continue;
      const current = this.snapshots.get(parsed.data.workspaceId);
      if (!current || parsed.data.revision > current.revision) {
        this.snapshots.set(parsed.data.workspaceId, parsed.data);
        this.staleAtByWorkspace.set(parsed.data.workspaceId, Math.min(stored.staleAt, staleAt(parsed.data, this.maxAgeMs)));
      }
    }
  }

  update(value: unknown): { snapshot: ToonModelPolicySnapshot; applied: boolean } {
    const snapshot = toonModelPolicySnapshotSchema.parse(value);
    const expectedDigest = digestFor(snapshot);
    if (snapshot.digest !== expectedDigest) throw new ApiError(400, "toon_model_policy_digest_invalid", "The desktop model policy digest does not match its content");
    const current = this.snapshots.get(snapshot.workspaceId);
    if (current && snapshot.revision < current.revision) {
      throw new ApiError(409, "toon_model_policy_revision_stale", "The desktop model policy update is older than the current workspace policy");
    }
    if (current && snapshot.revision === current.revision) {
      if (snapshot.digest !== current.digest) {
        throw new ApiError(409, "toon_model_policy_revision_conflict", "The desktop model policy revision is already bound to different content");
      }
      return { snapshot: current, applied: false };
    }
    const expiresAt = staleAt(snapshot, this.maxAgeMs);
    this.persistence?.saveModelPolicy(snapshot, expiresAt);
    this.snapshots.set(snapshot.workspaceId, snapshot);
    this.staleAtByWorkspace.set(snapshot.workspaceId, expiresAt);
    for (const listener of this.listeners) listener(snapshot.workspaceId);
    return { snapshot, applied: true };
  }

  subscribe(listener: (workspaceId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  current(workspaceId: string): ToonModelPolicySnapshot {
    const snapshot = this.snapshots.get(workspaceId);
    if (!snapshot) throw pending("The desktop model policy has not synchronized for this workspace yet. Wait for JuggleWork to finish loading and try again.");
    return snapshot;
  }

  assertAllowed(workspaceId: string, model: ToonModelReference, providerSource: unknown, now = Date.now()): void {
    const policy = this.current(workspaceId);
    if (!policy.signedIn) return;
    const validatedAt = policy.validatedAt ? Date.parse(policy.validatedAt) : Number.NaN;
    const expiresAt = this.staleAtByWorkspace.get(workspaceId) ?? staleAt(policy, this.maxAgeMs);
    if (!policy.policyFresh || !policy.organizationId || !policy.userId || !Number.isFinite(validatedAt) || validatedAt > now + 60_000 || now > expiresAt) {
      throw pending("The organization model policy is not fresh. Refresh JuggleWork policy and try again.");
    }
    const providerID = model.providerID.trim();
    const normalizedProvider = providerID.toLowerCase();
    const cloudManaged = /^lpr_/i.test(providerID) || normalizedProvider === "jugglework";
    if (normalizedProvider === "opencode" && policy.allowZenModel === false) {
      throw unavailable("The selected model is blocked by the organization OpenCode Zen policy.");
    }
    if (providerSource === "config" && !cloudManaged) {
      if (policy.allowCustomProviders === false) throw unavailable("The selected custom provider is blocked by organization policy.");
      return;
    }
    if (cloudManaged || policy.allowedModels.length === 0) return;
    if (!policy.allowedModels.includes(`${providerID}/${model.modelID}`)) {
      throw unavailable("The selected model is not in the organization model catalog.");
    }
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

function unavailable(message: string): ApiError {
  return new ApiError(409, "selected_model_unavailable", message);
}

function pending(message: string): ApiError {
  return new ApiError(409, "model_policy_pending", message, { retryable: true });
}

function digestFor(snapshot: ToonModelPolicySnapshot): string {
  const { revision: _revision, digest: _digest, ...content } = snapshot;
  return createHash("sha256").update(canonical(content)).digest("hex");
}

function staleAt(snapshot: ToonModelPolicySnapshot, maxAgeMs: number): number {
  if (!snapshot.signedIn) return Date.now() + maxAgeMs;
  const validatedAt = snapshot.validatedAt ? Date.parse(snapshot.validatedAt) : Number.NaN;
  return snapshot.policyFresh && Number.isFinite(validatedAt) ? validatedAt + maxAgeMs : Date.now();
}
