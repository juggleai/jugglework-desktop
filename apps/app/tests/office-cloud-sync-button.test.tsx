import * as React from "react";
import { expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { FileWindowCloudSyncAction } from "../src/react-app/domains/session/office/file-window-cloud-sync-action";
import { t } from "../src/i18n";

test("独立窗口云端图标跟随真实关联变化，提示与点击目标一致，卸载后取消订阅", async () => {
  const previous = Reflect.get(globalThis, "window");
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  let status = "active", notify: ((value: { documentId: string | null }) => void) | undefined;
  const opened: string[] = [];
  Reflect.set(globalThis, "window", { __JUGGLEWORK_ELECTRON__: { fileWindow: {
    cloudSyncState: async (documentId: string) => { expect(documentId).toBe("word"); return { status }; },
    openCloudDocument: async (documentId: string) => { opened.push(documentId); },
    action: async () => { opened.push("workspace"); },
    onCloudSyncChanged: (callback: typeof notify) => { notify = callback; return () => { notify = undefined; }; },
  } } });
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => { view = create(<FileWindowCloudSyncAction documentId="word" canOpenSession />); });
    const button = () => view!.root.findByType("button");
    expect(button().props.title).toBe(t("cloud_docs.word_sync_active"));
    expect(button().children.some(child => typeof child === "string")).toBe(false);
    button().props.onClick();
    expect(opened).toEqual(["word"]);
    status = "detached";
    await act(async () => { notify?.({ documentId: "word" }); });
    expect(button().props.title).toBe(t("cloud_docs.word_sync_window_inactive"));
    expect(button().props["data-office-cloud-sync"]).toBe("detached");
    button().props.onClick();
    expect(opened).toEqual(["word", "workspace"]);
  } finally {
    if (view) await act(async () => { view!.unmount(); });
    expect(notify).toBeUndefined();
    Reflect.set(globalThis, "window", previous);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});
