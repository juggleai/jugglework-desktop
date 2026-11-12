import assert from "node:assert/strict";
import test from "node:test";

import { createMeetingPermissionRequester, installMediaPermissionHandlers } from "./media-permissions.mjs";

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

test("checking readiness is silent and concurrent first-use prompts share the native result", async () => {
  let status = "not-determined";
  let prompts = 0;
  /** @type {(granted: boolean) => void} */
  let accept = () => assert.fail("native prompt did not start");
  const request = createMeetingPermissionRequester("darwin", {
    getMediaAccessStatus: () => status,
    askForMediaAccess: () => { prompts++; return new Promise(resolve => { accept = resolve; }); },
  }, assert.fail);
  assert.equal((await request("camera", false)).granted, false);
  assert.equal(prompts, 0);
  const a = request("camera");
  const b = request("camera");
  assert.equal(prompts, 1);
  status = "granted";
  accept(true);
  assert.equal((await a).newlyGranted, true);
  assert.deepEqual(await b, await a);
  assert.deepEqual(await request("camera"), { granted: true, status: "granted" });
});

test("screen preflight denial still allows a first native request, without prompting on refresh", async () => {
  let prompts = 0;
  let status = "denied";
  const request = createMeetingPermissionRequester("darwin", {
    getMediaAccessStatus: () => status, askForMediaAccess: assert.fail,
  }, async () => { prompts++; });
  await request("screen", false);
  assert.equal(prompts, 0);
  assert.equal((await request("screen")).granted, false);
  assert.equal((await request("screen")).granted, false);
  assert.equal(prompts, 1);
  status = "granted";
  assert.equal((await request("screen")).granted, true);
  assert.equal(prompts, 1);
});

test("denied devices and Windows desktop privacy settings never invoke the macOS prompt", async () => {
  for (const platform of ["darwin", "win32"]) {
    for (const status of ["restricted", "denied"]) {
      const request = createMeetingPermissionRequester(platform, { getMediaAccessStatus: () => status, askForMediaAccess: assert.fail }, assert.fail);
      assert.equal((await request("microphone")).granted, false);
      await assert.rejects(request("unexpected"), /无效权限/);
    }
  }
});
