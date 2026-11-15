import { describe, expect, test } from "bun:test";
import type { JuggleWorkSessionMessage, JuggleWorkSessionMessagesResponse } from "../src/app/lib/jugglework-server";
import {
  appendSessionHistoryPage,
  applyRawMessageRevertCursor,
  applyRevertToSessionHistory,
  mergeHistoricalSessionMessages,
  reconcileSessionHistoryRoot,
  removeMessageFromSessionHistory,
  resolveOlderHistoryCursor,
} from "../src/react-app/domains/session/sync/session-history";

const message = (id: string, text = id): JuggleWorkSessionMessage => ({
  info: { id, sessionID: "session", role: "assistant", time: { created: Number(id.replace(/\D/g, "")) || 0 } },
  parts: [{ id: `${id}:text`, sessionID: "session", messageID: id, type: "text", text }],
}) as JuggleWorkSessionMessage;

const page = (
  ids: string[],
  olderCursor: string | null,
): JuggleWorkSessionMessagesResponse => ({
  items: ids.map((id) => message(id)),
  page: { olderCursor, hasOlder: olderCursor !== null },
});

const withoutTimes = (value: JuggleWorkSessionMessagesResponse) => {
  for (const item of value.items) delete (item.info as { time?: unknown }).time;
  return value;
};

