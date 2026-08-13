import { describe, expect, test } from "bun:test";

import {
  composeDiagnosticsBundleJson,
  type DiagnosticsBundleInputs,
} from "../src/app/lib/diagnostics-bundle";
import { CLAUDE_ADVANCED_FEATURES } from "@jugglework/types/agent-runtime";

function baseInputs(): DiagnosticsBundleInputs {
  return {
    capturedAt: "2026-07-06T00:00:00.000Z",
    desktopRuntime: false,
    appInfo: null,
    engineInfo: null,
    juggleworkServerSettings: {},
    hostInfo: null,
    developerLogs: [],
    perfLogs: [],
    context: {
      anyActiveRuns: false,
      canReloadWorkspace: false,
      clientConnected: false,
      developerMode: false,
      hostConnectUrl: "",
      hostConnectUrlUsesMdns: false,
      juggleworkServerStatus: "disconnected",
      juggleworkServerUrl: "",
      runtimeWorkspaceId: null,
    },
  };
}

describe("diagnostics bundle", () => {
  test("redacts known token values while preserving token presence", () => {
    const settingsSecret = "settings-secret-token-1234";
    const settingsHostSecret = "settings-host-secret-1234";
    const clientSecret = "client-secret-1234";
    const ownerSecret = "owner-secret-1234";
    const hostSecret = "host-secret-1234";
    const opencodeSecret = "opencode-password-1234";
    const input = baseInputs();
    input.desktopRuntime = true;
    input.juggleworkServerSettings = {
      urlOverride: "http://127.0.0.1:4096",
      token: settingsSecret,
      hostToken: settingsHostSecret,
    };
    input.hostInfo = {
      running: true,
      remoteAccessEnabled: true,
      host: "127.0.0.1",
      port: 4096,
      baseUrl: "http://127.0.0.1:4096",
      connectUrl: "http://127.0.0.1:4096",
      mdnsUrl: null,
      lanUrl: null,
      clientToken: clientSecret,
      ownerToken: ownerSecret,
      hostToken: hostSecret,
      managedOpencodeBinPath: null,
      managedOpencodeBinSource: null,
      pid: 111,
      lastStdout: null,
      lastStderr: `server leaked ${settingsSecret} ${settingsHostSecret} ${clientSecret} ${ownerSecret} ${hostSecret}`,
      managedOpencodeExecution: null,
    };
    input.engineInfo = {
      running: true,
      runtime: "direct",
      managedByServer: true,
      baseUrl: "http://127.0.0.1:4097",
      projectDir: "/tmp/jugglework",
      hostname: "127.0.0.1",
      port: 4097,
      opencodeUsername: "do-not-include-user",
      opencodePassword: opencodeSecret,
      opencodeBinPath: "/usr/local/bin/opencode",
      opencodeBinSource: "path",
      pid: 222,
      lastStdout: null,
      lastStderr: `engine leaked ${opencodeSecret}`,
      execution: null,
    };

    const json = composeDiagnosticsBundleJson(input);
    const parsed = JSON.parse(json);

    expect(json).toContain('"tokenPresent": true');
    expect(parsed.juggleworkServer.settings.tokenPresent).toBe(true);
    expect(parsed.juggleworkServer.settings.urlOverridePresent).toBe(true);
    expect(parsed.juggleworkServer.host.endpointConfigured).toBe(true);
    expect(parsed.opencodeEngine.executionConfigured).toBe(false);
    expect(json).not.toContain(settingsSecret);
    expect(json).not.toContain(settingsHostSecret);
    expect(json).not.toContain(clientSecret);
    expect(json).not.toContain(ownerSecret);
    expect(json).not.toContain(hostSecret);
    expect(json).not.toContain(opencodeSecret);
    expect(json).not.toContain("clientToken");
    expect(json).not.toContain("ownerToken");
    expect(json).not.toContain("hostToken");
    expect(json).not.toContain("opencodePassword");
    expect(json).not.toContain("do-not-include-user");
    expect(json).not.toContain("opencodeUsername");
    expect(json).not.toContain("/tmp/jugglework");
    expect(json).not.toContain("/usr/local/bin/opencode");
    expect(json).not.toContain("server leaked");
    expect(json).not.toContain("engine leaked");
    expect(json).not.toContain("http://127.0.0.1:4096");
  });

  test("produces valid JSON without desktop info", () => {
    const json = composeDiagnosticsBundleJson(baseInputs());
    const parsed = JSON.parse(json);

    expect(parsed.app).toBeNull();
    expect(parsed.opencodeEngine).toBeNull();
    expect(parsed.juggleworkServer.host).toBeNull();
    expect(parsed.juggleworkServer.settings.tokenPresent).toBe(false);
  });

  test("includes sanitized Cloud health without Den or MCP tokens", () => {
    const input = baseInputs();
    input.cloudMcpHealth = {
      desired: {
        config: {
          headers: {
            Authorization: "Bearer owt_mcp_synthetic_secret",
          },
        },
        token: {
          present: true,
          metadata: {
            fingerprint: "sha256:abc123",
            expiresAt: "2026-07-20T00:00:00.000Z",
            scopes: "mcp:read mcp:write",
          },
        },
      },
      firstFailure: {
        details: "den token Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signatureee leaked",
      },
      opaque: "owt_den_synthetic_secret",
    };

    const json = composeDiagnosticsBundleJson(input);
    const parsed = JSON.parse(json);

    expect(parsed.cloudMcp.desired.config.headers.Authorization).toBe("[REDACTED]");
    expect(JSON.stringify(parsed.cloudMcp)).toContain("sha256:abc123");
    expect(JSON.stringify(parsed.cloudMcp)).toContain("mcp:read mcp:write");
    expect(json).not.toContain("owt_mcp_synthetic_secret");
    expect(json).not.toContain("owt_den_synthetic_secret");
    expect(json).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  test("includes only strict aggregated agent runtime support diagnostics", () => {
    const input = baseInputs();
    const distribution = { count: 0, total: 0, max: 0 };
    const json = composeDiagnosticsBundleJson({
      ...input,
      agentRuntimeSupport: {
        schemaVersion: 1,
        capturedAt: 1,
        windowStartedAt: 1,
        worker: { status: "healthy", statusChanges: 1, starts: 1, restarts: 0, crashes: 0, circuitOpens: 0 },
        query: { active: 0, started: 1, completed: 1, failed: 0, aborted: 0, durationMs: distribution },
        mcp: { events: 0, initializing: 0, pending: 0, connected: 0, failed: 0, needsAuth: 0, expired: 0, removed: 0, outputTruncated: 0 },
        interaction: { requested: 0, resolved: 0, allowed: 0, denied: 0, answered: 0, rejected: 0, timedOut: 0, cancelled: 0, failed: 0, durationMs: distribution },
        event: { observed: 0, persisted: 0, duplicates: 0, streamErrors: 0, lagMs: distribution },
        queue: { created: 0, pending: 0, dispatching: 0, admitted: 0, completed: 0, failed: 0, cancelled: 0, waitMs: distribution },
        advancedRollout: { features: CLAUDE_ADVANCED_FEATURES.map((feature) => ({
          feature,
          enabled: false,
          attempts: 0,
          used: 0,
          fallbacks: 0,
          flagDisabled: 0,
          policyDenied: 0,
          killed: 0,
          capabilityMissing: 0,
        })) },
        usage: { samples: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, durationMs: 0, estimatedCostUsd: 0 },
        crash: { total: 0, worker: 0, query: 0, eventStream: 0, lastAt: null, lastReason: null },
      },
    });
    expect(JSON.parse(json).agentRuntimeSupport.query.started).toBe(1);
    expect(json).not.toContain("prompt");
    expect(json).not.toContain("transcript");
  });
});
