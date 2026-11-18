import assert from "node:assert/strict";
import test from "node:test";
import { resolveDesktopProtocolRegistration } from "./desktop-protocol.mjs";

test("packaged builds register the release scheme", () => {
  assert.deepEqual(resolveDesktopProtocolRegistration({ isPackaged: true, env: {} }), { scheme: "jugglework" });
});

test("packaged builds honor the registration opt-out", () => {
  assert.equal(
    resolveDesktopProtocolRegistration({ isPackaged: true, env: { JUGGLEWORK_ELECTRON_DISABLE_PROTOCOL_REGISTRATION: "1" } }),
    null,
  );
});

test("source dev builds never claim the release scheme", () => {
  assert.equal(resolveDesktopProtocolRegistration({ isPackaged: false, env: {} }), null);
  assert.equal(
    resolveDesktopProtocolRegistration({ isPackaged: false, env: { JUGGLEWORK_DESKTOP_AUTH_SCHEME: "jugglework" } }),
    null,
  );
});

test("source dev builds register an isolated dev scheme even when release registration is disabled", () => {
  assert.deepEqual(
    resolveDesktopProtocolRegistration({
      isPackaged: false,
      env: { JUGGLEWORK_DESKTOP_AUTH_SCHEME: "jugglework-dev", JUGGLEWORK_ELECTRON_DISABLE_PROTOCOL_REGISTRATION: "1" },
    }),
    { scheme: "jugglework-dev" },
  );
});

test("malformed dev schemes are ignored", () => {
  for (const value of ["jugglework-dev://x", "https", "Other"]) {
    assert.equal(resolveDesktopProtocolRegistration({ isPackaged: false, env: { JUGGLEWORK_DESKTOP_AUTH_SCHEME: value } }), null);
  }
});
