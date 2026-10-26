/** @jsxImportSource react */
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReviewRun } from "@jugglework/types/reviews";
import type { ResolvedWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import { REVIEW_PREVIEWS } from "../src/react-app/domains/reviews/review-preview-data";
import type { ReviewConversationLayout } from "../src/react-app/domains/reviews/review-conversation-panel";

mock.module("../src/react-app/domains/reviews/review-session-composer", () => ({
  ReviewSessionComposer: (props: { workspaceId: string; sessionId: string; compact?: boolean; compactJoined?: boolean; onComposerFocus?: () => void }) => <button type="button" data-testid="review-session-composer" data-compact={String(Boolean(props.compact))} data-joined={String(Boolean(props.compactJoined))} onClick={props.onComposerFocus}>{props.workspaceId}:{props.sessionId}</button>,
}));
mock.module("../src/react-app/kernel/model-config", () => ({
  readStoredDefaultModel: () => ({ providerID: "openai", modelID: "gpt-6.1-sol" }),
}));
mock.module("../src/components/chat/message-list", () => ({
  MessageList: (props: { messages: Array<{ parts?: Array<{ type?: string; text?: string }> }>; status: string }) => <div data-testid="shared-message-list" data-status={props.status}>{props.messages.flatMap((message) => message.parts ?? []).map((part) => part.text ?? "").join("|")}</div>,
}));

const { ReviewConversationPanel } = await import("../src/react-app/domains/reviews/review-conversation-panel");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth: 1200, innerHeight: 800, addEventListener: () => undefined, removeEventListener: () => undefined } });
class TestNode {}
class TestElement extends TestNode { closest() { return null; } }
Object.defineProperty(globalThis, "Node", { configurable: true, value: TestNode });
Object.defineProperty(globalThis, "Element", { configurable: true, value: TestElement });

const headRevision = "a".repeat(40);
const review = { ...REVIEW_PREVIEWS[0]!, headRevision };
let saved: ReviewRun | null;
const start = mock(async (_workspaceId: string, _reviewId: string, input: { mode?: "review" | "conversation" }) => {
  saved = {
    id: saved?.id ?? crypto.randomUUID(), reviewId: review.id, headRevision, status: input.mode === "conversation" ? "completed" : "running", createdAt: saved?.createdAt ?? new Date().toISOString(), partial: false,
    workspaceId: "review-workspace", sessionId: "review-session",
  };
  return { run: saved };
});
const endpoint = {
  baseUrl: "http://127.0.0.1:1234",
  workspaceId: "source-workspace",
  client: {
    getReviewRun: async () => ({ run: saved }),
    startReviewRun: start,
    getSessionSnapshot: async () => ({ item: { messages: [], status: { type: "idle" } } }),
  },
} as unknown as ResolvedWorkspaceEndpoint;

let queryClient: QueryClient;
let view: TestRenderer.ReactTestRenderer;
const render = async (layout: ReviewConversationLayout = "right", onLayoutChange: (layout: ReviewConversationLayout) => void = () => undefined, reviewRequestId = 0) => {
  await act(async () => {
    view = TestRenderer.create(<QueryClientProvider client={queryClient}><ReviewConversationPanel endpoint={endpoint} review={review} active layout={layout} reviewRequestId={reviewRequestId} onLayoutChange={onLayoutChange} onClose={() => undefined} /></QueryClientProvider>);
  });
  await act(async () => { await Bun.sleep(60); });
};

