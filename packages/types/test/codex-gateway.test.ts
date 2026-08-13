import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  CODEX_GATEWAY_AUDIENCE,
  codexGatewayAuditEventSchema,
  codexGatewayErrorSchema,
  codexGatewayModelSchema,
  codexGatewayTokenRequestSchema,
  codexGatewayTokenResponseSchema,
} from "../src/den/codex-gateway.ts"

describe("Codex gateway contracts", () => {
  test("binds a token exchange to an organization, device and provider", () => {
    assert.deepEqual(codexGatewayTokenRequestSchema.parse({
      organizationId: "org_1",
      deviceId: "device_1",
      providerId: "lpr_jugglerouter",
    }), {
      organizationId: "org_1",
      deviceId: "device_1",
      providerId: "lpr_jugglerouter",
    })
  })

  test("accepts a short-lived scoped response without exposing login credentials", () => {
    const value = codexGatewayTokenResponseSchema.parse({
      accessToken: "short-lived-token",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      organizationId: "org_1",
      deviceId: "device_1",
      audience: CODEX_GATEWAY_AUDIENCE,
      scopes: ["responses:create", "models:read"],
      gatewayBaseUrl: "https://gateway.example.test/v1",
    })
    assert.equal("loginToken" in value, false)
    assert.equal("apiKey" in value, false)
  })

  test("rejects expired, mismatched-audience and insecure remote responses", () => {
    const base = {
      accessToken: "token",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      organizationId: "org_1",
      deviceId: "device_1",
      audience: CODEX_GATEWAY_AUDIENCE,
      scopes: ["responses:create"],
      gatewayBaseUrl: "https://gateway.example.test/v1",
    }
    assert.equal(codexGatewayTokenResponseSchema.safeParse({ ...base, expiresAt: "2020-01-01T00:00:00.000Z" }).success, false)
    assert.equal(codexGatewayTokenResponseSchema.safeParse({ ...base, audience: "another-service" }).success, false)
    assert.equal(codexGatewayTokenResponseSchema.safeParse({ ...base, gatewayBaseUrl: "http://gateway.example.test/v1" }).success, false)
  })

  test("describes image, tool and reasoning capabilities explicitly", () => {
    assert.equal(codexGatewayModelSchema.parse({
      id: "gpt-5.6-terra",
      displayName: "GPT-5.6 Terra",
      enabled: true,
      capabilities: {
        images: true,
        tools: true,
        reasoning: true,
        reasoningEfforts: ["low", "medium", "high"],
      },
    }).capabilities.images, true)
    assert.equal(codexGatewayModelSchema.safeParse({
      id: "text-only",
      displayName: "Text only",
      enabled: true,
      capabilities: { images: false, tools: false, reasoning: false, reasoningEfforts: ["low"] },
    }).success, false)
  })

  test("keeps errors and audit records structured and content-free", () => {
    const error = codexGatewayErrorSchema.parse({
      error: { code: "RATE_LIMITED", message: "Try again later", retryable: true, retryAfterMs: 1000 },
    })
    assert.equal(error.error.requestId, null)
    const audit = codexGatewayAuditEventSchema.parse({
      organizationId: "org_1",
      deviceId: "device_1",
      operation: "responses.create",
      outcome: "allowed",
      errorCode: null,
      requestId: "req_1",
      occurredAt: new Date().toISOString(),
    })
    assert.equal("prompt" in audit, false)
    assert.equal("response" in audit, false)
    assert.equal("credential" in audit, false)
  })
})
