import { z } from "zod";
import { ApiError } from "../errors.js";
import type { NativeActionRequester } from "./bridge.js";
import type { NativeActionTurns } from "./turns.js";

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
}
