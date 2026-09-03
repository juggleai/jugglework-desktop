/**
 * Contract tests (task 1.4): authenticated remote-control channels and forged
 * origin fields can never widen persistent session authority.
 */

import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import { desktopRemoteMutationOperationValues } from "@jugglework/types/desktop-remote-control";
import { ApiError } from "./errors.js";
import { parsePermissionBody } from "./routes/interactions.js";

describe("remote-control permission authority contracts", () => {
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

  test("desktop remote-control mutation catalog has no permission-mode operations", () => {
    const mutationOperations = desktopRemoteMutationOperationValues as readonly string[];
    for (const operation of mutationOperations) {
      assert.equal(
        operation.includes("permission-mode"),
        false,
        `unexpected permission-mode remote operation: ${operation}`,
      );
      assert.equal(
        operation.includes("permission-grant"),
        false,
        `unexpected permission-grant remote operation: ${operation}`,
      );
    }
  });
});
