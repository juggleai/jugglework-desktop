import { z } from "zod";
import { ApiError } from "../errors.js";
import {
  buildGoalEnvelope,
  GOAL_CRITERIA_MAX,
  GOAL_CRITERION_MAX_CHARS,
  GOAL_OBJECTIVE_MAX_CHARS,
  goalRunPromptText,
  GoalStoreError,
  type GoalRunTrigger,
  type GoalStore,
  type SessionGoal,
} from "../goal-store.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type StartSessionRun = (
  ctx: RequestContext,
  input: {
    sessionId: string;
    origin: "local-renderer";
    startCommandCorrelationId: string | null;
    prompt: Record<string, unknown>;
  },
) => Promise<Response>;

export type RegisterGoalRoutesOptions = {
  routes: Route[];
  config: ServerConfig;
  goals: GoalStore;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  startSessionRun: StartSessionRun;
};

const identifier = z.string().trim().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const criterionInput = z.object({
  id: identifier.optional(),
  text: z.string().min(1).max(GOAL_CRITERION_MAX_CHARS),
  required: z.boolean().optional(),
}).strict();
const runOptions = z.object({
  model: z.object({ providerID: identifier, modelID: identifier }).strict().optional(),
  variant: z.string().max(256).optional(),
}).strict();
const createBody = z.object({
  objective: z.string().min(1).max(GOAL_OBJECTIVE_MAX_CHARS),
  criteria: z.array(criterionInput).min(1).max(GOAL_CRITERIA_MAX),
  /** Start the first goal run immediately (default true). */
  start: z.boolean().optional(),
  run: runOptions.optional(),
}).strict();
const editBody = z.object({
  expectedVersion: z.number().int().positive(),
  objective: z.string().min(1).max(GOAL_OBJECTIVE_MAX_CHARS).optional(),
  criteria: z.array(criterionInput).min(1).max(GOAL_CRITERIA_MAX).optional(),
}).strict();
const versionBody = z.object({ expectedVersion: z.number().int().positive() }).strict();
const continueBody = versionBody.extend({ run: runOptions.optional() }).strict();
const completeBody = versionBody.extend({ override: z.boolean().optional() }).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "invalid_payload", "Goal payload is invalid");
  return parsed.data;
}

function parseId(value: unknown, field: string): string {
  const parsed = identifier.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid_payload", `${field} is invalid`);
  return parsed.data;
}

const STORE_ERROR_STATUS: Record<GoalStoreError["code"], number> = {
  goal_exists: 409,
  goal_not_found: 404,
  goal_version_conflict: 409,
  goal_invalid_transition: 409,
  goal_terminal: 409,
  goal_criteria_unmet: 409,
  goal_continuation_cap: 409,
  goal_invalid: 400,
};

function remapGoalError(error: unknown): never {
  if (error instanceof GoalStoreError) {
    throw new ApiError(STORE_ERROR_STATUS[error.code], error.code, error.message, error.goal ? { goal: error.goal } : undefined);
  }
  throw error;
}

/** Goals are a local-workspace feature in the first release. */
export function assertGoalWorkspace(workspace: WorkspaceInfo) {
  if (workspace.workspaceType !== "local" || workspace.sandboxBackend) {
    throw new ApiError(400, "goal_workspace_unsupported", "Goals are only available in local workspaces");
  }
}