describe("session older-history reconciliation", () => {
  test("keeps a 140-message opening window and reconstructs a 350-message session in bounded older pages", () => {
    const ids = Array.from({ length: 350 }, (_, index) => `m${index + 1}`);
    const current = ids.slice(210).map((id) => message(id));
    const firstOlderPage = page(ids.slice(110, 210), "before-m111");
    const secondOlderPage = page(ids.slice(10, 110), "before-m11");
    const finalOlderPage = page(ids.slice(0, 10), null);

    expect(current).toHaveLength(140);
    expect(firstOlderPage.items).toHaveLength(100);
    expect(secondOlderPage.items).toHaveLength(100);
    expect(finalOlderPage.items).toHaveLength(10);

    const merged = mergeHistoricalSessionMessages(
      [firstOlderPage, secondOlderPage, finalOlderPage],
      current,
    );
    expect(merged.map((item) => item.info.id)).toEqual(ids);
    expect(new Set(merged.map((item) => item.info.id)).size).toBe(350);
    expect(resolveOlderHistoryCursor({
      initialPage: { olderCursor: "before-m111", hasOlder: true },
      pages: [firstOlderPage, secondOlderPage, finalOlderPage],
      pageParams: ["before-m211", "before-m111", "before-m11"],
    })).toEqual({ cursor: null, loopDetected: false });
  });

  test("orders newest-first fetched pages chronologically and lets current records win overlaps", () => {
    const older = page(["m1", "m2", "m3"], null);
    const newer = page(["m3", "m4", "m5"], "older-page");
    newer.items[0] = message("m3", "newer page");
    const current = [message("m5", "current"), message("m6", "live window")];

    const merged = mergeHistoricalSessionMessages([newer, older], current);

    expect(merged.map((item) => item.info.id)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
    expect((merged.find((item) => item.info.id === "m5")?.parts[0] as { text: string }).text).toBe("current");
    expect((merged.find((item) => item.info.id === "m3")?.parts[0] as { text: string }).text).toBe("newer page");
  });

  test("keeps loaded pages independent from a bounded snapshot refresh", () => {
    const history = [page(["m1", "m2"], null)];
    expect(mergeHistoricalSessionMessages(history, [message("m3")]).map((item) => item.info.id)).toEqual(["m1", "m2", "m3"]);
    expect(mergeHistoricalSessionMessages(history, [message("m4")]).map((item) => item.info.id)).toEqual(["m1", "m2", "m4"]);
  });

  test("bridges a changed snapshot root only after the new chain overlaps the detached m1..m400 history", () => {
    const ids = Array.from({ length: 400 }, (_, index) => `m${index + 1}`);
    const oldRoot = "before-m261";
    const oldData = {
      rootCursor: oldRoot,
      pages: [page(ids.slice(160, 260), "before-m161"), page(ids.slice(60, 160), "before-m61")],
      pageParams: [oldRoot, "before-m161"],
    };

    const changed = reconcileSessionHistoryRoot(oldData, "before-m271");
    expect(changed.pages).toEqual([]);
    expect(changed.detached).toHaveLength(1);
    expect(resolveOlderHistoryCursor({
      initialPage: { olderCursor: "before-m271", hasOlder: true },
      pages: changed.pages,
      pageParams: changed.pageParams,
    }).cursor).toBe("before-m271");

    const bridged = appendSessionHistoryPage({
      data: changed,
      cursor: "before-m271",
      page: page(ids.slice(170, 270), "before-m171"),
    });
    expect(bridged.detached).toEqual([]);
    expect(mergeHistoricalSessionMessages(bridged.pages, ids.slice(270).map((id) => message(id))).map((item) => item.info.id))
      .toEqual(ids.slice(60));
    expect(resolveOlderHistoryCursor({
      initialPage: { olderCursor: "before-m271", hasOlder: true },
      pages: bridged.pages,
      pageParams: bridged.pageParams,
    }).cursor).toBe("before-m61");
  });

  test("keeps chronological order when a snapshot root moves backward across a detached generation", () => {
    const changed = reconcileSessionHistoryRoot({
      rootCursor: "old-root",
      pages: [withoutTimes(page(["m2", "m3", "m4"], "before-m2"))],
      pageParams: ["old-root"],
    }, "new-root");
    const bridged = appendSessionHistoryPage({
      data: changed,
      cursor: "new-root",
      page: withoutTimes(page(["m1", "m2", "m3"], "before-m1")),
    });

    expect(bridged.pages).toHaveLength(2);
    expect(mergeHistoricalSessionMessages(bridged.pages, [message("m4"), message("m5")])
      .map((item) => item.info.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(resolveOlderHistoryCursor({ initialPage: null, pages: bridged.pages, pageParams: bridged.pageParams }))
      .toEqual({ cursor: "before-m1", loopDetected: false });
  });

  test("does not duplicate an identical detached bridge page or its page parameter", () => {
    const changed = reconcileSessionHistoryRoot({
      rootCursor: "old-root",
      pages: [page(["m1", "m2"], null)],
      pageParams: ["old-root"],
    }, "new-root");
    const bridged = appendSessionHistoryPage({
      data: changed,
      cursor: "new-root",
      page: page(["m1", "m2"], null),
    });

    expect(bridged.pages).toHaveLength(1);
    expect(bridged.pageParams).toEqual(["new-root"]);
  });

  test("keeps a changed root detached when the new page does not overlap instead of inventing a gap", () => {
    const changed = reconcileSessionHistoryRoot({
      rootCursor: "old-root",
      pages: [page(["m1", "m2"], null)],
      pageParams: ["old-root"],
    }, "new-root");
    const unbridged = appendSessionHistoryPage({
      data: changed,
      cursor: "new-root",
      page: page(["m10", "m11"], "next-new"),
    });

    expect(mergeHistoricalSessionMessages(unbridged.pages, []).map((item) => item.info.id)).toEqual(["m10", "m11"]);
    expect(unbridged.detached?.[0]?.pages[0]?.items.map((item) => item.info.id)).toEqual(["m1", "m2"]);
  });

  test("stops self-referential and cyclic cursors without exposing cursor values", () => {
    expect(resolveOlderHistoryCursor({ initialPage: { olderCursor: "a", hasOlder: true }, pages: [], pageParams: [] }))
      .toEqual({ cursor: "a", loopDetected: false });
    expect(resolveOlderHistoryCursor({ initialPage: null, pages: [page(["m1"], "a")], pageParams: ["a"] }))
      .toEqual({ cursor: null, loopDetected: true });
    expect(resolveOlderHistoryCursor({ initialPage: null, pages: [page(["m2"], "b"), page(["m1"], "a")], pageParams: ["a", "b"] }))
      .toEqual({ cursor: null, loopDetected: true });
  });

  test("applies deletion and revert fences to retained historical pages", () => {
    const data = { pages: [page(["m3", "m4"], "older"), page(["m1", "m2"], null)], pageParams: ["newer", "older"] };
    const removed = removeMessageFromSessionHistory(data, "m2")!;
    expect(mergeHistoricalSessionMessages(removed.pages, []).map((item) => item.info.id)).toEqual(["m1", "m3", "m4"]);

    const reverted = applyRevertToSessionHistory(data, "m3")!;
    expect(mergeHistoricalSessionMessages(reverted.pages, []).map((item) => item.info.id)).toEqual(["m1", "m2"]);
    expect(applyRawMessageRevertCursor([message("m1"), message("m2"), message("m3")], "m2").map((item) => item.info.id))
      .toEqual(["m1"]);
    expect(applyRawMessageRevertCursor([message("m200"), message("m201")], "m100", true)).toEqual([]);
    expect(applyRevertToSessionHistory(data, "m0")).toBe(data);
  });

  test("keeps older pages when the authoritative revert cursor belongs to the current snapshot", () => {
    const data = { pages: [page(["m1", "m2"], null)], pageParams: ["older"], rootCursor: "root", detached: [] };
    const retained = applyRevertToSessionHistory(data, "m4")!;

    expect(retained).toBe(data);
    expect(mergeHistoricalSessionMessages(retained.pages, [message("m3"), message("m4"), message("m5")])
      .map((item) => item.info.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });
});
