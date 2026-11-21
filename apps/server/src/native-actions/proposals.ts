import { randomUUID } from "node:crypto";
import type { NativeActionScope } from "./schema.js";
import type { NativeWriteAction } from "./write-schema.js";

export type ProposalState = "pending" | "running" | "succeeded" | "partial" | "failed" | "unknown" | "cancelled" | "expired";
export type StepStatus = "succeeded" | "failed" | "unknown" | "skipped";
export interface ProposalStep { name: string; status: StepStatus; error?: string; result?: unknown }

export interface NativeActionProposal {
  id: string;
  workspaceId: string;
  sessionId: string;
  /** The user message this proposal belongs to; the card is shown under it. */
  turnId: string;
  scope: NativeActionScope;
  action: NativeWriteAction;
  /** What the card shows. Execution uses `execution`, which the model cannot change. */
  preview: Record<string, unknown>;
  execution: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
  state: ProposalState;
  steps: ProposalStep[];
  claimedAt?: number;
}

export const PROPOSAL_TTL_MS = 10 * 60_000;
/** A claimed proposal whose renderer never reported back is shown as unconfirmed, never retried. */
export const RUNNING_STALE_MS = 3 * 60_000;
const PENDING_PER_TURN = 5;

/**
 * Short-lived, single-use write proposals. In memory only: a restart drops all
 * pending proposals, so nothing can be confirmed against a stale identity.
 */
export class NativeActionProposals {
  private readonly items = new Map<string, NativeActionProposal>();

  constructor(private readonly now: () => number = Date.now, private readonly limit = 500) {}

  create(input: Omit<NativeActionProposal, "id" | "createdAt" | "expiresAt" | "state" | "steps">) {
    const pending = [...this.items.values()].filter((item) => item.turnId === input.turnId && item.sessionId === input.sessionId && this.refresh(item).state === "pending");
    if (pending.length >= PENDING_PER_TURN) throw Object.assign(new Error("本轮待确认的操作过多，请先确认或取消已有操作"), { code: "native_action_too_many_proposals" });
    const createdAt = this.now();
    const proposal: NativeActionProposal = {
      ...structuredClone(input), id: `nap_${randomUUID()}`, createdAt, expiresAt: createdAt + PROPOSAL_TTL_MS, state: "pending", steps: [],
    };
    this.items.set(proposal.id, proposal);
    while (this.items.size > this.limit) this.items.delete(this.items.keys().next().value!);
    return proposal;
  }

  private refresh(item: NativeActionProposal) {
    if (item.state === "pending" && this.now() >= item.expiresAt) item.state = "expired";
    if (item.state === "running" && item.claimedAt && this.now() - item.claimedAt >= RUNNING_STALE_MS) item.state = "unknown";
    return item;
  }

  get(workspaceId: string, sessionId: string, id: string) {
    const item = this.items.get(id);
    return item && item.workspaceId === workspaceId && item.sessionId === sessionId ? this.refresh(item) : null;
  }

  listForSession(workspaceId: string, sessionId: string) {
    return [...this.items.values()].filter((item) => item.workspaceId === workspaceId && item.sessionId === sessionId).map((item) => this.refresh(item));
  }

  /**
   * Claims a pending proposal for execution. Synchronous on purpose: two
   * confirms racing each other cannot both see `pending`.
   */
  claim(workspaceId: string, sessionId: string, id: string): NativeActionProposal {
    const item = this.get(workspaceId, sessionId, id);
    if (!item) throw Object.assign(new Error("待确认操作不存在"), { code: "native_action_proposal_not_found", status: 404 });
    if (item.state === "expired") throw Object.assign(new Error("确认已过期，请让助手重新准备"), { code: "native_action_proposal_expired", status: 410 });
    if (item.state !== "pending") throw Object.assign(new Error("该操作已处理，不能重复确认"), { code: "native_action_proposal_used", status: 409 });
    item.state = "running";
    item.claimedAt = this.now();
    return item;
  }

  /** Records the renderer's step receipts once; later reports for the same claim are ignored. */
  complete(workspaceId: string, sessionId: string, id: string, steps: ProposalStep[]) {
    const item = this.get(workspaceId, sessionId, id);
    if (!item) throw Object.assign(new Error("待确认操作不存在"), { code: "native_action_proposal_not_found", status: 404 });
    if (item.state !== "running" && item.state !== "unknown")
      throw Object.assign(new Error("该操作未在执行中"), { code: "native_action_proposal_not_running", status: 409 });
    item.steps = structuredClone(steps);
    item.state = summarize(steps);
    return item;
  }

  cancel(workspaceId: string, sessionId: string, id: string) {
    const item = this.get(workspaceId, sessionId, id);
    if (!item) throw Object.assign(new Error("待确认操作不存在"), { code: "native_action_proposal_not_found", status: 404 });
    if (item.state === "pending") item.state = "cancelled";
    return item;
  }
}

function summarize(steps: ProposalStep[]): ProposalState {
  const ran = steps.filter((step) => step.status !== "skipped");
  if (!ran.length) return "failed";
  if (ran.some((step) => step.status === "unknown")) return "unknown";
  if (ran.every((step) => step.status === "succeeded")) return "succeeded";
  return ran.some((step) => step.status === "succeeded") ? "partial" : "failed";
}

/** What the card and the model may see; never the raw execution payload. */
export function publicProposal(item: NativeActionProposal) {
  return {
    id: item.id, turnId: item.turnId, action: item.action, preview: item.preview,
    createdAt: new Date(item.createdAt).toISOString(), expiresAt: new Date(item.expiresAt).toISOString(),
    state: item.state, steps: item.steps,
  };
}
