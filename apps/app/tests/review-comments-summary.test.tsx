/** @jsxImportSource react */
import { afterEach, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act, type ReactTestRenderer } from "react-test-renderer";
import { PlatformProvider, type Platform } from "../src/react-app/kernel/platform";
import { REVIEW_PREVIEWS } from "../src/react-app/domains/reviews/review-preview-data";

const platform: Platform = { platform: "desktop", openLink: () => undefined, restart: async () => undefined, notify: async () => undefined };
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const scrollIntoView = mock(() => undefined);
const focus = mock(() => undefined);
const memoryStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0 };
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage });
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: memoryStorage });
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { callback(0); return 1; } });
Object.defineProperty(globalThis, "CSS", { configurable: true, value: { escape: (value: string) => value } });
Object.defineProperty(globalThis, "document", { configurable: true, value: {
  head: { appendChild: () => undefined },
  createElement: () => ({ setAttribute: () => undefined, appendChild: () => undefined }),
  createTextNode: () => ({}),
  getElementsByTagName: () => [{ appendChild: () => undefined }],
  querySelector: () => ({ scrollIntoView, focus }),
} });

const { ReviewWorkbench } = await import("../src/react-app/domains/reviews/review-page");
let view: ReactTestRenderer | undefined;
afterEach(async () => { await act(async () => view?.unmount()); view = undefined; scrollIntoView.mockClear(); focus.mockClear(); });

test("counts only review thread roots, expands compact previews, and locates Activity", async () => {
  const review = { ...REVIEW_PREVIEWS[0]!, threads: [
    { ...REVIEW_PREVIEWS[0]!.threads[0]!, resolved: true, comments: [{ id: "root", author: "Alex Wu", body: "Root", age: "1m" }, { id: "reply", author: "Maya", body: "Reply", age: "now" }] },
    { ...REVIEW_PREVIEWS[0]!.threads[1]!, kind: "issue_comment" as const },
  ] };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => { view = TestRenderer.create(<QueryClientProvider client={queryClient}><PlatformProvider value={platform}><ReviewWorkbench
    sections={[]} expandedSections={[]} reviewId={review.id} query="" review={review} tab="summary" sidebarOpen
    onQueryChange={() => undefined} onToggleSection={() => undefined} onSelectReview={() => undefined}
  /></PlatformProvider></QueryClientProvider>); });
  const summary = view!.root.findByProps({ "data-testid": "review-comments-summary" });
  expect(summary.findAllByType("button")[0]?.findAllByType("span")[0]?.children).toContain("1 comment");
  await act(async () => { summary.findAllByType("button")[0]!.props.onClick(); });
  expect(view!.root.findByProps({ "data-testid": "review-comments-list" })).toBeTruthy();
  expect(view!.root.findByProps({ "aria-label": "Resolved" })).toBeTruthy();
  const preview = view!.root.findByProps({ "data-testid": "review-comments-list" }).findAllByType("button")[0]!;
  await act(async () => { preview.props.onClick(); });
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
  expect(focus).toHaveBeenCalledTimes(1);
});
