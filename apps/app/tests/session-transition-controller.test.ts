import { describe, expect, test } from "bun:test";
import { deriveSessionRenderModel } from "../src/react-app/domains/session/sync/transition-controller";

describe("session transition controller", () => {
  test("keeps a rendered target session interactive during background refresh", () => {
    expect(deriveSessionRenderModel({
      intendedSessionId: "session-a",
      renderedSessionId: "session-a",
      hasSnapshot: true,
      isFetching: true,
      isError: false,
    })).toEqual({
      intendedSessionId: "session-a",
      renderedSessionId: "session-a",
      transitionState: "idle",
      renderSource: "cache",
    });
  });

  test("still reports switching while the target session has no renderable state", () => {
    expect(deriveSessionRenderModel({
      intendedSessionId: "session-b",
      renderedSessionId: null,
      hasSnapshot: false,
      isFetching: true,
      isError: false,
    }).transitionState).toBe("switching");
  });

  test("does not expose a different rendered session as ready", () => {
    expect(deriveSessionRenderModel({
      intendedSessionId: "session-b",
      renderedSessionId: "session-a",
      hasSnapshot: true,
      isFetching: true,
      isError: false,
    }).transitionState).toBe("switching");
  });
});
