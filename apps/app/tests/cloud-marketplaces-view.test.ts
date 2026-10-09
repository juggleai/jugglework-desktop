import { describe, expect, test } from "bun:test";

import {
  matchesMarketplaceFilters,
  shouldIncludeCloudMarketplacePluginRow,
  shouldIncludeOrgMcpConnectionMarketplaceRow,
  shouldShowMarketplaceRows,
} from "../src/react-app/domains/settings/pages/cloud-marketplaces-view";
import { readFileSync } from "node:fs";

describe("Cloud marketplace row visibility", () => {
  test("hides marketplace rows until a signed-in org is available", () => {
    expect(shouldShowMarketplaceRows(false, "org_1")).toBe(false);
    expect(shouldShowMarketplaceRows(true, "")).toBe(false);
    expect(shouldShowMarketplaceRows(true, "   ")).toBe(false);
    expect(shouldShowMarketplaceRows(true, "org_1")).toBe(true);
  });

  test("keeps Den organization plugins out of the embedded Extensions Marketplace pane", () => {
    expect(shouldIncludeCloudMarketplacePluginRow({ embedded: false })).toBe(true);
    expect(shouldIncludeCloudMarketplacePluginRow({ embedded: true })).toBe(false);
  });

  test("keeps organization MCP connections out of both Marketplace surfaces", () => {
    expect(shouldIncludeOrgMcpConnectionMarketplaceRow({ embedded: false })).toBe(false);
    expect(shouldIncludeOrgMcpConnectionMarketplaceRow({ embedded: true })).toBe(false);
  });
});

describe("Dedicated plugin catalog refresh lifecycle", () => {
  test("passes a stable organization connector refresh callback", () => {
    const source = readFileSync(new URL("../src/react-app/shell/settings-route.tsx", import.meta.url), "utf8");
    const catalogBranch = source.slice(
      source.indexOf("if (props.pluginCatalogOnly)"),
      source.indexOf("// TIPS: 仅会话右侧 rail", source.indexOf("if (props.pluginCatalogOnly)")),
    );
    expect(catalogBranch).toContain("refreshOrgMcpConnections={orgMcpConnections.refresh}");
    expect(catalogBranch).not.toContain("refreshOrgMcpConnections={() => orgMcpConnections.refresh()}");
  });
});

describe("Marketplace search and filters", () => {
  const row = {
    marketplaceId: "mk_1",
    status: "available" as const,
    searchableText: "desktop marketplace compatibility test 1 skill",
  };
  const noFilters = { search: "", statusFilter: "all" as const, marketplaceFilter: "all" };

  test("keeps every row when no query or filter is set", () => {
    expect(matchesMarketplaceFilters(row, noFilters)).toBe(true);
  });

  test("matches the query case-insensitively and ignores surrounding spaces", () => {
    expect(matchesMarketplaceFilters(row, { ...noFilters, search: "Compatibility" })).toBe(true);
    expect(matchesMarketplaceFilters(row, { ...noFilters, search: "  DESKTOP  " })).toBe(true);
    expect(matchesMarketplaceFilters(row, { ...noFilters, search: "notion" })).toBe(false);
  });

  test("applies status and marketplace filters alongside the query", () => {
    expect(matchesMarketplaceFilters(row, { ...noFilters, statusFilter: "installed" })).toBe(false);
    expect(matchesMarketplaceFilters(row, { ...noFilters, statusFilter: "available" })).toBe(true);
    expect(matchesMarketplaceFilters(row, { ...noFilters, marketplaceFilter: "mk_2" })).toBe(false);
    expect(matchesMarketplaceFilters(row, { ...noFilters, marketplaceFilter: "mk_1", search: "skill" })).toBe(true);
  });
});
