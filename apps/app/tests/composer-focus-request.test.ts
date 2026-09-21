import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  COMPOSER_FOCUS_REQUEST_EVENT,
  cancelComposerFocusRequest,
  completeComposerFocusRequest,
  getPendingComposerFocusRequest,
  requestComposerFocus,
  type ComposerFocusRequest,
} from "../src/react-app/domains/session/surface/composer/focus-request";

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
const fakeWindow = new EventTarget() as EventTarget & Pick<Window, "setTimeout" | "clearTimeout">;
fakeWindow.setTimeout = globalThis.setTimeout.bind(globalThis) as typeof window.setTimeout;
fakeWindow.clearTimeout = globalThis.clearTimeout.bind(globalThis) as typeof window.clearTimeout;

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: fakeWindow,
});
beforeEach(() => {
  cancelComposerFocusRequest();
});

afterAll(() => {
  cancelComposerFocusRequest();
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("composer focus requests", () => {
  test("replaces an older session request with the latest navigation", () => {
    const first = requestComposerFocus("session-a", "session-switch");
    const second = requestComposerFocus("session-b", "session-switch");

    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
    expect(getPendingComposerFocusRequest()?.sessionId).toBe("session-b");
  });

  test("publishes the target session and completes only from that composer", () => {
    let detail: ComposerFocusRequest | null = null;
    const onRequest = (event: Event) => {
      detail = (event as CustomEvent<ComposerFocusRequest>).detail;
    };
    fakeWindow.addEventListener(COMPOSER_FOCUS_REQUEST_EVENT, onRequest, { once: true });

    const requestId = requestComposerFocus("session-target", "model-picker");

    expect(detail?.sessionId).toBe("session-target");
    expect(completeComposerFocusRequest(requestId!, "session-other")).toBeFalse();
    expect(getPendingComposerFocusRequest()?.id).toBe(requestId);
    expect(completeComposerFocusRequest(requestId!, "session-target")).toBeTrue();
    expect(getPendingComposerFocusRequest()).toBeNull();
  });

  test("cancels delayed focus when the user makes a newer pointer gesture", () => {
    requestComposerFocus("session-a", "session-switch");
    fakeWindow.dispatchEvent(new Event("pointerdown"));

    expect(getPendingComposerFocusRequest()).toBeNull();
  });
});
