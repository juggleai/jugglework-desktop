import { describe, expect, test } from "bun:test";

import { MCP_QUICK_CONNECT } from "../src/app/constants";
import { globalMcpConfigFromDirectory } from "../src/react-app/domains/settings/state/global-mcp-config";
import { resolveConnectorCatalogSource } from "../src/react-app/domains/settings/pages/connector-catalog-source";

describe("built-in JuggleWork MCP visibility", () => {
  test("GitHub is a visible public connector with runtime token auth, not automatic OAuth", () => {
    const github = MCP_QUICK_CONNECT.find((entry) => entry.id === "github");
    expect(github).toBeDefined();
    expect(github).toMatchObject({ serverName: "github", type: "remote", kind: "mcp", oauth: false, iconSlug: "github" });
    expect(github!.defaultHidden).not.toBe(true);
    const installed = globalMcpConfigFromDirectory(github!);
    expect(installed.config).toEqual({ type: "remote", url: "https://api.githubcopilot.com/mcp/", enabled: true, oauth: false, headers: { Authorization: "Bearer {env:GITHUB_TOKEN}" } });
    expect(resolveConnectorCatalogSource(installed, MCP_QUICK_CONNECT)).toBe("public");
    expect(resolveConnectorCatalogSource({ ...installed, catalogSource: "personal" }, MCP_QUICK_CONNECT)).toBe("personal");
  });
  test("hides internal JuggleWork MCPs and omits the retired admin connector", () => {
    expect(MCP_QUICK_CONNECT.find((entry) => entry.serverName === "jugglework-cloud")?.defaultHidden).toBe(true);
    expect(MCP_QUICK_CONNECT.find((entry) => entry.serverName === "jugglework-admin")).toBeUndefined();
    expect(MCP_QUICK_CONNECT.find((entry) => entry.serverName === "jugglework-ui")?.defaultHidden).toBe(true);
  });

  test("keeps directory apps visible by default", () => {
    expect(MCP_QUICK_CONNECT.find((entry) => entry.serverName === "notion")?.defaultHidden).toBeUndefined();
    expect(MCP_QUICK_CONNECT.find((entry) => entry.serverName === "linear")?.defaultHidden).toBeUndefined();
  });
});
