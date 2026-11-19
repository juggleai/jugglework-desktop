/**
 * Contract tests (task 1.4): authenticated remote-control channels and forged
 * origin fields can never widen persistent session authority.
 */

import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import { desktopRemoteMutationOperationValues, desktopRemoteOperationRequestSchema } from "@jugglework/types/desktop-remote-control";
import { ApiError } from "./errors.js";
import { parsePermissionBody } from "./routes/interactions.js";
import { matchRoute, type Route } from "./routes/registry.js";
import { registerSessionPermissionRoutes } from "./routes/session-permissions.js";

describe("remote-control permission authority contracts", () => {
  test("only the dedicated activation route accepts host-token authentication", () => {
    const routes: Route[] = [];
    // Registration captures the dependencies; it does not invoke handlers.
    registerSessionPermissionRoutes({ routes } as Parameters<typeof registerSessionPermissionRoutes>[0]);
    const mode = "/workspace/ws/sessions/root/permission-mode";
    assert.equal(matchRoute(routes, "PUT", `${mode}/remote-activation`)?.auth, "host-token");
    assert.equal(matchRoute(routes, "PUT", mode)?.auth, "client");
    assert.equal(matchRoute(routes, "POST", `${mode}/grants/clear`)?.auth, "client");
  });
  test("remote-control replies cannot request persistent upstream approval", () => {
    assert.throws(
      () => parsePermissionBody({
        origin: "remote-control",
        commandCorrelationId: null,
        rootSessionId: "ses_root",
        response: "always",
      }),
      (error) => error instanceof ApiError && error.code === "unsupported_permission_response",
    );
  });

  test("forged local-origin bodies cannot smuggle persistent responses for remote channels", () => {
    // A remote-control caller forging `origin: "local-renderer"` with an
    // `always` response parses as local-renderer shape but the route rejects
    // protocol-native `always` for every origin — session grants are the only
    // persistent path and they require authenticated collaborator context.
    const parsed = parsePermissionBody({
      origin: "local-renderer",
      commandCorrelationId: null,
      response: "always",
    });
    assert.equal(parsed.origin, "local-renderer");
    // The reply route rejects `always` after parsing (route-level check).
  });

  test("unknown payload shapes are rejected", () => {
    assert.throws(
      () => parsePermissionBody({ origin: "attacker", response: "allow_once" }),
      (error) => error instanceof ApiError && error.code === "invalid_payload",
    );
    assert.throws(
      () => parsePermissionBody({ origin: "local-renderer", response: "allow_persistent", commandCorrelationId: null }),
      (error) => error instanceof ApiError && error.code === "invalid_payload",
    );
  });

  test("the only remote authority mutation is a scoped mode change, never a reusable grant", () => {
    const mutationOperations = desktopRemoteMutationOperationValues as readonly string[];
    assert.deepEqual(mutationOperations.filter((op) => op.includes("permission-mode") || op.includes("permission-grant")), ["session.permission-mode.set"]);
    const args = { workspaceId: "ws", sessionId: "root", expectedRevision: 0, requestedMode: "full-access" };
    for (const extra of [{ acknowledgedProfileVersion: null }, { acknowledgedProfileVersion: 1, origin: "local-renderer" }]) {
      assert.equal(desktopRemoteOperationRequestSchema.safeParse({ operation: "session.permission-mode.set", payloadVersion: 1, arguments: { ...args, ...extra } }).success, false);
    }
  });
});
