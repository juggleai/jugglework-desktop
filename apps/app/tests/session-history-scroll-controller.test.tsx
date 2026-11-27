import { describe, expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { setLocale, t } from "../src/i18n";
import { SessionHistoryControl } from "../src/react-app/domains/session/surface/session-history-control";
import { useSessionScrollController } from "../src/react-app/domains/session/surface/scroll-controller";
import { useSessionScrollStore } from "../src/react-app/domains/session/surface/scroll-store";
import {
  advanceHistoryThresholdGate,
  firstVisibleMessageAnchor,
  resolvePrependScrollTop,
  useSessionHistoryScrollController,
  type HistoryThresholdGate,
} from "../src/react-app/domains/session/surface/session-history-scroll-controller";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("a new prompt follows the tail without a resize, unless browsing history", async () => {
  const sessionId = "submit-scroll";
  const containerRef: { current: HTMLDivElement | null } = { current: null };
  const contentRef = { current: null };
  function Probe({ prompt }: { prompt?: string }) {
    useSessionScrollController({ selectedSessionId: sessionId, renderedMessages: prompt, latestUserMessageId: prompt, containerRef, contentRef });
    return null;
  }

  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => { view = TestRenderer.create(<Probe />); });
  const viewport = { scrollTop: 200, scrollHeight: 900, style: {}, querySelectorAll: () => [] };
  containerRef.current = viewport as unknown as HTMLDivElement;
  await act(async () => { view.update(<Probe prompt="first" />); });
  expect(viewport.scrollTop).toBe(viewport.scrollHeight);

  viewport.scrollTop = 140;
  useSessionScrollStore.getState().setManualScroll(sessionId, 140, null);
  await act(async () => { view.update(<Probe prompt="second" />); });
  expect(viewport.scrollTop).toBe(140);
  await act(async () => view.unmount());
  useSessionScrollStore.getState().setStickyBottom(sessionId, null);
});

describe("session history threshold gate", () => {
  test("does not drain an underfilled viewport without a threshold entry", () => {
    const result = advanceHistoryThresholdGate({
      gate: { previousScrollTop: null, consumed: false },
      scrollTop: 0,
      userInitiated: true,
      canLoad: true,
    });

    expect(result.shouldLoad).toBe(false);
  });

  test("allows one upward entry, then requires leaving the threshold before another", () => {
    let gate: HistoryThresholdGate = { previousScrollTop: 400, consumed: false };
    let result = advanceHistoryThresholdGate({ gate, scrollTop: 220, userInitiated: true, canLoad: true });
    expect(result.shouldLoad).toBe(true);
    gate = result.gate;

    result = advanceHistoryThresholdGate({ gate, scrollTop: 80, userInitiated: true, canLoad: true });
    expect(result.shouldLoad).toBe(false);
    gate = result.gate;

    result = advanceHistoryThresholdGate({ gate, scrollTop: 300, userInitiated: true, canLoad: true });
    expect(result.shouldLoad).toBe(false);
    gate = result.gate;

    result = advanceHistoryThresholdGate({ gate, scrollTop: 200, userInitiated: true, canLoad: true });
    expect(result.shouldLoad).toBe(true);
  });

  test("ignores programmatic threshold entries", () => {
    const result = advanceHistoryThresholdGate({
      gate: { previousScrollTop: 400, consumed: false },
      scrollTop: 200,
      userInitiated: false,
      canLoad: true,
    });
    expect(result.shouldLoad).toBe(false);
  });
});

