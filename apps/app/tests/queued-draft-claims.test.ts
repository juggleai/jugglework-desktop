import { beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { useComposerStateStore } from "../src/react-app/domains/session/surface/composer-state-store";

beforeEach(() => useComposerStateStore.setState({ queueClaims: {}, queuedDrafts: {} }));

test("queue claims survive consumer replacement and are exclusive per session", () => {
  const first = useComposerStateStore.getState();
  expect(first.claimQueue("a", "one")).toBe(true);
  const remounted = useComposerStateStore.getState();
  expect(remounted.claimQueue("a", "two")).toBe(false);
  expect(remounted.claimQueue("b", "three")).toBe(true);
  remounted.releaseQueue("a", "wrong");
  expect(useComposerStateStore.getState().queueClaims.a).toBe("one");
  remounted.releaseQueue("a", "one");
  expect(remounted.claimQueue("a", "two")).toBe(true);
});

test("stop invalidates in-flight claims even when the draft has already been removed", () => {
  const store = useComposerStateStore.getState();
  store.claimQueue("a", "one");
  store.clearQueuedDrafts("a");
  expect(useComposerStateStore.getState().queueClaims.a).toBeUndefined();
});

test("restored queues use authoritative idle rather than a component busy latch", () => {
  const source = readFileSync(new URL("../src/react-app/domains/session/surface/session-surface.tsx", import.meta.url), "utf8");
  expect(source).toContain("waitingForIdle: activeRunsQuery.isSuccess && !activeRunsQuery.isFetching && coordinatorRun === null");
  expect(source).toContain("query.state.data?.items.length || queuedDrafts.length ? 750 : false");
  expect(source).toContain("queueStore.claimQueue(props.sessionId, target.id)");
  expect(source).toContain("blockedReason: t(\"composer.queued_send_failed\")");
});
