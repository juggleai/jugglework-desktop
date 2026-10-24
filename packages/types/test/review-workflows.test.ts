import { expect, test } from "bun:test";
import { reviewMutationInputSchema, reviewPullRequestActionInputSchema, reviewFixInputSchema, reviewRelationshipSchema } from "../src/reviews";

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