describe("session history prepend anchor", () => {
  test("selects the first visible message and restores its offset", () => {
    expect(firstVisibleMessageAnchor({
      viewportTop: 100,
      viewportBottom: 500,
      messages: [
        { messageId: "hidden", top: 20, bottom: 90 },
        { messageId: "first", top: 80, bottom: 160 },
        { messageId: "second", top: 160, bottom: 240 },
      ],
    })?.messageId).toBe("first");

    expect(resolvePrependScrollTop({
      currentScrollTop: 220,
      currentScrollHeight: 1_400,
      anchor: { messageId: "first", viewportOffset: -20, scrollHeight: 1_000, scrollTop: 200 },
      currentAnchorOffset: 180,
    })).toBe(420);
  });

  test("falls back to the scroll-height delta when the anchor disappears", () => {
    expect(resolvePrependScrollTop({
      currentScrollTop: 200,
      currentScrollHeight: 1_450,
      anchor: { messageId: "missing", viewportOffset: 10, scrollHeight: 1_000, scrollTop: 200 },
      currentAnchorOffset: null,
    })).toBe(650);
  });

  test("does not restore a pending anchor after the user scrolls during the request", async () => {
    let resolveLoad!: (loaded: boolean) => void;
    const load = new Promise<boolean>((resolve) => { resolveLoad = resolve; });
    let controller!: ReturnType<typeof useSessionHistoryScrollController>;
    let restored: number | null = null;
    const container = {
      scrollTop: 100,
      scrollHeight: 1_000,
      getBoundingClientRect: () => ({ top: 0, bottom: 500 }),
      querySelectorAll: () => [],
    } as unknown as HTMLDivElement;

    function Probe(props: { loadedPageCount: number }) {
      controller = useSessionHistoryScrollController({
        scopeKey: "session",
        containerRef: { current: container },
        loadedPageCount: props.loadedPageCount,
        hasOlder: true,
        isLoading: false,
        loadOlder: () => load,
        onBeforeLoad: () => {},
        onAfterRestore: (scrollTop) => { restored = scrollTop; },
      });
      return null;
    }

    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => { view = TestRenderer.create(<Probe loadedPageCount={0} />); });
    act(() => { void controller.requestOlder(); });
    act(() => controller.markUserScrollIntent());
    container.scrollTop = 240;
    container.scrollHeight = 1_400;
    await act(async () => {
      resolveLoad(true);
      await load;
      view.update(<Probe loadedPageCount={1} />);
    });

    expect(container.scrollTop).toBe(240);
    expect(restored).toBeNull();
    await act(async () => view.unmount());
  });

  test("reports the restored scroll position so the manual scroll store can stay in sync", async () => {
    let controller!: ReturnType<typeof useSessionHistoryScrollController>;
    let restored: number | null = null;
    const container = {
      scrollTop: 100,
      scrollHeight: 1_000,
      getBoundingClientRect: () => ({ top: 0, bottom: 500 }),
      querySelectorAll: () => [],
    } as unknown as HTMLDivElement;
    function Probe(props: { loadedPageCount: number }) {
      controller = useSessionHistoryScrollController({
        scopeKey: "session",
        containerRef: { current: container },
        loadedPageCount: props.loadedPageCount,
        hasOlder: true,
        isLoading: false,
        loadOlder: async () => true,
        onBeforeLoad: () => {},
        onAfterRestore: (scrollTop) => { restored = scrollTop; },
      });
      return null;
    }

    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => { view = TestRenderer.create(<Probe loadedPageCount={0} />); });
    await act(async () => { await controller.requestOlder(); });
    container.scrollHeight = 1_400;
    await act(async () => { view.update(<Probe loadedPageCount={1} />); });

    expect(container.scrollTop).toBe(500);
    expect(restored).toBe(500);
    await act(async () => view.unmount());
  });
});

