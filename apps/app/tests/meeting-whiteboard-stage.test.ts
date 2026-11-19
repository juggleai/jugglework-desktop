import { expect, test } from "bun:test";
import { whiteboardPageUrl } from "../src/react-app/domains/meeting/meeting-whiteboard-stage";

test("whiteboard page resolves from the app root, not the current route", () => {
  expect(whiteboardPageUrl("http://localhost:5173/#/session", "/")).toBe("http://localhost:5173/whiteboard.html");
  expect(whiteboardPageUrl("http://localhost:5173/tests/fixtures/x/index.html", "/")).toBe("http://localhost:5173/whiteboard.html");
  expect(whiteboardPageUrl("file:///Applications/JuggleWork.app/Contents/Resources/app-dist/index.html#/session", "./"))
    .toBe("file:///Applications/JuggleWork.app/Contents/Resources/app-dist/whiteboard.html");
});
