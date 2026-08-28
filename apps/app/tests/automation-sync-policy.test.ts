import { describe, expect, test } from "bun:test";
import type { AutomationStableEnvelope } from "@jugglework/types/automation";
import { negotiateAutomationSync } from "../src/react-app/domains/automations/automation-sync-policy";

const envelope: AutomationStableEnvelope = {
  envelopeVersion: 1,
  documentSchema: "automation-definition/v99",
  documentMediaType: "application/json",
  documentBase64: "e30=",
  documentDigest: "digest",
  projections: [
    { kind: "automation-display", version: 1, mediaType: "application/json", payloadBase64: "e30=", digest: "display" },
    { kind: "automation-connector-policy", version: 1, mediaType: "application/json", payloadBase64: "e30=", digest: "policy" },
  ],
};

describe("automation cloud capability negotiation", () => {
  test("treats unknown document schemas independently from the stable envelope", () => {
    expect(negotiateAutomationSync({
      envelopeVersions: [1],
      documentMediaTypes: ["application/json"],
      projections: { "automation-display": [1], "automation-connector-policy": [1] },
      limits: {},
    }, envelope)).toEqual({
      storageSupported: true,
      displayProjectionSupported: true,
      connectorPolicySupported: true,
    });
  });

  test("allows opaque storage when only optional projection semantics are unknown", () => {
    expect(negotiateAutomationSync({
      envelopeVersions: [1],
      documentMediaTypes: ["application/json"],
      projections: {},
      limits: {},
    }, envelope)).toEqual({
      storageSupported: true,
      displayProjectionSupported: false,
      connectorPolicySupported: false,
    });
  });

  test("blocks upload when the stable storage envelope itself is unsupported", () => {
    expect(negotiateAutomationSync({
      envelopeVersions: [2],
      documentMediaTypes: ["application/json"],
      projections: {},
      limits: {},
    }, envelope)).toMatchObject({
      storageSupported: false,
      errorCode: "automation_projection_unsupported",
    });
  });
});
