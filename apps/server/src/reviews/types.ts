import type {
  ReviewChecksResponse,
  ReviewConnectionStatus,
  ReviewDetail,
  ReviewFilesResponse,
  ReviewListResponse,
  ReviewRelationship,
  ReviewThreadsResponse,
  ReviewMutationInput,
  ReviewPullRequestActionInput,
} from "@jugglework/types/reviews";
import type { WorkspaceInfo } from "../types.js";

export type ReviewRequestContext = {
  workspace: WorkspaceInfo;
  signal?: AbortSignal;
};

export type ReviewInboxInput = ReviewRequestContext & {
  relationship: ReviewRelationship;
  query?: string;
  cursor?: string;
  limit: number;
};

export type ReviewTargetInput = ReviewRequestContext & {
  reviewId: string;
};

export interface ReviewReadProvider {
  getConnection(input: ReviewRequestContext): Promise<ReviewConnectionStatus>;
  listInbox(input: ReviewInboxInput): Promise<ReviewListResponse>;
  getDetail(input: ReviewTargetInput): Promise<ReviewDetail>;
  listFiles(input: ReviewTargetInput & { cursor?: string; limit: number }): Promise<ReviewFilesResponse>;
  getChecks(input: ReviewTargetInput): Promise<ReviewChecksResponse>;
  listThreads(input: ReviewTargetInput & { cursor?: string; limit: number }): Promise<ReviewThreadsResponse>;
  mutate?(input: ReviewTargetInput & ReviewMutationInput): Promise<{ ok: true }>;
  mutatePullRequest?(input: ReviewTargetInput & ReviewPullRequestActionInput): Promise<{ ok: true }>;
  executionScope?(input: ReviewRequestContext): Promise<string>;
  freshDetail?(input: ReviewTargetInput): Promise<ReviewDetail>;
  resolveUrl?(input: ReviewRequestContext & { url: string }): Promise<ReviewDetail>;
  dispose?(): void | Promise<void>;
}
