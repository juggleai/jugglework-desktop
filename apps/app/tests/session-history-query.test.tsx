import { expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { JuggleWorkServerClient, JuggleWorkSessionMessagesResponse } from "../src/app/lib/jugglework-server";
import { useSessionOlderHistory } from "../src/react-app/domains/session/surface/use-session-older-history";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("older-history query coalesces one cursor request and aborts it on unmount", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let requestSignal: AbortSignal | undefined;
  const calls: Array<{ limit?: number; before?: string }> = [];
  const client = {
    getSessionMessages: (_workspaceId: string, _sessionId: string, options: { limit?: number; before?: string; signal?: AbortSignal }) => {
      calls.push(options);
      requestSignal = options.signal;
      return new Promise<JuggleWorkSessionMessagesResponse>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    },
  } as JuggleWorkServerClient;
  let state!: ReturnType<typeof useSessionOlderHistory>;

  function Probe() {
    state = useSessionOlderHistory({
      client,
      workspaceId: "workspace",
      sessionId: "session",
      initialPage: { olderCursor: "opaque", hasOlder: true },
    });
    return null;
  }

  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    view = TestRenderer.create(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>);
  });

  let first!: Promise<boolean>;
  let second!: Promise<boolean>;
  act(() => {
    first = state.loadOlder();
    second = state.loadOlder();
  });
  await Promise.resolve();
  expect(first).toBe(second);
  expect(calls).toEqual([{ limit: 100, before: "opaque", signal: requestSignal }]);
  expect(requestSignal?.aborted).toBe(false);

  act(() => {
    view.unmount();
  });
  await Promise.resolve();
  expect(requestSignal?.aborted).toBe(true);

  await Promise.allSettled([first, second]);
  queryClient.clear();
});

test("older-history query retries a failed page and scopes pending requests across session switches", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const requests: Array<{
    sessionId: string;
    signal?: AbortSignal;
    resolve: (response: JuggleWorkSessionMessagesResponse) => void;
    reject: (error: Error) => void;
  }> = [];
  const client = {
    getSessionMessages: (_workspaceId: string, sessionId: string, options: { signal?: AbortSignal }) =>
      new Promise<JuggleWorkSessionMessagesResponse>((resolve, reject) => {
        const request = { sessionId, signal: options.signal, resolve, reject };
        requests.push(request);
        options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
  } as JuggleWorkServerClient;
  let sessionId = "first";
  let state!: ReturnType<typeof useSessionOlderHistory>;

  function Probe(props: { sessionId: string }) {
    state = useSessionOlderHistory({
      client,
      workspaceId: "workspace",
      sessionId: props.sessionId,
      initialPage: { olderCursor: `${props.sessionId}-cursor`, hasOlder: true },
    });
    return null;
  }

  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    view = TestRenderer.create(<QueryClientProvider client={queryClient}><Probe sessionId={sessionId} /></QueryClientProvider>);
  });

  let failed!: Promise<boolean>;
  act(() => { failed = state.loadOlder(); });
  await Promise.resolve();
  await act(async () => { requests[0]!.reject(new Error("offline")); await Promise.allSettled([failed]); });
  for (let index = 0; index < 20 && !state.error; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  expect(state.error?.message).toBe("offline");

  let retry!: Promise<boolean>;
  act(() => { retry = state.loadOlder(); });
  await Promise.resolve();
  expect(requests).toHaveLength(2);
  await act(async () => {
    requests[1]!.resolve({ items: [], page: { olderCursor: null, hasOlder: false } });
    expect(await retry).toBe(true);
  });
  for (let index = 0; index < 20 && state.error; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  expect(state.error).toBeNull();

  sessionId = "second";
  await act(async () => { view.update(<QueryClientProvider client={queryClient}><Probe sessionId={sessionId} /></QueryClientProvider>); });
  let second!: Promise<boolean>;
  act(() => { second = state.loadOlder(); });
  await Promise.resolve();
  expect(requests.at(-1)?.sessionId).toBe("second");

  sessionId = "third";
  await act(async () => { view.update(<QueryClientProvider client={queryClient}><Probe sessionId={sessionId} /></QueryClientProvider>); });
  await Promise.resolve();
  expect(requests.find((request) => request.sessionId === "second")?.signal?.aborted).toBe(true);
  expect(state.error).toBeNull();

  await act(async () => view.unmount());
  await Promise.allSettled([second]);
  queryClient.clear();
});

test("a changed snapshot root cancels the old generation and the next request starts from the new root", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const requests: Array<{
    before?: string;
    signal?: AbortSignal;
    resolve: (response: JuggleWorkSessionMessagesResponse) => void;
    reject: (error: Error) => void;
  }> = [];
  const client = {
    getSessionMessages: (_workspaceId: string, _sessionId: string, options: { before?: string; signal?: AbortSignal }) =>
      new Promise<JuggleWorkSessionMessagesResponse>((resolve, reject) => {
        requests.push({ before: options.before, signal: options.signal, resolve, reject });
        options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
  } as JuggleWorkServerClient;
  let state!: ReturnType<typeof useSessionOlderHistory>;
  function Probe(props: { root: string }) {
    state = useSessionOlderHistory({
      client,
      workspaceId: "workspace",
      sessionId: "session",
      initialPage: { olderCursor: props.root, hasOlder: true },
    });
    return null;
  }

  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => { view = TestRenderer.create(<QueryClientProvider client={queryClient}><Probe root="old-root" /></QueryClientProvider>); });
  let oldRequest!: Promise<boolean>;
  act(() => { oldRequest = state.loadOlder(); });
  await Promise.resolve();
  expect(requests[0]?.before).toBe("old-root");

  await act(async () => { view.update(<QueryClientProvider client={queryClient}><Probe root="new-root" /></QueryClientProvider>); });
  expect(requests[0]?.signal?.aborted).toBe(true);
  let newRequest!: Promise<boolean>;
  act(() => { newRequest = state.loadOlder(); });
  await Promise.resolve();
  expect(requests[1]?.before).toBe("new-root");
  await act(async () => {
    requests[1]!.resolve({ items: [], page: { olderCursor: null, hasOlder: false } });
    expect(await newRequest).toBe(true);
  });

  await act(async () => view.unmount());
  await Promise.allSettled([oldRequest]);
  queryClient.clear();
});
