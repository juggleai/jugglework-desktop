import { describe, expect, test } from "bun:test";

import { digestGatewayCredential } from "../src/react-app/domains/connections/provider-auth/gateway-credential-digest";

describe("gateway credential digest", () => {
  test("matches the server SHA-256 hex digest without exposing the token", async () => {
    expect(await digestGatewayCredential("jwgw_test_credential")).toBe(
      "64e306c5c9e786508d9febea67186fb6b931e34126258b581e45f1295ae31a2e",
    );
  });

  test("rejects a vendor credential on the gateway recovery path", async () => {
    expect(digestGatewayCredential("sk-not-a-gateway-token")).rejects.toThrow(
      "not a JuggleWork gateway credential",
    );
  });
});
