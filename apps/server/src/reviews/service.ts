import { ApiError } from "../errors.js";
import type { ReviewReadProvider } from "./types.js";

function limit(value: number | undefined, fallback = 30): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new ApiError(400, "invalid_request", "limit must be an integer from 1 to 100.", { retryable: false });
  return value;
}

function bounded(value: string | undefined, max: number, name: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (value.length > max) throw new ApiError(400, "invalid_request", `${name} is too long.`, { retryable: false });
  return value;
}

export class ReviewReadService {
  constructor(private readonly provider: ReviewReadProvider) {}

  getConnection(input: Parameters<ReviewReadProvider["getConnection"]>[0]) {
    return this.provider.getConnection(input);
  }

  listInbox(input: Parameters<ReviewReadProvider["listInbox"]>[0]) {
    return this.provider.listInbox({ ...input, query: bounded(input.query, 256, "query"), cursor: bounded(input.cursor, 4_096, "cursor"), limit: limit(input.limit) });
  }

  getDetail(input: Parameters<ReviewReadProvider["getDetail"]>[0]) {
    return this.provider.getDetail({ ...input, reviewId: bounded(input.reviewId, 2_048, "reviewId")! });
  }

  listFiles(input: Parameters<ReviewReadProvider["listFiles"]>[0]) {
    return this.provider.listFiles({ ...input, reviewId: bounded(input.reviewId, 2_048, "reviewId")!, cursor: bounded(input.cursor, 4_096, "cursor"), limit: limit(input.limit) });
  }

  getChecks(input: Parameters<ReviewReadProvider["getChecks"]>[0]) {
    return this.provider.getChecks({ ...input, reviewId: bounded(input.reviewId, 2_048, "reviewId")! });
  }

  listThreads(input: Parameters<ReviewReadProvider["listThreads"]>[0]) {
    return this.provider.listThreads({ ...input, reviewId: bounded(input.reviewId, 2_048, "reviewId")!, cursor: bounded(input.cursor, 4_096, "cursor"), limit: limit(input.limit) });
  }

  async dispose(): Promise<void> {
    await this.provider.dispose?.();
  }
}
