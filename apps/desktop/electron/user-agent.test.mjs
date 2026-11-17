import assert from "node:assert/strict";
import test from "node:test";

import { applyAsciiUserAgentFallback, USER_AGENT_APP_TOKEN } from "./user-agent.mjs";

function fakeApp(initial, version = "1.2.38") {
  return {
    userAgentFallback: initial,
    getVersion: () => version,
  };
}

test("uses an ASCII app token in navigator.appVersion", () => {
  const app = fakeApp(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) 北数Work/1.2.38 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36",
  );
  const ua = applyAsciiUserAgentFallback(app);
  assert.equal(USER_AGENT_APP_TOKEN, "beishuwork");
  assert.ok(ua.includes("beishuwork/1.2.38"));
  assert.ok(!ua.includes("北数Work"));
  assert.ok(ua.startsWith("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) beishuwork/1.2.38 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36"));
});

test("also replaces the dev name that contains spaces", () => {
  const app = fakeApp(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) 北数Work - Dev/1.2.38 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36",
  );
  const ua = applyAsciiUserAgentFallback(app);
  assert.ok(ua.includes(") beishuwork/1.2.38 Chrome/"));
  assert.ok(!ua.includes("北数Work"));
});

test("builds a platform UA when Electron has no fallback yet", () => {
  const mac = applyAsciiUserAgentFallback(fakeApp(""), {
    platform: "darwin",
    chromeVersion: "140.0.0.0",
    electronVersion: "38.0.0",
  });
  assert.ok(mac.includes("Macintosh; Intel Mac OS X 10_15_7"));
  assert.ok(mac.includes("beishuwork/1.2.38"));

  const linux = applyAsciiUserAgentFallback(fakeApp(""), {
    platform: "linux",
    chromeVersion: "140.0.0.0",
    electronVersion: "38.0.0",
  });
  assert.ok(linux.includes("X11; Linux x86_64"));
});

test("is idempotent", () => {
  const app = fakeApp(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) JuggleWork/1.2.38 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36",
  );
  const first = applyAsciiUserAgentFallback(app);
  const second = applyAsciiUserAgentFallback(app);
  assert.equal(second, first);
  assert.ok(first.includes("beishuwork/1.2.38"));
});