beforeEach(() => {
  saved = null;
  start.mockClear();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(async () => { await act(async () => { view?.unmount(); queryClient.clear(); }); });

test("opening a PR panel prepares a conversation without starting review analysis", async () => {
  await render();
  expect(start).toHaveBeenCalledTimes(1);
  expect(start.mock.calls[0]?.[2]).toMatchObject({ expectedHeadRevision: headRevision, mode: "conversation" });
  expect(view.root.findByProps({ "data-testid": "review-session-composer" }).children.join("")).toBe("review-workspace:review-session");
});

test("an explicit review request starts analysis in the same PR-bound conversation", async () => {
  saved = {
    id: crypto.randomUUID(), reviewId: review.id, headRevision, status: "completed", createdAt: new Date().toISOString(), partial: false,
    workspaceId: "review-workspace", sessionId: "review-session",
  };
  await render("right", () => undefined, 1);
  expect(start).toHaveBeenCalledTimes(1);
  expect(start.mock.calls[0]?.[2]).toMatchObject({ expectedHeadRevision: headRevision, mode: "review", model: { providerID: "openai", modelID: "gpt-6.1-sol" } });
  expect(view.root.findByProps({ "data-testid": "review-session-composer" }).children.join("")).toBe("review-workspace:review-session");
});

test("an accepted review immediately renders its readable prompt as a streaming task before a session exists", async () => {
  saved = {
    id: crypto.randomUUID(), reviewId: review.id, headRevision, status: "running", phase: "queued", createdAt: new Date().toISOString(), partial: false,
  };
  await render("right", () => undefined, 1);
  const shared = view.root.findByProps({ "data-testid": "shared-message-list" });
  expect(shared.props["data-status"]).toBe("streaming");
  expect(shared.children.join("")).toContain("Run a private review");
});

test("a legacy completed review without a workspace association is migrated without duplicate analysis", async () => {
  saved = { id: crypto.randomUUID(), reviewId: review.id, headRevision, status: "completed", createdAt: new Date().toISOString(), partial: false, analysis: { summary: "Legacy", findings: [] } };
  await render();
  expect(start).toHaveBeenCalledTimes(1);
  expect(start.mock.calls[0]?.[2]).toMatchObject({ mode: "conversation" });
  expect(view.root.findByProps({ "data-testid": "review-session-composer" })).toBeTruthy();
});

test("a completed review with an associated session is restored without duplicate analysis", async () => {
  saved = {
    id: crypto.randomUUID(), reviewId: review.id, headRevision, status: "completed", createdAt: new Date().toISOString(), partial: false,
    workspaceId: "review-workspace", sessionId: "review-session", analysis: { summary: "Done", findings: [] },
  };
  await render();
  expect(start).not.toHaveBeenCalled();
  expect(view.root.findByProps({ "data-testid": "review-session-composer" }).children.join("")).toBe("review-workspace:review-session");
});

test("conversation chrome moves between docked, quick, and minimized layouts", async () => {
  saved = {
    id: crypto.randomUUID(), reviewId: review.id, headRevision, status: "completed", createdAt: new Date().toISOString(), partial: false,
    workspaceId: "review-workspace", sessionId: "review-session", analysis: { summary: "Done", findings: [] },
  };
  const change = mock((_layout: ReviewConversationLayout) => undefined);
  await render("right", change);
  expect(view.root.findByProps({ "data-testid": "review-conversation-panel" }).props["data-layout"]).toBe("right");
  expect(view.root.findByProps({ "aria-label": "Resize conversation pane" })).toBeTruthy();
  expect(view.root.findByProps({ "aria-label": "Resize conversation pane" }).props.className).toContain("bg-transparent");
  expect(view.root.findByProps({ "aria-label": "Resize conversation pane" }).props.className).not.toContain("hover:bg-blue");
  expect(view.root.findAllByProps({ "aria-label": "Close review conversation" })).toHaveLength(0);
  await act(async () => { view.root.findByProps({ "aria-label": "Minimize conversation" }).props.onClick(); });
  expect(change).toHaveBeenLastCalledWith("floating");

  await act(async () => {
    view.update(<QueryClientProvider client={queryClient}><ReviewConversationPanel endpoint={endpoint} review={review} active layout="floating" onLayoutChange={change} onClose={() => undefined} /></QueryClientProvider>);
  });
  expect(view.root.findByProps({ "data-testid": "review-session-composer" }).props["data-compact"]).toBe("true");
  expect(view.root.findByProps({ "data-testid": "review-session-composer" }).props["data-joined"]).toBe("false");
  expect(view.root.findAllByProps({ "aria-label": "Minimize conversation" })).toHaveLength(0);
  expect(view.root.findAllByProps({ "data-testid": "review-quick-controls" })).toHaveLength(0);
  await act(async () => { view.root.findByProps({ "data-testid": "review-session-composer" }).props.onClick(); });
  expect(view.root.findByProps({ "data-testid": "review-quick-controls" })).toBeTruthy();
  expect(view.root.findByProps({ "data-testid": "review-session-composer" }).props["data-joined"]).toBe("true");
  const quickOptions = view.root.findByProps({ "aria-label": "Quick conversation options" });
  expect(quickOptions.props.className).toContain("size-8");
  expect(quickOptions.findAllByType("span")).toHaveLength(0);
  await act(async () => { view.root.findByProps({ "aria-label": "Hide quick conversation" }).props.onClick(); });
  expect(change).toHaveBeenLastCalledWith("minimized");

  await act(async () => {
    view.update(<QueryClientProvider client={queryClient}><ReviewConversationPanel endpoint={endpoint} review={review} active layout="minimized" onLayoutChange={change} onClose={() => undefined} /></QueryClientProvider>);
  });
  expect(view.root.findByProps({ "data-testid": "review-conversation-panel" }).props.className).toContain("size-14");
  await act(async () => { view.root.findByProps({ "aria-label": "Open quick conversation" }).props.onClick(); });
  expect(change).toHaveBeenLastCalledWith("floating");
});

test("docked pane divider resizes the conversation within bounds", async () => {
  saved = {
    id: crypto.randomUUID(), reviewId: review.id, headRevision, status: "completed", createdAt: new Date().toISOString(), partial: false,
    workspaceId: "review-workspace", sessionId: "review-session",
  };
  const listeners = new Map<string, (event: any) => void>();
  Object.assign(globalThis.window, {
    addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  });
  await render("right");
  await act(async () => {
    view.root.findByProps({ "aria-label": "Resize conversation pane" }).props.onPointerDown({ preventDefault: () => undefined, clientX: 500 });
    listeners.get("pointermove")?.({ clientX: 400 });
  });
  expect(view.root.findByProps({ "data-testid": "review-conversation-panel" }).props.style.width).toBe(660);
  listeners.get("pointerup")?.({});
});

test("docked transcript uses the shared task renderer and replaces private-review JSON with readable Markdown", async () => {
  saved = {
    id: crypto.randomUUID(), reviewId: review.id, headRevision, status: "completed", createdAt: new Date().toISOString(), partial: false,
    workspaceId: "review-workspace", sessionId: "review-session", analysis: { summary: "Review summary", findings: [{ id: "one", priority: 1, title: "Finding", body: "Impact", path: "src/a.ts", line: 2 }] },
  };
  endpoint.client.getSessionSnapshot = async () => ({ item: {
    session: { id: "review-session" }, status: { type: "idle" }, todos: [],
    messages: [
      { info: { id: "u", role: "user", time: { created: Date.now() } }, parts: [{ id: "up", type: "text", text: '{"pullRequest":{"title":"unsafe"}}' }] },
      { info: { id: "a", role: "assistant", time: { created: Date.now(), completed: Date.now() }, finish: "stop" }, parts: [{ id: "ap", type: "text", text: '{"summary":"raw"}' }] },
    ],
  } } as any);
  await render("right");
  const shared = view.root.findByProps({ "data-testid": "shared-message-list" });
  expect(shared.children.join("")).toContain("Run a private review");
  expect(shared.children.join("")).toContain("### P1 · Finding");
  expect(shared.children.join("")).not.toContain('"pullRequest"');
});

test("a long press on the six-dot handle drags the floating conversation", async () => {
  saved = {
    id: crypto.randomUUID(), reviewId: review.id, headRevision, status: "completed", createdAt: new Date().toISOString(), partial: false,
    workspaceId: "review-workspace", sessionId: "review-session",
  };
  await render("floating");
  await act(async () => { view.root.findByProps({ "data-testid": "review-session-composer" }).props.onClick(); });
  const handle = view.root.findByProps({ "aria-label": "Quick conversation options" });
  const target = { setPointerCapture: () => undefined, releasePointerCapture: () => undefined };
  await act(async () => {
    handle.props.onPointerDown({ button: 0, pointerId: 1, clientX: 500, clientY: 500, currentTarget: target });
    await Bun.sleep(300);
    handle.props.onPointerMove({ pointerId: 1, clientX: 450, clientY: 460 });
  });
  expect(view.root.findByProps({ "data-testid": "review-conversation-panel" }).props.style.transform).toBe("translate(-50px, -40px)");
  await act(async () => { handle.props.onPointerUp({ pointerId: 1, currentTarget: target }); });
  await act(async () => { handle.props.onClickCapture({ preventDefault: () => undefined, stopPropagation: () => undefined }); });
  expect(view.root.findAllByProps({ role: "menu" })).toHaveLength(0);
});

test("outside pointer interaction hides the focused quick-conversation control row", async () => {
  saved = {
    id: crypto.randomUUID(), reviewId: review.id, headRevision, status: "completed", createdAt: new Date().toISOString(), partial: false,
    workspaceId: "review-workspace", sessionId: "review-session",
  };
  const listeners = new Map<string, (event: any) => void>();
  const previousWindow = globalThis.window as any;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    ...previousWindow,
    addEventListener: (name: string, listener: (event: any) => void) => listeners.set(`${name}:capture`, listener),
    removeEventListener: (name: string) => listeners.delete(`${name}:capture`),
  } });
  await render("floating");
  await act(async () => { view.root.findByProps({ "data-testid": "review-session-composer" }).props.onClick(); });
  expect(view.root.findByProps({ "data-testid": "review-quick-controls" })).toBeTruthy();
  await act(async () => { listeners.get("pointerdown:capture")?.({ target: new TestNode() }); });
  expect(view.root.findAllByProps({ "data-testid": "review-quick-controls" })).toHaveLength(0);
  expect(view.root.findByProps({ "data-testid": "review-session-composer" }).props["data-joined"]).toBe("false");
});
