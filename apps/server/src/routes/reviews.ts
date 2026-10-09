import { reviewRelationshipSchema } from "@jugglework/types/reviews";
import { ApiError } from "../errors.js";
import type { ReviewReadService } from "../reviews/service.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { addRoute, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;

export interface RegisterReviewRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  service: Pick<ReviewReadService, "getConnection" | "listInbox" | "getDetail" | "listFiles" | "getChecks" | "listThreads">;
  jsonResponse: JsonResponse;
  resolveWorkspaceForInspection: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}

function positiveInteger(value: string | null, fallback: number): number {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new ApiError(400, "invalid_request", "limit must be an integer from 1 to 100.", { retryable: false });
  return parsed;
}

export function registerReviewRoutes(options: RegisterReviewRoutesOptions): void {
  const { routes, config, service, jsonResponse, resolveWorkspaceForInspection } = options;

  addRoute(routes, "GET", "/workspace/:id/reviews/connection", "client", async (ctx) => {
    const workspace = await resolveWorkspaceForInspection(config, ctx.params.id);
    return jsonResponse(await service.getConnection({ workspace, signal: ctx.request.signal }));
  });

  addRoute(routes, "GET", "/workspace/:id/reviews", "client", async (ctx) => {
    const workspace = await resolveWorkspaceForInspection(config, ctx.params.id);
    const relationship = reviewRelationshipSchema.safeParse(ctx.url.searchParams.get("relationship") ?? "review_requested");
    if (!relationship.success) throw new ApiError(400, "invalid_request", "Unknown review relationship.", { retryable: false });
    return jsonResponse(await service.listInbox({ workspace, signal: ctx.request.signal, relationship: relationship.data, query: ctx.url.searchParams.get("query") ?? undefined, cursor: ctx.url.searchParams.get("cursor") ?? undefined, limit: positiveInteger(ctx.url.searchParams.get("limit"), 30) }));
  });

  addRoute(routes, "GET", "/workspace/:id/reviews/:reviewId/files", "client", async (ctx) => {
    const workspace = await resolveWorkspaceForInspection(config, ctx.params.id);
    return jsonResponse(await service.listFiles({ workspace, signal: ctx.request.signal, reviewId: ctx.params.reviewId, cursor: ctx.url.searchParams.get("cursor") ?? undefined, limit: positiveInteger(ctx.url.searchParams.get("limit"), 30) }));
  });

  addRoute(routes, "GET", "/workspace/:id/reviews/:reviewId/checks", "client", async (ctx) => {
    const workspace = await resolveWorkspaceForInspection(config, ctx.params.id);
    return jsonResponse(await service.getChecks({ workspace, signal: ctx.request.signal, reviewId: ctx.params.reviewId }));
  });

  addRoute(routes, "GET", "/workspace/:id/reviews/:reviewId/threads", "client", async (ctx) => {
    const workspace = await resolveWorkspaceForInspection(config, ctx.params.id);
    return jsonResponse(await service.listThreads({ workspace, signal: ctx.request.signal, reviewId: ctx.params.reviewId, cursor: ctx.url.searchParams.get("cursor") ?? undefined, limit: positiveInteger(ctx.url.searchParams.get("limit"), 30) }));
  });

  addRoute(routes, "GET", "/workspace/:id/reviews/:reviewId", "client", async (ctx) => {
    const workspace = await resolveWorkspaceForInspection(config, ctx.params.id);
    return jsonResponse(await service.getDetail({ workspace, signal: ctx.request.signal, reviewId: ctx.params.reviewId }));
  });
}
