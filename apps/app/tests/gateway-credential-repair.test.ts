import { describe, expect, test } from "bun:test";
import type { CloudImportedProvider } from "../src/app/cloud/import-state";

import {
  gatewayCredentialRepairRequestFromError,
  requestGatewayCredentialRepair,
  resolveGatewayCredentialRepairTarget,
  subscribeGatewayCredentialRepair,
} from "../src/react-app/domains/connections/provider-auth/gateway-credential-repair";

const importedProvider = (
  cloudProviderId: string,
  providerId: string,
): CloudImportedProvider => ({
  cloudProviderId,
  providerId,
  sourceProviderId: providerId,
  name: providerId,
  source: "jugglework",
  updatedAt: null,
  modelIds: [],
  importedAt: 1,
  metadataVersion: 1,
  organizationId: "org_test",
  gatewayMirror: null,
});

const gatewayError = {
  name: "APIError",
  data: {
    statusCode: 401,
    providerID: "lpr_managed",
    responseBody: JSON.stringify({
      error: {
        code: "unauthorized",
        message: "The gateway credential is missing, revoked, or expired.",
        type: "unauthorized",
      },
    }),
  },
};

describe("gateway credential repair", () => {
  test("turns only a gateway credential 401 into a scoped repair request", () => {
    expect(gatewayCredentialRepairRequestFromError({
      workspaceId: "ws_test",
      sessionId: "ses_test",
      error: gatewayError,
    })).toEqual({
      workspaceId: "ws_test",
      sessionId: "ses_test",
      providerId: "lpr_managed",
    });

    expect(gatewayCredentialRepairRequestFromError({
      workspaceId: "ws_test",
      sessionId: "ses_test",
      error: { statusCode: 401, message: "Invalid API key", providerID: "openai" },
    })).toBeNull();
  });

  test("hands a repair request to the renderer provider owner", () => {
    const requests: unknown[] = [];
    const unsubscribe = subscribeGatewayCredentialRepair((request) => requests.push(request));
    try {
      const request = gatewayCredentialRepairRequestFromError({
        workspaceId: "ws_test",
        sessionId: "ses_test",
        error: gatewayError,
      });
      expect(request).not.toBeNull();
      requestGatewayCredentialRepair(request!);
      expect(requests).toEqual([request]);
    } finally {
      unsubscribe();
    }
  });

  test("repairs only the matching cloud import, with a safe single-provider fallback", () => {
    const managed = importedProvider("cloud_managed", "lpr_managed");
    const other = importedProvider("cloud_other", "lpr_other");

    expect(resolveGatewayCredentialRepairTarget({ cloud_managed: managed }, "lpr_managed"))
      .toBe(managed);
    expect(resolveGatewayCredentialRepairTarget({ cloud_managed: managed }, null))
      .toBe(managed);
    expect(resolveGatewayCredentialRepairTarget({
      cloud_managed: managed,
      cloud_other: other,
    }, null)).toBeNull();
    expect(resolveGatewayCredentialRepairTarget({ cloud_managed: managed }, "openai"))
      .toBeNull();
  });
});
