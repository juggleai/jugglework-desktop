import {
  useInfiniteQuery,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  ReviewChecksResponse,
  ReviewConnectionStatus,
  ReviewDetail,
  ReviewFilesResponse,
  ReviewListResponse,
  ReviewRelationship,
  ReviewThreadsResponse,
} from "@jugglework/types/reviews";

import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";

function endpointKey(endpoint: ResolvedWorkspaceEndpoint | null) {
  return endpoint ? [endpoint.baseUrl, endpoint.workspaceId] as const : ["unavailable", ""] as const;
}

export const reviewQueryKeys = {
  connection: (endpoint: ResolvedWorkspaceEndpoint | null) => ["reviews", ...endpointKey(endpoint), "connection"] as const,
  inbox: (endpoint: ResolvedWorkspaceEndpoint | null, relationship: ReviewRelationship, query: string) => ["reviews", ...endpointKey(endpoint), "inbox", relationship, query] as const,
  detail: (endpoint: ResolvedWorkspaceEndpoint | null, reviewId: string | null) => ["reviews", ...endpointKey(endpoint), "detail", reviewId] as const,
  files: (endpoint: ResolvedWorkspaceEndpoint | null, reviewId: string | null) => ["reviews", ...endpointKey(endpoint), "files", reviewId] as const,
  checks: (endpoint: ResolvedWorkspaceEndpoint | null, reviewId: string | null) => ["reviews", ...endpointKey(endpoint), "checks", reviewId] as const,
  threads: (endpoint: ResolvedWorkspaceEndpoint | null, reviewId: string | null) => ["reviews", ...endpointKey(endpoint), "threads", reviewId] as const,
};

export function reviewVisiblePollInterval(active: boolean, intervalMs: number): number | false {
  return active ? intervalMs : false;
}

export function reviewChecksPollInterval(active: boolean, data: ReviewChecksResponse | undefined): number | false {
  return active && data?.items.some((check) => check.state === "queued" || check.state === "running") ? 10_000 : false;
}

export function useReviewConnection(endpoint: ResolvedWorkspaceEndpoint | null, active: boolean): UseQueryResult<ReviewConnectionStatus> {
  return useQuery({
    queryKey: reviewQueryKeys.connection(endpoint),
    enabled: active && Boolean(endpoint),
    queryFn: ({ signal }) => endpoint!.client.getReviewConnection(endpoint!.workspaceId, { signal }),
    staleTime: 30_000,
    refetchInterval: reviewVisiblePollInterval(active, 60_000),
    refetchOnWindowFocus: true,
  });
}

export function useReviewInbox(endpoint: ResolvedWorkspaceEndpoint | null, input: { active: boolean; ready: boolean; relationship: ReviewRelationship; query: string }) {
  return useInfiniteQuery({
    queryKey: reviewQueryKeys.inbox(endpoint, input.relationship, input.query),
    enabled: input.active && input.ready && Boolean(endpoint),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => endpoint!.client.listReviews(endpoint!.workspaceId, { relationship: input.relationship, query: input.query, cursor: pageParam, limit: 30 }, { signal }),
    getNextPageParam: (page: ReviewListResponse) => page.nextCursor ?? undefined,
    staleTime: 30_000,
    refetchInterval: reviewVisiblePollInterval(input.active, 60_000),
    refetchOnWindowFocus: true,
  });
}

export function useReviewDetail(endpoint: ResolvedWorkspaceEndpoint | null, reviewId: string | null, active: boolean): UseQueryResult<ReviewDetail> {
  return useQuery({ queryKey: reviewQueryKeys.detail(endpoint, reviewId), enabled: active && Boolean(endpoint && reviewId), queryFn: ({ signal }) => endpoint!.client.getReview(endpoint!.workspaceId, reviewId!, { signal }), staleTime: 20_000 });
}

export function useReviewFiles(endpoint: ResolvedWorkspaceEndpoint | null, reviewId: string | null, active: boolean): UseQueryResult<ReviewFilesResponse> {
  return useQuery({ queryKey: reviewQueryKeys.files(endpoint, reviewId), enabled: active && Boolean(endpoint && reviewId), queryFn: ({ signal }) => endpoint!.client.listReviewFiles(endpoint!.workspaceId, reviewId!, { limit: 100 }, { signal }), staleTime: 60_000 });
}

export function useReviewChecks(endpoint: ResolvedWorkspaceEndpoint | null, reviewId: string | null, active: boolean): UseQueryResult<ReviewChecksResponse> {
  return useQuery({ queryKey: reviewQueryKeys.checks(endpoint, reviewId), enabled: active && Boolean(endpoint && reviewId), queryFn: ({ signal }) => endpoint!.client.getReviewChecks(endpoint!.workspaceId, reviewId!, { signal }), staleTime: 10_000, refetchInterval: (query) => reviewChecksPollInterval(active, query.state.data) });
}

export function useReviewThreads(endpoint: ResolvedWorkspaceEndpoint | null, reviewId: string | null, active: boolean): UseQueryResult<ReviewThreadsResponse> {
  return useQuery({ queryKey: reviewQueryKeys.threads(endpoint, reviewId), enabled: active && Boolean(endpoint && reviewId), queryFn: ({ signal }) => endpoint!.client.listReviewThreads(endpoint!.workspaceId, reviewId!, { limit: 50 }, { signal }), staleTime: 30_000 });
}
