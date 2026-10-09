import { ApiError } from "../errors.js";

export type GithubReviewIdentity = {
  version: 1;
  provider: "github";
  connectionId: string;
  hostname: string;
  owner: string;
  repository: string;
  number: number;
};

function validPart(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value);
}

export function encodeReviewId(identity: GithubReviewIdentity): string {
  return `review_${Buffer.from(JSON.stringify(identity), "utf8").toString("base64url")}`;
}

export function decodeReviewId(value: string): GithubReviewIdentity {
  if (!value.startsWith("review_") || value.length > 2_048) throw new ApiError(404, "github_review_not_found", "Pull request not found.", { retryable: false });
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value.slice(7), "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    const identity = parsed as Partial<GithubReviewIdentity>;
    if (identity.version !== 1 || identity.provider !== "github" || !validPart(identity.connectionId, 256) || !validPart(identity.hostname) || !validPart(identity.owner, 256) || !validPart(identity.repository, 256) || !Number.isInteger(identity.number) || Number(identity.number) <= 0) throw new Error("invalid");
    return identity as GithubReviewIdentity;
  } catch {
    throw new ApiError(404, "github_review_not_found", "Pull request not found.", { retryable: false });
  }
}
