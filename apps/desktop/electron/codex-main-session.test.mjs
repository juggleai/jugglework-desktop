import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCodexMainSession } from "./codex-main-session.mjs";

describe("Codex Main session", () => {
  it("keeps the login credential only in its private getter and returns safe status", () => {
    const session = createCodexMainSession();
    const transition = session.sync({ baseUrl: "https://work.example.test", bearerToken: "login-secret", organizationId: "org_1" });
    assert.deepEqual(transition, { previousOrganizationId: null, organizationId: "org_1", authenticated: true });
    assert.equal(session.get().bearerToken, "login-secret");
    assert.deepEqual(session.status(), { authenticated: true, organizationId: "org_1" });
    assert.doesNotMatch(JSON.stringify(session.status()), /login-secret|work\.example/);
    assert.deepEqual(session.sync(null), { previousOrganizationId: "org_1", organizationId: null, authenticated: false });
  });

  it("rejects insecure non-loopback endpoints", () => {
    const session = createCodexMainSession();
    assert.deepEqual(session.sync({ baseUrl: "http://work.example.test", bearerToken: "token", organizationId: "org" }), {
      previousOrganizationId: null, organizationId: null, authenticated: false,
    });
  });
});
