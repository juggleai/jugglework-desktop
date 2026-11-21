import { z } from "zod";
import { ApiError } from "../errors.js";
import type { NativeActionRequester } from "./bridge.js";
import { NativeActionProposals, publicProposal, type ProposalStep } from "./proposals.js";
import type { NativeActionTurns } from "./turns.js";
import { calendarPrepareArgs, chatsSearchArgs, imPrepareArgs, meetingPrepareArgs, type NativeWriteAction } from "./write-schema.js";

interface TurnKey {
  workspaceId: string;
  sessionId: string;
  messageId: string;
}

/** Hard cap on one page of tasks; the model asks for more through the cursor. */
export const PRODUCT_TASK_PAGE_LIMIT = 50;
export const PRODUCT_TASK_DEFAULT_LIMIT = 20;
export const CONTACT_CANDIDATE_LIMIT = 10;

const isoInstant = z.string().trim().min(1).max(64).refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO instant");

const productTasksArgs = z.object({
  /** Local calendar date YYYY-MM-DD; the renderer turns it into local midnights. */
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueFrom: isoInstant.optional(),
  dueBefore: isoInstant.optional(),
  status: z.enum(["todo", "completed", "canceled"]).optional(),
  view: z.enum(["assigned", "created", "delegated", "following"]).optional(),
  limit: z.number().int().positive().max(PRODUCT_TASK_PAGE_LIMIT).optional(),
  cursor: z.string().trim().min(1).max(2048).optional(),
}).strict().refine((value) => !(value.dueOn && (value.dueFrom || value.dueBefore)), "dueOn cannot be combined with dueFrom/dueBefore");

const contactsArgs = z.object({
  query: z.string().trim().min(1).max(100),
  limit: z.number().int().positive().max(CONTACT_CANDIDATE_LIMIT).optional(),
}).strict();

/** Read-only native queries bound to the turn's frozen identity. */
export class NativeActionsService {
  constructor(
    private readonly turns: NativeActionTurns,
    private readonly request: NativeActionRequester,
    readonly proposals = new NativeActionProposals(),
  ) {}

  private scope(key: TurnKey) {
    const scope = this.turns.get(key.workspaceId, key.sessionId, key.messageId);
    if (!scope) throw new ApiError(409, "native_actions_scope_required", "本轮消息没有可用的登录组织，请登录并进入组织后重新发送");
    return scope;
  }

  async listProductTasks(key: TurnKey, rawArgs: unknown) {
    const args = productTasksArgs.parse(rawArgs ?? {});
    return this.request({ op: "product_tasks.list", scope: this.scope(key), params: args });
  }

  async searchContacts(key: TurnKey, rawArgs: unknown) {
    const args = contactsArgs.parse(rawArgs ?? {});
    return this.request({ op: "contacts.search", scope: this.scope(key), params: args });
  }

  async searchChats(key: TurnKey, rawArgs: unknown) {
    const args = chatsSearchArgs.parse(rawArgs ?? {});
    return this.request({ op: "chats.search", scope: this.scope(key), params: args });
  }

  /**
   * Prepares a write without performing it. The renderer resolves targets and
   * returns what the card shows plus the exact payload; the user's click on the
   * card is the only way it runs.
   */
  async prepare(key: TurnKey, action: NativeWriteAction, rawArgs: unknown) {
    const schema = action === "calendar.create" ? calendarPrepareArgs : action === "meeting.create" ? meetingPrepareArgs : imPrepareArgs;
    const args = schema.parse(rawArgs ?? {});
    const scope = this.scope(key);
    const op = action === "calendar.create" ? "calendar.prepare" : action === "meeting.create" ? "meeting.prepare" : "im.prepare";
    const prepared = preparedSchema.parse(await this.request({ op, scope, params: args }));
    let proposal;
    try {
      proposal = this.proposals.create({
        workspaceId: key.workspaceId, sessionId: key.sessionId, turnId: key.messageId, scope, action,
        preview: prepared.preview, execution: prepared.execution,
      });
    } catch (error) {
      throw new ApiError(429, (error as { code?: string }).code ?? "native_action_too_many_proposals", (error as Error).message);
    }
    return {
      ...publicProposal(proposal),
      note: "Nothing has been written yet. The user must review and confirm this on the card under your reply. Do not say it was created or sent; ask the user to check the card. Check the outcome later with native_actions.status.",
    };
  }

  status(key: Omit<TurnKey, "messageId">, proposalId: string) {
    const item = this.proposals.get(key.workspaceId, key.sessionId, proposalId);
    if (!item) throw new ApiError(404, "native_action_proposal_not_found", "待确认操作不存在");
    return publicProposal(item);
  }

  list(workspaceId: string, sessionId: string) {
    return { items: this.proposals.listForSession(workspaceId, sessionId).map(publicProposal) };
  }

  /** Host-only: hands the frozen payload to the renderer that will run it. */
  claim(workspaceId: string, sessionId: string, proposalId: string) {
    const item = proposalCall(() => this.proposals.claim(workspaceId, sessionId, proposalId));
    return { proposal: publicProposal(item), scope: item.scope, execution: item.execution };
  }

  cancel(workspaceId: string, sessionId: string, proposalId: string) {
    return publicProposal(proposalCall(() => this.proposals.cancel(workspaceId, sessionId, proposalId)));
  }

  complete(workspaceId: string, sessionId: string, proposalId: string, rawSteps: unknown) {
    const steps = z.array(stepSchema).min(1).max(20).parse(rawSteps);
    return publicProposal(proposalCall(() => this.proposals.complete(workspaceId, sessionId, proposalId, steps)));
  }
}

const preparedSchema = z.object({
  preview: z.record(z.string(), z.unknown()),
  execution: z.record(z.string(), z.unknown()),
}).strict();

const stepSchema: z.ZodType<ProposalStep> = z.object({
  name: z.string().min(1).max(64),
  status: z.enum(["succeeded", "failed", "unknown", "skipped"]),
  error: z.string().max(500).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
}).strict();

function proposalCall<T>(run: () => T): T {
  try { return run(); } catch (error) {
    const value = error as { status?: number; code?: string; message?: string };
    throw new ApiError(value.status ?? 409, value.code ?? "native_action_proposal_invalid", value.message ?? "操作状态无效");
  }
}