export function registerGoalRoutes(options: RegisterGoalRoutesOptions) {
  const { routes, config, goals, jsonResponse, readJsonBody, ensureWritable, requireClientScope, resolveWorkspace } = options;

  async function resolveScope(ctx: RequestContext, write: boolean) {
    if (write) ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = parseId(ctx.params.sessionId, "sessionId");
    return { workspace, sessionId };
  }

  function owned(goalId: string, workspace: WorkspaceInfo, sessionId: string): SessionGoal {
    const goal = goals.get(goalId);
    if (!goal || goal.workspaceId !== workspace.id || goal.sessionId !== sessionId) {
      throw new ApiError(404, "goal_not_found", "Goal not found");
    }
    return goal;
  }

  /**
   * Reserve a goal run and dispatch it through the ordinary session start
   * path so generation fencing and busy checks still apply. A failed
   * dispatch releases the reservation instead of leaving the goal queued.
   */
  async function dispatchGoalRun(
    ctx: RequestContext,
    goal: SessionGoal,
    trigger: GoalRunTrigger,
    run: z.infer<typeof runOptions> | undefined,
    expectedVersion?: number,
  ) {
    const reserved = (() => {
      try { return goals.reserveRun(goal.id, { trigger, expectedVersion }); } catch (error) { remapGoalError(error); }
    })();
    const reservedGoal = reserved.goal;
    const prompt: Record<string, unknown> = {
      parts: [{ type: "text", text: goalRunPromptText(reservedGoal, trigger) }],
      system: buildGoalEnvelope(reservedGoal, { ordinal: reserved.run.ordinal, trigger }),
      ...(run?.model ? { model: run.model } : {}),
      ...(run?.variant ? { variant: run.variant } : {}),
    };
    let response: Response;
    try {
      response = await options.startSessionRun(ctx, {
        sessionId: goal.sessionId,
        origin: "local-renderer",
        startCommandCorrelationId: reserved.run.idempotencyKey,
        prompt,
      });
    } catch (error) {
      goals.markRunFailed(goal.id, reserved.run.ordinal, error instanceof ApiError ? error.code : "dispatch_failed");
      throw error;
    }
    const body = await response.clone().json().catch(() => null) as { run?: { runId?: string } } | null;
    const runId = body?.run?.runId;
    const updated = runId
      ? goals.markRunStarted(goal.id, reserved.run.ordinal, runId)
      : goals.markRunFailed(goal.id, reserved.run.ordinal, "run_identity_missing");
    return { goal: updated ?? reservedGoal, run: { ordinal: reserved.run.ordinal, runId: runId ?? null } };
  }

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/goal", "client", async (ctx) => {
    const { workspace, sessionId } = await resolveScope(ctx, false);
    return jsonResponse({ item: goals.current(workspace.id, sessionId) });
  });

  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/goal", "client", async (ctx) => {
    const { workspace, sessionId } = await resolveScope(ctx, true);
    assertGoalWorkspace(workspace);
    const body = parse(createBody, await readJsonBody(ctx.request));
    let goal: SessionGoal;
    try {
      goal = goals.create({ workspaceId: workspace.id, sessionId, objective: body.objective, criteria: body.criteria });
    } catch (error) {
      remapGoalError(error);
    }
    if (body.start === false) return jsonResponse({ item: goal, run: null }, 201);
    try {
      const started = await dispatchGoalRun(ctx, goal, "create", body.run);
      return jsonResponse({ item: started.goal, run: started.run }, 201);
    } catch (error) {
      // The goal exists even if the session was busy; the user can continue it.
      const current = goals.get(goal.id) ?? goal;
      const code = error instanceof ApiError ? error.code : "dispatch_failed";
      return jsonResponse({ item: current, run: null, startError: { code } }, 201);
    }
  });

  addRoute(routes, "PATCH", "/workspace/:id/sessions/:sessionId/goal/:goalId", "client", async (ctx) => {
    const { workspace, sessionId } = await resolveScope(ctx, true);
    const goal = owned(parseId(ctx.params.goalId, "goalId"), workspace, sessionId);
    const body = parse(editBody, await readJsonBody(ctx.request));
    try {
      return jsonResponse({ item: goals.edit(goal.id, body.expectedVersion, body) });
    } catch (error) {
      remapGoalError(error);
    }
  });

  for (const action of ["pause", "resume", "cancel"] as const) {
    addRoute(routes, "POST", `/workspace/:id/sessions/:sessionId/goal/:goalId/${action}`, "client", async (ctx) => {
      const { workspace, sessionId } = await resolveScope(ctx, true);
      const goal = owned(parseId(ctx.params.goalId, "goalId"), workspace, sessionId);
      const body = parse(versionBody, await readJsonBody(ctx.request));
      try {
        return jsonResponse({ item: goals[action](goal.id, body.expectedVersion) });
      } catch (error) {
        remapGoalError(error);
      }
    });
  }

  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/goal/:goalId/complete", "client", async (ctx) => {
    const { workspace, sessionId } = await resolveScope(ctx, true);
    const goal = owned(parseId(ctx.params.goalId, "goalId"), workspace, sessionId);
    const body = parse(completeBody, await readJsonBody(ctx.request));
    try {
      return jsonResponse({ item: goals.complete(goal.id, body.expectedVersion, { override: body.override ?? false }) });
    } catch (error) {
      remapGoalError(error);
    }
  });

  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/goal/:goalId/continue", "client", async (ctx) => {
    const { workspace, sessionId } = await resolveScope(ctx, true);
    assertGoalWorkspace(workspace);
    const goal = owned(parseId(ctx.params.goalId, "goalId"), workspace, sessionId);
    const body = parse(continueBody, await readJsonBody(ctx.request));
    const started = await dispatchGoalRun(ctx, goal, "user_continue", body.run, body.expectedVersion);
    return jsonResponse({ item: started.goal, run: started.run }, 202);
  });

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/goal/:goalId/runs", "client", async (ctx) => {
    const { workspace, sessionId } = await resolveScope(ctx, false);
    const goal = owned(parseId(ctx.params.goalId, "goalId"), workspace, sessionId);
    return jsonResponse({ items: goals.runs(goal.id), events: goals.events(goal.id) });
  });
}
