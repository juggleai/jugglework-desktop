import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PlatformProvider, type Platform } from "../src/react-app/kernel/platform";
import type { ResolvedWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";

import { REVIEW_PREVIEWS, reviewPreviewById } from "../src/react-app/domains/reviews/review-preview-data";

const memoryStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
  key: () => null,
  length: 0,
};

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage });
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: memoryStorage });

const { ConnectedState, ReviewWorkbench, reviewMatches } = await import("../src/react-app/domains/reviews/review-page");

const noop = () => undefined;

function renderWorkbench(
  reviewId: string | null,
  sidebarOpen = true,
  options?: {
    viewMode?: "compact" | "detailed";
    visibleSections?: Array<"authored" | "requested" | "team" | "recently_merged">;
    pinnedReviews?: typeof REVIEW_PREVIEWS;
    tab?: "summary" | "changes" | "checks" | "threads";
    requestReviewers?: boolean;
  },
) {
  const review = reviewPreviewById(reviewId);
  const platform: Platform = { platform: "desktop", openLink: noop, restart: async () => undefined, notify: async () => undefined };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const endpoint = { baseUrl: "http://127.0.0.1:1234", workspaceId: "ws", client: {} } as ResolvedWorkspaceEndpoint;
  const sections = ["authored", "requested", "team", "recently_merged"].map((relationship) => ({
    relationship,
    reviews: REVIEW_PREVIEWS.filter((item) => relationship === "recently_merged" ? item.state === "merged" : item.relationship === relationship),
  }));
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}><PlatformProvider value={platform}><ReviewWorkbench
      endpoint={review ? endpoint : undefined}
      operations={review ? { comment: true, submitReview: true, requestReviewers: options?.requestReviewers ?? true, markDraft: true, markReady: true, close: true, reopen: true, edit: true, merge: true, enableAutoMerge: true } : undefined}
      viewerLogin="octocat"
      viewerAvatarUrl="https://avatars.githubusercontent.com/u/583231?v=4"
      isOwnPullRequest={review?.relationship === "authored"}
      pinned={Boolean(review?.pinned)}
      onTogglePin={noop}
      onChanged={noop}
      actions={review ? <><button>Review with JuggleWork</button><button>Submit review</button></> : undefined}
      sections={sections as Parameters<typeof ReviewWorkbench>[0]["sections"]}
      expandedSections={["pinned", "authored", "requested", "team", "recently_merged"]}
      pinnedReviews={options?.pinnedReviews}
      viewMode={options?.viewMode}
      visibleSections={options?.visibleSections}
      reviewId={reviewId}
      query=""
      review={review}
      unknown={reviewId !== null && review === null}
      tab={options?.tab}
      onQueryChange={noop}
      onToggleSection={noop}
      onSelectReview={noop}
      sidebarOpen={sidebarOpen}
    /></PlatformProvider></QueryClientProvider>,
  );
}

