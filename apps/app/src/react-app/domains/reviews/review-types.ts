export type ReviewProvider = "github" | "gitlab";

export type ReviewRelationship = "requested" | "authored" | "team" | "reviewed" | "recently_merged";

export type ReviewCheckState = "success" | "failure" | "running" | "queued" | "unknown";

export type ReviewFile = {
  path: string;
  additions: number;
  deletions: number;
  language: string;
  patch: Array<{ kind: "context" | "addition" | "deletion" | "meta"; oldLine?: number; newLine?: number; text: string }>;
};

export type ReviewCheck = {
  id: string;
  name: string;
  detail: string;
  state: ReviewCheckState;
  duration?: string;
};

export type ReviewThread = {
  id: string;
  author: string;
  authorLogin?: string;
  authorAvatarUrl?: string;
  initials: string;
  body: string;
  path?: string;
  line?: number;
  age: string;
  resolved?: boolean;
  comments?: Array<{ id: string; author: string; authorLogin?: string; avatarUrl?: string; body: string; age: string; url?: string }>;
  reviewDecision?: "approved" | "changes_requested";
};

export type ReviewReviewer = {
  login: string;
  displayName?: string;
  avatarUrl?: string;
};

export type ReviewPreview = {
  id: string;
  provider: ReviewProvider;
  hostname: string;
  owner: string;
  repository: string;
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  title: string;
  body: string;
  author: string;
  authorInitials: string;
  authorAvatarUrl?: string;
  reviewers: ReviewReviewer[];
  relationship: ReviewRelationship;
  updatedAt: string;
  baseBranch: string;
  headBranch: string;
  headRevision: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  comments: number;
  draft?: boolean;
  mergeable: "mergeable" | "conflicting" | "unknown";
  viewerPermission: "read" | "triage" | "write" | "maintain" | "admin" | "unknown";
  pinned?: boolean;
  labels: string[];
  summary: string[];
  files: ReviewFile[];
  checks: ReviewCheck[];
  threads: ReviewThread[];
};

export type ReviewDetailTab = "summary" | "changes" | "checks" | "threads";
