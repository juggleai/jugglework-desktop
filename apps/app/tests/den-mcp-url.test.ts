import { describe, expect, test } from "bun:test";

import {
  getDenMcpUrl,
  isLegacyWebAppMcpUrl,
  resolveCloudMcpResourceUrl,
  resolveDenBaseUrls,
} from "../src/app/lib/den";

describe("resolveDenBaseUrls", () => {
  test("always derives the API proxy from the base URL", () => {
    const resolved = resolveDenBaseUrls({
      baseUrl: "https://app.openworklabs.com",
      apiBaseUrl: "https://app.openworklabs.com",
    });
    expect(resolved.apiBaseUrl).toBe("https://app.openworklabs.com/jwork/api");
  });

  test("ignores an explicit API origin when a base URL is present", () => {
    const resolved = resolveDenBaseUrls({
      baseUrl: "https://app.openworklabs.com",
      apiBaseUrl: "https://api.example.com",
    });
    expect(resolved.apiBaseUrl).toBe("https://app.openworklabs.com/jwork/api");
  });

  test("ignores an explicit loopback API URL when a base URL is present", () => {
    const resolved = resolveDenBaseUrls({
      baseUrl: "http://localhost:3000",
      apiBaseUrl: "http://127.0.0.1:8787",
    });
    expect(resolved.apiBaseUrl).toBe("http://localhost:3000/jwork/api");
  });

  test("derives the /jwork/api root from a bare baseUrl when no apiBaseUrl is set", () => {
    const resolved = resolveDenBaseUrls({ baseUrl: "https://app.openworklabs.com" });
    expect(resolved.apiBaseUrl).toBe("https://app.openworklabs.com/jwork/api");
  });
});

describe("getDenMcpUrl", () => {
  test("never targets the bare web-app origin", () => {
    const url = getDenMcpUrl();
    expect(isLegacyWebAppMcpUrl(url)).toBe(false);
    expect(url.endsWith("/mcp")).toBe(true);
  });
});

describe("isLegacyWebAppMcpUrl", () => {
  test("flags the legacy bare web-app MCP URL", () => {
    expect(isLegacyWebAppMcpUrl("https://app.openworklabs.com/mcp")).toBe(true);
    expect(isLegacyWebAppMcpUrl("https://app.openwork.software/mcp/")).toBe(true);
  });

  test("accepts valid MCP URLs", () => {
    expect(isLegacyWebAppMcpUrl("https://app.openworklabs.com/jwork/api/mcp")).toBe(false);
    expect(isLegacyWebAppMcpUrl("http://127.0.0.1:8787/mcp")).toBe(false);
  });

  test("ignores empty or malformed input", () => {
    expect(isLegacyWebAppMcpUrl(null)).toBe(false);
    expect(isLegacyWebAppMcpUrl("not a url")).toBe(false);
  });
});

describe("resolveCloudMcpResourceUrl", () => {
  test("heals a minted legacy web-app resource onto the control plane MCP route", () => {
    expect(resolveCloudMcpResourceUrl("https://app.openworklabs.com/mcp")).toBe(
      "https://app.openworklabs.com/jwork/api/mcp",
    );
    expect(resolveCloudMcpResourceUrl("https://app.openwork.software/mcp/")).toBe(
      "https://app.openwork.software/jwork/api/mcp",
    );
  });

  test("keeps healthy resources verbatim", () => {
    expect(resolveCloudMcpResourceUrl("https://app.openworklabs.com/jwork/api/mcp")).toBe(
      "https://app.openworklabs.com/jwork/api/mcp",
    );
    expect(resolveCloudMcpResourceUrl("http://127.0.0.1:8787/mcp")).toBe(
      "http://127.0.0.1:8787/mcp",
    );
  });

  test("returns null for unusable resources so callers keep their fallback", () => {
    expect(resolveCloudMcpResourceUrl(null)).toBeNull();
    expect(resolveCloudMcpResourceUrl("")).toBeNull();
    expect(resolveCloudMcpResourceUrl("   ")).toBeNull();
    expect(resolveCloudMcpResourceUrl("not a url")).toBeNull();
    expect(resolveCloudMcpResourceUrl("ftp://app.openworklabs.com/mcp")).toBeNull();
  });
});
