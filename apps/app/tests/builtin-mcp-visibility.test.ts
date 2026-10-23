import { describe, expect, test } from "bun:test";

import { MCP_QUICK_CONNECT } from "../src/app/constants";

describe("built-in JuggleWork MCP visibility", () => {
  test("does not publish external MCP connectors in the Public catalog", () => {
    const visiblePublicConnectors = MCP_QUICK_CONNECT.filter((entry) =>
      !entry.defaultHidden && (entry.type === "remote" || entry.type === "local") && entry.kind === "mcp",
    );
    expect(visiblePublicConnectors).toEqual([]);
    expect(MCP_QUICK_CONNECT.map((entry) => entry.serverName)).not.toContain("github");
    expect(MCP_QUICK_CONNECT.map((entry) => entry.serverName)).not.toContain("notion");
    expect(MCP_QUICK_CONNECT.map((entry) => entry.serverName)).not.toContain("linear");
    expect(MCP_QUICK_CONNECT.map((entry) => entry.serverName)).not.toContain("sentry");
    expect(MCP_QUICK_CONNECT.map((entry) => entry.serverName)).not.toContain("stripe");
    expect(MCP_QUICK_CONNECT.map((entry) => entry.serverName)).not.toContain("context7");
  });
  test("hides internal JuggleWork MCPs and omits the retired admin connector", () => {
    expect(MCP_QUICK_CONNECT.find((entry) => entry.serverName === "jugglework-cloud")?.defaultHidden).toBe(true);
    expect(MCP_QUICK_CONNECT.find((entry) => entry.serverName === "jugglework-admin")).toBeUndefined();
    expect(MCP_QUICK_CONNECT.find((entry) => entry.serverName === "jugglework-ui")?.defaultHidden).toBe(true);
  });

});
