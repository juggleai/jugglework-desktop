import type {
  ReviewChecksResponse,
  ReviewDetail,
  ReviewFilesResponse,
  ReviewListItem,
  ReviewThread as WireThread,
  ReviewThreadsResponse,
} from "@jugglework/types/reviews";

import type { ReviewPreview, ReviewRelationship, ReviewThread } from "./review-types";

function initials(login: string) {
  return login.split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "GH";
}

function age(value: string) {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function relationship(item: ReviewListItem): ReviewRelationship {
  if (item.relationships.includes("authored")) return "authored";
  if (item.relationships.includes("team_review_requested")) return "team";
  if (item.relationships.includes("reviewed")) return "reviewed";
  return "requested";
}

function thread(value: WireThread): ReviewThread {
  const first = value.comments[0];
  return {
    id: value.id,
    author: first?.author.displayName ?? first?.author.login ?? "GitHub",
    initials: initials(first?.author.login ?? "GH"),
    body: first?.body ?? "",
    path: value.path,
    line: value.line,
    age: first ? age(first.createdAt) : "",
    resolved: value.resolved,
  };
}

export function reviewViewModel(input: {
  item: ReviewListItem;
  detail?: ReviewDetail;
  files?: ReviewFilesResponse;
  checks?: ReviewChecksResponse;
  threads?: ReviewThreadsResponse;
}): ReviewPreview {
  const item = input.detail?.item ?? input.item;
  return {
    id: item.id,
    provider: "github",
    hostname: item.hostname,
    owner: item.repository.owner,
    repository: item.repository.name,
    number: item.number,
    title: item.title,
    body: input.detail?.item.body ?? "",
    author: item.author.displayName ?? item.author.login,
    authorInitials: initials(item.author.login),
    relationship: relationship(item),
    updatedAt: age(item.updatedAt),
    baseBranch: input.detail?.item.baseBranch ?? "",
    headBranch: input.detail?.item.headBranch ?? "",
    headRevision: item.headRevision,
    additions: item.additions ?? 0,
    deletions: item.deletions ?? 0,
    changedFiles: item.changedFiles ?? 0,
    comments: item.commentCount ?? 0,
    draft: item.draft,
    labels: item.labels.map((label) => label.name),
    summary: input.detail ? [input.detail.item.body || "No pull request description was provided."] : [],
    files: (input.files?.items ?? []).map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions, language: "", patch: file.patch ?? [] })),
    checks: (input.checks?.items ?? []).map((check) => ({ id: check.id, name: check.name, detail: check.detail ?? "", state: check.state === "cancelled" ? "failure" : check.state, duration: undefined })),
    threads: (input.threads?.items ?? []).map(thread),
  };
}
