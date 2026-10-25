import { expect, test } from "bun:test";
import type { ReviewDetail } from "@jugglework/types/reviews";
import { reviewViewModel } from "../src/react-app/domains/reviews/review-view-model";

test("maps pull request reactions from the detail response", () => {
  const item: ReviewDetail["item"] = {
    id: "review", provider: "github", hostname: "github.com", repository: { id: "team/repo", owner: "team", name: "repo", fullName: "team/repo" },
    number: 1, title: "Review", url: "https://github.com/team/repo/pull/1", author: { login: "author" }, state: "open", draft: false,
    relationships: ["review_requested"], reviewDecision: "none", headRevision: "a".repeat(40), updatedAt: new Date().toISOString(), labels: [],
    body: "", baseBranch: "main", headBranch: "feature", mergeable: "unknown", viewerPermission: "unknown",
    reactions: [{ content: "+1", count: 2 }, { content: "eyes", count: 1 }],
  };
  const detail: ReviewDetail = { schemaVersion: 1, item, cache: { source: "provider", fetchedAt: new Date().toISOString(), stale: false } };
  expect(reviewViewModel({ item, detail }).reactions).toEqual([{ content: "+1", count: 2 }, { content: "eyes", count: 1 }]);
});