describe("Review workbench preview", () => {
  test("renders an explicit preview Inbox and responsive empty detail", () => {
    const html = renderWorkbench(null);

    expect(html).toContain("Code Review");
    expect(html).toContain("Pull request inbox");
    expect(html).toContain("My pull requests");
    expect(html).toContain("Review requests");
    expect(html).toContain("My team&#x27;s review requests");
    expect(html).toContain("Recently merged");
    expect(html).not.toContain('aria-label="Review relationship"');
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(4);
    expect(html).toContain("Select a pull request");
    expect(html).toContain("md:w-[var(--jugglework-left-sidebar-width)]");
    expect(html.match(/data-testid="review-inbox-item-/g)).toHaveLength(REVIEW_PREVIEWS.filter((item) => item.relationship !== "reviewed").length);
  });

  test("hides the Inbox when the shared secondary sidebar is collapsed", () => {
    const html = renderWorkbench(null, false);

    expect(html).not.toContain("Pull request inbox");
    expect(html).toContain("Select a pull request");
  });

  test("supports compact rows and independently hidden Inbox sections", () => {
    const html = renderWorkbench(null, true, {
      viewMode: "compact",
      visibleSections: ["authored", "recently_merged"],
    });

    expect(html).toContain("Review view options");
    expect(html).toContain("My pull requests");
    expect(html).toContain("Recently merged");
    expect(html).not.toContain("Review requests");
    expect(html).not.toContain("My team&#x27;s review requests");
    expect(html).toContain("truncate text-[13px] leading-6");
    expect(html).not.toContain("Open pull request URL");
  });

  test("shows pinned pull requests above authored and hides the section when empty", () => {
    const empty = renderWorkbench(null);
    const pinned = renderWorkbench(null, true, { pinnedReviews: [REVIEW_PREVIEWS[0]] });

    expect(empty).not.toContain('id="review-section-pinned"');
    expect(pinned).toContain('id="review-section-pinned"');
    expect(pinned.indexOf('id="review-section-pinned"')).toBeLessThan(pinned.indexOf('id="review-section-authored"'));
  });

  test("renders summary and deferred external operations for a selected pull request", () => {
    const selected = REVIEW_PREVIEWS[0];
    const html = renderWorkbench(selected.id);

    expect(html).toContain(selected.title);
    expect(html).toContain(selected.body);
    expect(html).toContain("Changes");
    expect(html).toContain("1 comment");
    expect(html).toContain("Reviewers");
    expect(html).toContain("Checks");
    expect(html).toContain("Review with JuggleWork");
    expect(html).toContain("Submit review");
    expect(html).toContain("Unpin from sidebar");
    expect(html).toContain("Copy URL");
    expect(html).toContain("Open in GitHub");
    expect(html).toContain("Merge");
    expect(html).toContain("disabled");
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab" aria-selected="true"');
    expect(html).toContain("Activity");
    expect(html).toContain("Leave a comment");
    expect(html).toContain("Latest commit on");
    expect(html).toContain("Request a reviewer");
    expect(html).toContain("Add emoji response");
    expect(html).toContain('aria-label="+1 2"');
    expect(html).toContain('aria-label="heart 1"');
    expect(html).toContain('aria-label="eyes 1"');
    expect(html).toContain("Comment actions");
    expect(html).toContain("https://avatars.githubusercontent.com/u/583231?v=4");
    expect(html).not.toContain("Code review");
  });

  test("shows the changes switcher and selectable file list after opening changes", () => {
    const selected = REVIEW_PREVIEWS[0];
    const html = renderWorkbench(selected.id, true, { tab: "changes" });

    expect(html).toContain('role="tablist"');
    expect(html).toContain("Summary");
    expect(html).toContain("Filter files");
    expect(html).toContain(selected.files[0].path);
    expect(html).toContain("More changes actions");
    expect(html).toContain("Diff display options");
    expect(html).toContain("Hide file search");
    expect(html).toContain("Use split diff");
    expect(html).toContain("Hide file tree");
  });

  test("offers description editing for the current user's pull request", () => {
    const authored = REVIEW_PREVIEWS.find((item) => item.relationship === "authored")!;
    const html = renderWorkbench(authored.id);

    expect(html).toContain("Edit");
    expect(html).toContain("Quick reaction");
    expect(html).toContain("No comments");
  });

  test("keeps the reviewer picker reachable when capability discovery is incomplete", () => {
    const selected = REVIEW_PREVIEWS[0];
    const html = renderWorkbench(selected.id, true, { requestReviewers: false });
    const labelIndex = html.indexOf('aria-label="Request a reviewer"');
    const buttonStart = html.lastIndexOf("<button", labelIndex);
    const buttonEnd = html.indexOf(">", labelIndex);

    expect(labelIndex).toBeGreaterThan(-1);
    expect(/\sdisabled(?:=|\s|>)/.test(html.slice(buttonStart, buttonEnd))).toBe(false);
  });

  test("renders a recoverable state for an unknown opaque review ID", () => {
    const html = renderWorkbench("unknown-review");

    expect(html).toContain('data-testid="review-not-found"');
    expect(html).toContain("Pull request not found");
    expect(html).toContain("Return to Inbox");
  });

  test("filters by relationship and searchable pull request fields", () => {
    const requested = REVIEW_PREVIEWS[0];

    expect(reviewMatches(requested, "revision-safe", "all")).toBe(true);
    expect(reviewMatches(requested, "#1842", "all")).toBe(true);
    expect(reviewMatches(requested, "security", "all")).toBe(false);
    expect(reviewMatches(requested, "", "requested")).toBe(true);
    expect(reviewMatches(requested, "", "authored")).toBe(false);
  });

  test("renders an actionable member GitHub authorization state without fixture data", () => {
    const html = renderToStaticMarkup(
      <ConnectedState
        connection={{ schemaVersion: 1, provider: "github", state: "member_authorization_required", hint: "Connect your account." }}
        onConnect={noop}
        onRetry={noop}
      />,
    );
    expect(html).toContain("Your organization provides GitHub");
    expect(html).toContain("Open Connect settings");
    expect(html).toContain('data-testid="review-github-setup"');
    expect(html).not.toContain("Review me");
  });

  test("missing GitHub asks an organization administrator to add the connection", () => {
    const html = renderToStaticMarkup(
      <ConnectedState connection={{ schemaVersion: 1, provider: "github", state: "not_connected" }} onConnect={noop} />,
    );
    expect(html).toContain("Code review");
    expect(html).toContain("only uses GitHub connections provided by your organization");
    expect(html).toContain("Ask an organization administrator to add and configure GitHub");
    expect(html).toContain("Open Connect settings");
    expect(html.match(/<button\b/g)).toHaveLength(1);
    expect(html).not.toContain("GitLab");
    expect(html).not.toContain("Pull request inbox");
    expect(html).not.toContain("Retry");
  });

  test("administrator setup stays actionable without presenting member authorization as sufficient", () => {
    for (const state of ["organization_admin_action_required", "provider_admin_action_required"] as const) {
      const html = renderToStaticMarkup(<ConnectedState connection={{ schemaVersion: 1, provider: "github", state }} onConnect={noop} />);
      expect(html).toContain("Open Connect settings");
      expect(html).toContain("Ask an organization administrator");
    }
  });

  test("loading and workspace-disabled states do not show the setup introduction", () => {
    const loading = renderToStaticMarkup(<ConnectedState loading connection={{ schemaVersion: 1, provider: "github", state: "not_connected" }} />);
    expect(loading).toContain("Checking GitHub connection");
    expect(loading).not.toContain("review-github-setup");
    const disabled = renderToStaticMarkup(<ConnectedState connection={{ schemaVersion: 1, provider: "github", state: "disabled_in_workspace" }} onConnect={noop} />);
    expect(disabled).toContain("GitHub is disabled for this workspace");
    expect(disabled).not.toContain("review-github-setup");
  });

  test("guides unavailable GitHub connections to Connect settings and also allows retry", () => {
    const html = renderToStaticMarkup(
      <ConnectedState
        connection={{ schemaVersion: 1, provider: "github", state: "unavailable" }}
        onConnect={noop}
        onRetry={noop}
      />,
    );
    expect(html).toContain("GitHub connection needs attention");
    expect(html).toContain("Open Connect settings");
    expect(html).toContain("authorize your account");
    expect(html).toContain("Retry");
  });

  test("keeps a recoverable Inbox error separate from the detail workbench", () => {
    const html = renderToStaticMarkup(
      <ReviewWorkbench
        sections={[
          { relationship: "authored", reviews: [], error: "GitHub rate limit reached." },
          { relationship: "requested", reviews: [] },
          { relationship: "team", reviews: [] },
          { relationship: "recently_merged", reviews: [] },
        ]}
        expandedSections={["authored"]}
        reviewId={null}
        query=""
        review={null}
        unknown={false}
        onQueryChange={noop}
        onToggleSection={noop}
        onSelectReview={noop}
      />,
    );
    expect(html).toContain("Pull requests could not be loaded");
    expect(html).toContain("GitHub rate limit reached.");
    expect(html).toContain("Retry");
  });
});
