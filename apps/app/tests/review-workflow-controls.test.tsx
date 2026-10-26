/** @jsxImportSource react */
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ResolvedWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import { REVIEW_PREVIEWS } from "../src/react-app/domains/reviews/review-preview-data";
import type { ReviewRun } from "@jugglework/types/reviews";

mock.module("../src/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));
mock.module("../src/react-app/domains/settings/cloud/cloud-session-provider", () => ({ useCloudSession: () => ({ baseUrl: "https://work.test", user: { id: "user" }, activeOrganization: { id: "org" } }) }));
mock.module("../src/react-app/kernel/model-config", () => ({ readStoredDefaultModel: () => ({ providerID: "openai", modelID: "gpt-6.1-sol" }) }));
const { ReviewWorkflowControls } = await import("../src/react-app/domains/reviews/review-workflow-controls");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const head = "a".repeat(40);
let run: ReviewRun | null = null;
const publish = mock(async (..._args: unknown[]) => ({ ok: true }));
const start = mock(async (..._args: unknown[]) => ({ run }));
const fix = mock(async (..._args: unknown[]) => ({ sessionId: "fix-session" }));
const openSession = mock((_id: string) => {});
const openReviewPanel = mock(() => {});
const endpoint = { baseUrl: "http://127.0.0.1:1234", workspaceId: "ws", client: { getReviewRun: async () => ({ run }), startReviewRun: start, cancelReviewRun: async () => ({ run }), publishReview: publish, createReviewFix: fix, listAutomationDependencies: async () => ({ models: [] }) } } as unknown as ResolvedWorkspaceEndpoint;
let client: QueryClient;
let view: TestRenderer.ReactTestRenderer;
const review = { ...REVIEW_PREVIEWS[0]!, headRevision: head };
const button = (label: string) => view.root.findAllByType("button").find((item) => item.children.includes(label))!;
async function render(writable = true, revision = head, relationship = review.relationship, isOwnPullRequest?: boolean, usePanel = false) {
  await act(async () => { view = TestRenderer.create(<QueryClientProvider client={client}><ReviewWorkflowControls endpoint={endpoint} review={{ ...review, headRevision: revision, relationship }} isOwnPullRequest={isOwnPullRequest} active operations={{ comment: writable, submitReview: writable }} onOpenSession={openSession} onOpenReviewPanel={usePanel ? openReviewPanel : undefined} /></QueryClientProvider>); });
  await act(async () => { await Bun.sleep(5); });
}
beforeEach(() => { run = null; publish.mockClear(); start.mockClear(); fix.mockClear(); openSession.mockClear(); openReviewPanel.mockClear(); client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); });
afterEach(async () => { await act(async () => { view?.unmount(); client.clear(); }); });

test("opening submit review does not publish; only the final button sends the selected decision", async () => {
  await render();
  await act(async () => { button("Submit review").props.onClick(); });
  expect(publish).not.toHaveBeenCalled();
  expect(button("Publish to GitHub").props.disabled).toBe(true);
  await act(async () => { view.root.findByType("textarea").props.onChange({ target: { value: "Please fix this regression" } }); });
  await act(async () => { view.root.findByProps({ "aria-label": "Review decision" }).props.onChange({ target: { value: "REQUEST_CHANGES" } }); });
  await act(async () => { button("Publish to GitHub").props.onClick(); await Bun.sleep(5); });
  expect(publish).toHaveBeenCalledTimes(1);
  expect(publish.mock.calls[0]?.[2]).toMatchObject({ kind: "review", event: "REQUEST_CHANGES", expectedHeadRevision: head, body: "Please fix this regression" });
});

test("read-only organization connections can run AI review without enabling external publishing", async () => {
  await render(false);
  expect(button("Submit review").props.disabled).toBe(true);
  await act(async () => { button("Review with JuggleWork").props.onClick(); });
  expect(start).not.toHaveBeenCalled();
  await act(async () => { button("Start review").props.onClick(); await Bun.sleep(5); });
  expect(start).toHaveBeenCalledTimes(1);
  expect(publish).not.toHaveBeenCalled();
});

