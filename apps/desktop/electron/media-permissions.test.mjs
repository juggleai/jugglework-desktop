import assert from "node:assert/strict";
import test from "node:test";

import { installMediaPermissionHandlers } from "./media-permissions.mjs";

function setup() {
  /** @type {(...args: any[]) => any} */
  let requestHandler = () => { throw new Error("permission request handler was not installed"); };
  /** @type {(...args: any[]) => any} */
  let checkHandler = () => { throw new Error("permission check handler was not installed"); };
  const mainWindow = { webContents: { id: 7 } };
  installMediaPermissionHandlers({
    defaultSession: {
      setPermissionRequestHandler(handler) {
        requestHandler = handler;
      },
      setPermissionCheckHandler(handler) {
        checkHandler = handler;
      },
    },
  }, () => mainWindow);
  return { checkHandler, mainWindow, requestHandler };
}

test("allows local audio capture only from the main window", () => {
  const { checkHandler, mainWindow } = setup();
  assert.equal(checkHandler(mainWindow.webContents, "audioCapture", "http://127.0.0.1:5173", { mediaType: "audio" }), true);
  assert.equal(checkHandler({ id: 8 }, "audioCapture", "http://127.0.0.1:5173", { mediaType: "audio" }), false);
  assert.equal(checkHandler(mainWindow.webContents, "audioCapture", "https://example.com", { mediaType: "audio" }), false);
});

test("allows audio-only media requests and rejects video", () => {
  const { mainWindow, requestHandler } = setup();
  let allowed = null;
  requestHandler(mainWindow.webContents, "media", (value) => { allowed = value; }, {
    requestingUrl: "file://",
    mediaTypes: ["audio"],
  });
  assert.equal(allowed, true);

  requestHandler(mainWindow.webContents, "media", (value) => { allowed = value; }, {
    requestingUrl: "file://",
    mediaTypes: ["audio", "video"],
  });
  assert.equal(allowed, false);

  requestHandler(mainWindow.webContents, "media", (value) => { allowed = value; }, {
    requestingUrl: "file://",
    mediaType: "video",
  });
  assert.equal(allowed, false);
});
