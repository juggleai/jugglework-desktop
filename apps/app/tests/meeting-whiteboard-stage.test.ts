import { expect, test } from "bun:test";
import { whiteboardPageUrl } from "../src/react-app/domains/meeting/meeting-whiteboard-stage";
import { MeetingWhiteboardStage } from "../src/react-app/domains/meeting/meeting-whiteboard-stage";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

test("whiteboard page resolves from the app root, not the current route", () => {
  expect(whiteboardPageUrl("http://localhost:5173/#/session", "/")).toBe("http://localhost:5173/whiteboard.html");
  expect(whiteboardPageUrl("http://localhost:5173/tests/fixtures/x/index.html", "/")).toBe("http://localhost:5173/whiteboard.html");
  expect(whiteboardPageUrl("file:///Applications/JuggleWork.app/Contents/Resources/app-dist/index.html#/session", "./"))
    .toBe("file:///Applications/JuggleWork.app/Contents/Resources/app-dist/whiteboard.html");
});

test("independent host uses the app URL, preserves its iframe across theme updates and flushes before removal", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const session = { meetingId: "meeting", whiteboardId: "board", title: "Board", scene: null };
  const frame = { src: "", __juggleworkWhiteboard: undefined as any };
  let flushes = 0, mounts = 0;
  const publish = async () => {};
  const props = { session, theme: "light" as "light" | "dark", onPublish: publish, onFail: () => {}, pageBaseURI: "http://localhost:5173/index.html" };
  let view!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => { view = TestRenderer.create(createElement(MeetingWhiteboardStage, props), {
      createNodeMock: () => { mounts++; return frame; },
    }); });
    expect(frame.src).toBe("http://localhost:5173/whiteboard.html");
    const bridge = frame.__juggleworkWhiteboard;
    bridge.setFlush(() => { flushes++; });
    const style = view.root.findByType("iframe").props.style;
    expect(style).toMatchObject({ width: "100%", height: "100%", border: 0 });
    await act(async () => { view.update(createElement(MeetingWhiteboardStage, { ...props, theme: "dark" })); });
    expect(frame.__juggleworkWhiteboard).toBe(bridge);
    expect(mounts).toBe(1);
    expect(flushes).toBe(0);
    expect(bridge.publish({} as MediaStream)).toBeInstanceOf(Promise);
  } finally {
    await act(async () => { view?.unmount(); });
  }
  expect(flushes).toBe(1);
});
