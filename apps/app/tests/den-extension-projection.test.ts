import { afterEach, describe, expect, test } from "bun:test";

import { createDenClient } from "../src/app/lib/den";

const originalFetch = globalThis.fetch;

describe("Den extension projections", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
  });

  test("keeps extension manifests from marketplace responses", async () => {
    const calls: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({
        item: {
          marketplace: {
            id: "marketplace_test",
            name: "Test Marketplace",
            description: null,
            status: "active",
            pluginCount: 1,
            updatedAt: "2026-05-23T00:00:00.000Z",
          },
          plugins: [{
            id: "plugin_test",
            name: "Image Tools",
            description: "Adds an image command.",
            status: "active",
            memberCount: 1,
            updatedAt: "2026-05-23T00:00:00.000Z",
            componentCounts: { command: 1 },
            extension: {
              id: "plugin_test",
              name: "Image Tools",
              description: "Adds an image command.",
              sourceFormat: "claude-plugin",
              manifest: {
                schemaVersion: 1,
                id: "plugin_test",
                name: "Image Tools",
                description: "Adds an image command.",
                source: {
                  format: "claude-plugin",
                  origin: "den",
                  reference: "plugin_test",
                  trusted: false,
                },
                resources: [{
                  type: "command",
                  id: "plugin_test:command",
                  label: "1 command",
                  required: true,
                }],
                contributions: [{
                  type: "setup-instructions",
                  ref: "den.claudePlugin.setup",
                  label: "Claude-compatible plugin import",
                  location: "settings-detail",
                }],
                setup: {
                  instructions: "Install from Den.",
                },
                lifecycle: {
                  detection: ["command:plugin_test"],
                },
              },
            },
          }],
          source: null,
        },
      }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    };

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });

    const client = createDenClient({ baseUrl: "http://den.local", token: "token" });
    const resolved = await client.getOrgMarketplaceResolved("organization_test", "marketplace_test");
    const plugin = resolved.plugins[0];

    expect(calls).toEqual(["http://den.local/jwork/api/v1/marketplaces/marketplace_test/resolved"]);
    expect(plugin.extension?.sourceFormat).toBe("claude-plugin");
    expect(plugin.extension?.manifest?.resources).toEqual([{
      type: "command",
      id: "plugin_test:command",
      label: "1 command",
      required: true,
    }]);
    expect(plugin.extension?.manifest?.setup?.instructions).toBe("Install from Den.");
    expect(plugin.extension?.manifest?.contributions?.[0]?.ref).toBe("den.claudePlugin.setup");
  });

  test("lists directly granted organization plugins without requiring a marketplace", async () => {
    const calls: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({
        items: [{
          id: "plugin_personal",
          name: "Personal Test Plugin",
          description: "Assigned directly to the current member.",
          status: "active",
          memberCount: 2,
          updatedAt: "2026-10-08T09:00:00.000Z",
          componentCounts: { skill: 1, mcp: 1 },
          marketplaces: [],
        }],
      }), { headers: { "Content-Type": "application/json" }, status: 200 });
    };
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });

    const client = createDenClient({ baseUrl: "http://den.local", token: "token" });
    const plugins = await client.listOrgPlugins("organization_personal");

    expect(calls).toEqual(["http://den.local/jwork/api/v1/plugins?status=active&limit=100"]);
    expect(plugins).toEqual([expect.objectContaining({
      id: "plugin_personal",
      name: "Personal Test Plugin",
      componentCounts: { skill: 1, mcp: 1 },
      marketplaces: [],
    })]);
  });
});
