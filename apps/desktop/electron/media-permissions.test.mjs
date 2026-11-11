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

test("allows audio and video from the trusted main window", () => {
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
  assert.equal(allowed, true);

  requestHandler(mainWindow.webContents, "media", (value) => { allowed = value; }, {
    requestingUrl: "file://",
    mediaType: "video",
  });
  assert.equal(allowed, true);
});

 test("rejects camera requests from remote content and other windows", () => {
 const { mainWindow, requestHandler } = setup();
 for (const [sender, url] of [[{id:8}, "file://"], [mainWindow.webContents, "https://example.com"]]) {
 let allowed;
 requestHandler(sender,"media",value=>{allowed=value},{requestingUrl:url,mediaTypes:["video"]});
 assert.equal(allowed,false);
 }
 });

test("meeting child may share its display but cannot request camera or grant remote access", () => {
  /** @type {(...args: any[]) => any} */
  let check = () => { throw new Error("not installed"); };
  /** @type {(...args: any[]) => any} */
  let request = () => { throw new Error("not installed"); };
  const main = {webContents: {id: 7}};
  const child = {webContents: {id: 9}};
  installMediaPermissionHandlers({defaultSession:{
    setPermissionCheckHandler(handler){check=handler;},
    setPermissionRequestHandler(handler){request=handler;},
  }},()=>main,()=>child);
  for (const origin of ["about:blank", "null", "http://localhost:5173"]) {
    assert.equal(check(child.webContents,"display-capture",origin,{}),true);
  }
  assert.equal(check(child.webContents,"media","about:blank",{mediaType:"video"}),false);
  assert.equal(check(child.webContents,"display-capture","https://example.com",{}),false);
  assert.equal(check({id:10},"display-capture","about:blank",{}),false);
  let allowed;
  request(child.webContents,"display-capture",value=>allowed=value,{requestingUrl:"about:blank",mediaTypes:["video"]});
  assert.equal(allowed,true);
});

test("legacy screen capture requests are accepted only for trusted top-level windows", () => {
  /** @type {(...args: any[]) => any} */
  let request = () => { throw new Error("not installed"); };
  /** @type {(...args: any[]) => any} */
  let check = () => { throw new Error("not installed"); };
  const main = { webContents: { id: 7 } };
  const child = { webContents: { id: 9 } };
  installMediaPermissionHandlers({ defaultSession: {
    setPermissionCheckHandler(handler) { check = handler; },
    setPermissionRequestHandler(handler) { request = handler; },
  } }, () => main, () => child);
  const ask = (sender, details) => {
    let allowed;
    request(sender, "media", value => { allowed = value; }, details);
    return allowed;
  };
  const legacy = { isMainFrame: true, mediaTypes: [], requestingUrl: "about:blank", securityOrigin: "http://localhost:5173/" };
  assert.equal(ask(child.webContents, legacy), true);
  assert.equal(ask(main.webContents, { ...legacy, requestingUrl: "http://localhost:5173/" }), true);
  assert.equal(ask(child.webContents, { ...legacy, securityOrigin: "file://" }), true);
  for (const patch of [
    { isMainFrame: false }, { isMainFrame: undefined }, { mediaTypes: undefined },
    { mediaTypes: ["video"] }, { mediaTypes: ["audio"] }, { mediaType: "video" },
    { requestingUrl: "https://example.com" }, { securityOrigin: "https://example.com" },
  ]) assert.equal(ask(child.webContents, { ...legacy, ...patch }), false);
  assert.equal(ask({ id: 10 }, legacy), false);
  assert.equal(check(child.webContents, "media", "http://localhost:5173/", { isMainFrame: true }), false);
  assert.equal(check(child.webContents, "display-capture", "http://localhost:5173/", { isMainFrame: false }), false);
});
