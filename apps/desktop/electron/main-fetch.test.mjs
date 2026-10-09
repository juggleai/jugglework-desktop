import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isLoopbackHttpUrl, selectMainProcessFetch } from "./main-fetch.mjs";

describe("main-process fetch transport", () => {
  it("recognizes supported loopback HTTP URLs", () => {
    assert.equal(isLoopbackHttpUrl("http://127.0.0.1:53078/workspaces"), true);
    assert.equal(isLoopbackHttpUrl("http://localhost:53078/health"), true);
    assert.equal(isLoopbackHttpUrl("http://[::1]:53078/health"), true);
    assert.equal(isLoopbackHttpUrl("https://work.juggle.im/api"), false);
    assert.equal(isLoopbackHttpUrl("not a url"), false);
  });

  it("uses Node fetch for loopback and Electron fetch for external URLs", () => {
    const nodeFetch = () => "node";
    const electronFetch = () => "electron";

    assert.equal(
      selectMainProcessFetch("http://127.0.0.1:53078/health", { nodeFetch, electronFetch }),
      nodeFetch,
    );
    assert.equal(
      selectMainProcessFetch("https://work.juggle.im/api", { nodeFetch, electronFetch }),
      electronFetch,
    );
  });
});
