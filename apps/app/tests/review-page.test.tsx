import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

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

function renderWorkbench(reviewId: string | null, sidebarOpen = true) {
  const review = reviewPreviewById(reviewId);
  return renderToStaticMarkup(
    <ReviewWorkbench
      reviews={REVIEW_PREVIEWS}
      reviewId={reviewId}
      query=""
      relationship="all"
      review={review}
      unknown={reviewId !== null && review === null}
      onQueryChange={noop}
      onRelationshipChange={noop}
      onSelectReview={noop}
      sidebarOpen={sidebarOpen}
    />,
  );
}

describe("Review workbench preview", () => {
  test("renders an explicit preview Inbox and responsive empty detail", () => {
    const html = renderWorkbench(null);

    expect(html).toContain("Connected");
    expect(html).toContain("Pull request inbox");
    expect(html).toContain("Select a pull request");
    expect(html).toContain("md:w-[var(--jugglework-left-sidebar-width)]");
    expect(html.match(/data-testid="review-inbox-item-/g)).toHaveLength(REVIEW_PREVIEWS.length);
  });

  test("hides the Inbox when the shared secondary sidebar is collapsed", () => {
    const html = renderWorkbench(null, false);

    expect(html).not.toContain("Pull request inbox");
    expect(html).toContain("Select a pull request");
  });

  test("renders summary and deferred external operations for a selected pull request", () => {
    const selected = REVIEW_PREVIEWS[0];
    const html = renderWorkbench(selected.id);

    expect(html).toContain(selected.title);
    expect(html).toContain("Pull request overview");
    expect(html).toContain("Review with JuggleWork");
    expect(html).toContain("Submit review");
    expect(html).toContain("disabled");
    expect(html).toContain('role="tablist"');
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
        reviews={[]}
        reviewId={null}
        query=""
        relationship="all"
        review={null}
        unknown={false}
        inboxError="GitHub rate limit reached."
        onQueryChange={noop}
        onRelationshipChange={noop}
        onSelectReview={noop}
        onRetryInbox={noop}
      />,
    );
    expect(html).toContain("Pull requests could not be loaded");
    expect(html).toContain("GitHub rate limit reached.");
    expect(html).toContain("Retry");
  });
});
