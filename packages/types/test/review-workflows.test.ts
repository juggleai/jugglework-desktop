import { expect, test } from "bun:test";
import { reviewMutationInputSchema, reviewPullRequestActionInputSchema, reviewFixInputSchema, reviewRelationshipSchema, reviewRunSchema } from "../src/reviews";

test("review inbox relationships include recently merged pull requests", () => {
  expect(reviewRelationshipSchema.safeParse("recently_merged").success).toBe(true);
});

test("publishing requires an explicit supported decision and meaningful comment content", () => {
  const input = { requestId: crypto.randomUUID(), expectedHeadRevision: "a".repeat(40), kind: "review", event: "APPROVE", body: "" };
  expect(reviewMutationInputSchema.safeParse(input).success).toBe(true);
  for (const changed of [
    { ...input, event: "MERGE" },
    { ...input, event: undefined },
    { ...input, event: "REQUEST_CHANGES" },
    { ...input, event: "COMMENT", body: "   " },
    { ...input, kind: "comment", event: undefined },
    { ...input, expectedHeadRevision: "unknown" },
    { ...input, capability: "arbitrary_tool" },
  ]) expect(reviewMutationInputSchema.safeParse(changed).success).toBe(false);
});

test("GitHub reactions require a fixed reaction and a matching target", () => {
  const common = { requestId: crypto.randomUUID(), expectedHeadRevision: "a".repeat(40), kind: "reaction" as const };
  expect(reviewMutationInputSchema.safeParse({ ...common, body: "+1", reactionTarget: "pull_request" }).success).toBe(true);
  expect(reviewMutationInputSchema.safeParse({ ...common, body: "eyes", reactionTarget: "issue_comment", commentId: "123" }).success).toBe(true);
  expect(reviewMutationInputSchema.safeParse({ ...common, body: "rocket", reactionTarget: "pull_request_review_comment", commentId: "456" }).success).toBe(true);
  for (const invalid of [
    { ...common, body: "🔥", reactionTarget: "pull_request" },
    { ...common, body: "+1", reactionTarget: "issue_comment" },
    { ...common, body: "+1", reactionTarget: "pull_request", commentId: "123" },
    { ...common, body: "+1", reactionTarget: "issue_comment", commentId: "not-a-number" },
  ]) expect(reviewMutationInputSchema.safeParse(invalid).success).toBe(false);
});

test("fixes accept finding identities, not renderer-supplied prompts", () => {
  const input = { runId: crypto.randomUUID(), findingIds: ["finding-1"], expectedHeadRevision: "b".repeat(40) };
  expect(reviewFixInputSchema.safeParse(input).success).toBe(true);
  expect(reviewFixInputSchema.safeParse({ ...input, findingIds: [] }).success).toBe(false);
  expect(reviewFixInputSchema.safeParse({ ...input, prompt: "write unrelated code" }).success).toBe(false);
});

test("pull request actions use a fixed allowlist and revision guard", () => {
  const input = { requestId: crypto.randomUUID(), expectedHeadRevision: "c".repeat(40), action: "merge", mergeMethod: "squash" };
  expect(reviewPullRequestActionInputSchema.safeParse(input).success).toBe(true);
  expect(reviewPullRequestActionInputSchema.safeParse({ ...input, action: "delete_repository" }).success).toBe(false);
  expect(reviewPullRequestActionInputSchema.safeParse({ ...input, action: "close", mergeMethod: "squash" }).success).toBe(false);
  expect(reviewPullRequestActionInputSchema.safeParse({ ...input, capability: "arbitrary_tool" }).success).toBe(false);
});

test("review runs retain bounded revision-scoped history without nested histories", () => {
  const snapshot = { id: crypto.randomUUID(), headRevision: "a".repeat(40), status: "completed", createdAt: new Date().toISOString(), partial: false, sessionId: "review-session", fixTasks: [{ sessionId: "fix", findingIds: ["finding-1"], createdAt: new Date().toISOString() }] };
  expect(reviewRunSchema.safeParse({ ...snapshot, reviewId: "review", history: [snapshot] }).success).toBe(true);
  expect(reviewRunSchema.safeParse({ ...snapshot, reviewId: "review", history: [{ ...snapshot, history: [] }] }).success).toBe(false);
});