describe("session history top gestures", () => {
  function mount(options: { scrollTop: number; hasOlder?: boolean; isLoading?: boolean }) {
    const state = { loads: 0, before: 0 };
    const container = {
      scrollTop: options.scrollTop,
      scrollHeight: 1_000,
      getBoundingClientRect: () => ({ top: 0, bottom: 500 }),
      querySelectorAll: () => [],
    } as unknown as HTMLDivElement;
    let controller!: ReturnType<typeof useSessionHistoryScrollController>;
    function Probe() {
      controller = useSessionHistoryScrollController({
        scopeKey: "session",
        containerRef: { current: container },
        loadedPageCount: 0,
        hasOlder: options.hasOlder ?? true,
        isLoading: options.isLoading ?? false,
        loadOlder: async () => { state.loads += 1; return true; },
        onBeforeLoad: () => { state.before += 1; },
        onAfterRestore: () => {},
      });
      return null;
    }
    return { state, container, probe: Probe, get controller() { return controller; } };
  }

  test("an upward wheel while already at the top loads one older page", async () => {
    const harness = mount({ scrollTop: 0 });
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => { view = TestRenderer.create(<harness.probe />); });
    await act(async () => { harness.controller.handleWheel(-40); });
    expect(harness.state.loads).toBe(1);
    expect(harness.state.before).toBe(1);
    await act(async () => view.unmount());
  });

  test("downward gestures and gestures far from the top do not load", async () => {
    const top = mount({ scrollTop: 0 });
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => { view = TestRenderer.create(<top.probe />); });
    await act(async () => { top.controller.handleWheel(40); });
    await act(async () => { top.controller.handleKey("ArrowDown"); });
    expect(top.state.loads).toBe(0);
    await act(async () => view.unmount());

    const far = mount({ scrollTop: 900 });
    await act(async () => { view = TestRenderer.create(<far.probe />); });
    await act(async () => { far.controller.handleWheel(-40); });
    await act(async () => { far.controller.handleKey("PageUp"); });
    expect(far.state.loads).toBe(0);
    await act(async () => view.unmount());
  });

  test("keyboard and touch pulls toward the top load, and exhausted history does not", async () => {
    const key = mount({ scrollTop: 10 });
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => { view = TestRenderer.create(<key.probe />); });
    await act(async () => { key.controller.handleKey("Home"); });
    expect(key.state.loads).toBe(1);
    await act(async () => view.unmount());

    const touch = mount({ scrollTop: 0 });
    await act(async () => { view = TestRenderer.create(<touch.probe />); });
    await act(async () => { touch.controller.handleTouchStart(100); });
    await act(async () => { touch.controller.handleTouchMove(160); });
    expect(touch.state.loads).toBe(1);
    await act(async () => view.unmount());

    const done = mount({ scrollTop: 0, hasOlder: false });
    await act(async () => { view = TestRenderer.create(<done.probe />); });
    await act(async () => { done.controller.handleWheel(-40); });
    expect(done.state.loads).toBe(0);
    await act(async () => view.unmount());
  });

  test("repeated wheel events during one load or right after it start only one request", async () => {
    const harness = mount({ scrollTop: 0 });
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => { view = TestRenderer.create(<harness.probe />); });
    await act(async () => {
      harness.controller.handleWheel(-40);
      harness.controller.handleWheel(-40);
      harness.controller.handleWheel(-40);
    });
    expect(harness.state.loads).toBe(1);
    await act(async () => { harness.controller.handleWheel(-40); });
    expect(harness.state.loads).toBe(1);
    await act(async () => view.unmount());
  });
});

describe("session history control", () => {
  test("keeps load available for underfilled transcripts and exposes retry", async () => {
    setLocale("en");
    let loads = 0;
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      view = TestRenderer.create(
        <SessionHistoryControl hasOlder isLoading={false} error={null} showHistoryStart={false} onLoadOlder={() => { loads += 1; }} />,
      );
    });

    const load = view.root.findByType("button");
    expect(load.children.join("")).toBe(t("session.history_load_earlier"));
    act(() => load.props.onClick());
    expect(loads).toBe(1);

    await act(async () => {
      view.update(<SessionHistoryControl hasOlder isLoading error={null} showHistoryStart={false} onLoadOlder={() => { loads += 1; }} />);
    });
    const loading = view.root.findByType("button");
    expect(loading).toBe(load);
    expect(loading.props.disabled).toBeUndefined();
    expect(loading.props["aria-disabled"]).toBe(true);
    expect(loading.props["aria-busy"]).toBe(true);
    expect(loading.children.at(-1)).toBe(t("session.history_loading_earlier"));
    act(() => loading.props.onClick());
    expect(loads).toBe(1);

    await act(async () => {
      view.update(<SessionHistoryControl hasOlder isLoading={false} error={new Error("offline")} showHistoryStart={false} onLoadOlder={() => { loads += 1; }} />);
    });
    const retry = view.root.findByType("button");
    expect(retry).toBe(load);
    expect(retry.props.type).toBe("button");
    expect(retry.children.join("")).toBe(t("session.history_retry_earlier"));
    act(() => retry.props.onClick());
    expect(loads).toBe(2);
    await act(async () => view.unmount());
  });

  test("shows loading and only shows history start when requested", async () => {
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      view = TestRenderer.create(<SessionHistoryControl hasOlder={false} isLoading error={null} showHistoryStart={false} onLoadOlder={() => {}} />);
    });
    expect(view.root.findByType("button").props["aria-busy"]).toBe(true);

    await act(async () => {
      view.update(<SessionHistoryControl hasOlder={false} isLoading={false} error={null} showHistoryStart={false} onLoadOlder={() => {}} />);
    });
    expect(view.toJSON()).toBeNull();

    await act(async () => {
      view.update(<SessionHistoryControl hasOlder={false} isLoading={false} error={null} showHistoryStart onLoadOlder={() => {}} />);
    });
    expect(view.root.findByProps({ role: "status" }).children.join("")).toBe(t("session.history_start"));
    await act(async () => view.unmount());
  });
});