test("the review panel opens and owns starting its PR-bound session", async () => {
  await render(true, head, review.relationship, undefined, true);
  await act(async () => { button("Review with JuggleWork").props.onClick(); await Bun.sleep(5); });
  expect(openReviewPanel).toHaveBeenCalledTimes(1);
  expect(start).not.toHaveBeenCalled();
  expect(view.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
});

test("authored pull requests hide every submit-review entry point", async () => {
  run = { id: crypto.randomUUID(), reviewId: review.id, headRevision: head, status: "completed", createdAt: new Date().toISOString(), partial: false, analysis: { summary: "One regression", findings: [{ id: "finding-1", priority: 1, title: "Bug", body: "Impact" }] } };
  await render(true, head, "requested", true);
  expect(button("Review with JuggleWork")).toBeTruthy();
  expect(button("Submit review")).toBeUndefined();
  await act(async () => { button("Review with JuggleWork").props.onClick(); });
  expect(button("Use in review…")).toBeUndefined();
});

test("selected findings create a fix task and navigate to the returned session", async () => {
  run = { id: crypto.randomUUID(), reviewId: review.id, headRevision: head, status: "completed", createdAt: new Date().toISOString(), partial: false, analysis: { summary: "One regression", findings: [{ id: "finding-1", priority: 1, title: "Bug", body: "Impact", path: "a.ts", line: 2 }] } };
  await render();
  await act(async () => { button("Review with JuggleWork").props.onClick(); });
  await act(async () => { button("Fix selected").props.onClick(); await Bun.sleep(5); });
  expect(fix.mock.calls[0]?.[2]).toMatchObject({ runId: run.id, findingIds: ["finding-1"], expectedHeadRevision: head });
  expect(openSession).toHaveBeenCalledWith("fix-session");
  expect(publish).not.toHaveBeenCalled();
});

test("shows deduplicated PR-related review and historical fix tasks", async () => {
  run = {
    id: crypto.randomUUID(), reviewId: review.id, headRevision: head, status: "completed", createdAt: new Date().toISOString(), partial: false,
    sessionId: "review-session", fixSessionId: "latest-fix", analysis: { summary: "Done", findings: [] },
    history: [{ id: crypto.randomUUID(), headRevision: "b".repeat(40), status: "completed", createdAt: new Date().toISOString(), partial: false, sessionId: "review-session", fixSessionId: "old-fix", analysis: { summary: "Old", findings: [] } }],
  };
  await render();
  await act(async () => { button("Review with JuggleWork").props.onClick(); });
  expect(view.root.findByProps({ "data-testid": "review-related-tasks" })).toBeTruthy();
  await act(async () => { button("Open review task").props.onClick(); });
  expect(openSession).toHaveBeenCalledWith("review-session");
  expect(view.root.findAllByType("button").filter((item) => item.children.some((child) => typeof child === "string" && child.startsWith("Open fix task")))).toHaveLength(2);
});

test("findings for an old PR revision cannot be published or fixed", async () => {
  run = { id: crypto.randomUUID(), reviewId: review.id, headRevision: "b".repeat(40), status: "completed", createdAt: new Date().toISOString(), partial: false, analysis: { summary: "Old revision", findings: [{ id: "finding-1", priority: 1, title: "Old bug", body: "Impact" }] } };
  await render();
  await act(async () => { button("Review with JuggleWork").props.onClick(); });
  expect(button("Fix selected").props.disabled).toBe(true);
  expect(button("Use in review…").props.disabled).toBe(true);
  expect(start).not.toHaveBeenCalled(); expect(fix).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
});

test("a PR update while the publishing dialog is open blocks the old draft", async () => {
  await render();
  await act(async () => { button("Submit review").props.onClick(); });
  await act(async () => { view.root.findByType("textarea").props.onChange({ target: { value: "Draft for old revision" } }); });
  expect(button("Publish to GitHub").props.disabled).toBe(false);
  await act(async () => { view.update(<QueryClientProvider client={client}><ReviewWorkflowControls endpoint={endpoint} review={{ ...review, headRevision: "b".repeat(40) }} active operations={{ comment: true, submitReview: true }} onOpenSession={openSession} /></QueryClientProvider>); });
  expect(button("Publish to GitHub").props.disabled).toBe(true);
  expect(publish).not.toHaveBeenCalled();
});
