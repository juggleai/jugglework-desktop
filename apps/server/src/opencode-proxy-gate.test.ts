import { describe, expect, test } from "bun:test";

import { assertOpencodeProxyAllowed } from "./server.js";
import { ApiError } from "./errors.js";
import type { Actor, TokenScope } from "./types.js";

const actor = (scope: TokenScope | undefined): Actor => ({ type: "remote", scope });

const PERMISSION_REPLY_PATH = "/opencode/permission/req_123/reply";

describe("assertOpencodeProxyAllowed", () => {
  test("collaborators must use the scoped interaction API for permission replies", () => {
    expect(() =>
      assertOpencodeProxyAllowed(actor("collaborator"), "POST", PERMISSION_REPLY_PATH),
    ).toThrow(ApiError);
  });

  test("owners cannot bypass the scoped interaction API", () => {
    expect(() =>
      assertOpencodeProxyAllowed(actor("owner"), "POST", PERMISSION_REPLY_PATH),
    ).toThrow(ApiError);
  });

  test("viewers cannot send any mutating request", () => {
    expect(() =>
      assertOpencodeProxyAllowed(actor("viewer"), "POST", PERMISSION_REPLY_PATH),
    ).toThrow(ApiError);
    expect(() =>
      assertOpencodeProxyAllowed(actor("viewer"), "POST", "/opencode/session/s1/command"),
    ).toThrow(ApiError);
  });

  test("permission and question reads also use scoped APIs", () => {
    expect(() =>
      assertOpencodeProxyAllowed(actor("viewer"), "GET", "/opencode/permission"),
    ).toThrow(ApiError);
    expect(() =>
      assertOpencodeProxyAllowed(actor("owner"), "GET", "/opencode/question"),
    ).toThrow(ApiError);
  });

  test("missing scope defaults to viewer (read-only)", () => {
    expect(() =>
      assertOpencodeProxyAllowed(actor(undefined), "POST", PERMISSION_REPLY_PATH),
    ).toThrow(ApiError);
    expect(() =>
      assertOpencodeProxyAllowed(actor(undefined), "GET", "/opencode/permission"),
    ).toThrow(ApiError);
  });

  test("provider auth mutations cannot bypass host-authorized routes", () => {
    for (const scope of ["owner", "collaborator"] as const) {
      expect(() =>
        assertOpencodeProxyAllowed(actor(scope), "PUT", "/opencode/auth/openai"),
      ).toThrow(ApiError);
      expect(() =>
        assertOpencodeProxyAllowed(actor(scope), "DELETE", "/auth/openai"),
      ).toThrow(ApiError);
    }

    expect(() =>
      assertOpencodeProxyAllowed(actor("owner"), "GET", "/opencode/auth/openai"),
    ).not.toThrow();
  });
});
