import { describe, expect, test } from "bun:test";
import type { McpDirectoryInfo } from "../src/app/constants";
import type { McpServerConfig } from "../src/app/types";
import {
  matchPublicConnector,
  resolveConnectorCatalogSource,
} from "../src/react-app/domains/settings/pages/connector-catalog-source";

const remote: McpDirectoryInfo = {
  name: "Public Service",
  serverName: "public-service",
  description: "Public remote connector",
  url: " https://public.example/mcp ",
  oauth: true,
};
const local: McpDirectoryInfo = {
  name: "Local Service",
  description: "Explicit local connector",
  type: "local",
  command: ["npx", "-y", "public-mcp"],
  oauth: false,
};

describe("connector catalog source", () => {
  test("explicit Personal overrides even an exact public identity or catalog ID", () => {
    const connector = {
      name: "public-service", config: { type: "remote" as const, url: remote.url },
      catalogSource: "personal" as const, catalogId: "public-service",
    };
    expect(matchPublicConnector(connector, [remote])).toBeUndefined();
    expect(resolveConnectorCatalogSource(connector, [remote])).toBe("personal");
  });

  test("explicit Public matches stable ID after endpoint and server name changes", () => {
    const entry = { ...remote, id: "stable-id", serverName: "new-name" };
    const connector = {
      name: "old-name", config: { type: "remote" as const, url: "https://edited.example/mcp" },
      catalogSource: "public" as const, catalogId: "stable-id",
    };
    expect(matchPublicConnector(connector, [entry])).toBe(entry);
    expect(resolveConnectorCatalogSource(connector, [entry])).toBe("public");
    expect(matchPublicConnector({ ...connector, catalogId: "public-service" }, [remote])).toBe(remote);
    expect(matchPublicConnector({ ...connector, catalogId: "new-name" }, [entry])).toBeUndefined();
  });

  test("stored Public stays Public without a catalog match and never falls back from a stale ID", () => {
    const connector = {
      name: "public-service", config: { type: "remote" as const, url: remote.url },
      catalogSource: "public" as const, catalogId: "removed-id",
    };
    for (const entries of [[], [remote]]) {
      expect(matchPublicConnector(connector, entries)).toBeUndefined();
      expect(resolveConnectorCatalogSource(connector, entries)).toBe("public");
    }
    expect(matchPublicConnector({ ...connector, catalogId: undefined }, [remote])).toBe(remote);
    expect(resolveConnectorCatalogSource({ ...connector, catalogId: undefined }, [])).toBe("public");
    expect(matchPublicConnector({ ...connector, catalogSource: undefined }, [remote])).toBe(remote);
  });

  test.each(["github", "notion", "linear", "sentry", "stripe", "context7"])(
    "migrates retired Public connector %s to Personal without deleting its configuration",
    (catalogId) => {
      const connector = {
        name: catalogId,
        config: { type: "remote" as const, url: `https://${catalogId}.example/mcp`, enabled: false },
        catalogSource: "public" as const,
        catalogId,
      };
      expect(matchPublicConnector(connector, [])).toBeUndefined();
      expect(resolveConnectorCatalogSource(connector, [])).toBe("personal");
      expect(connector.config).toEqual({ type: "remote", url: `https://${catalogId}.example/mcp`, enabled: false });
    },
  );

  test("matches exact server name and trimmed URL regardless of enabled or auth settings", () => {
    const connector = {
      name: "public-service",
      config: { type: "remote" as const, url: "https://public.example/mcp  ", enabled: false, oauth: false as const },
    };
    expect(matchPublicConnector(connector, [remote])).toBe(remote);
    expect(resolveConnectorCatalogSource(connector, [remote])).toBe("public");
    const derived = { ...remote, serverName: undefined };
    expect(matchPublicConnector(connector, [derived])).toBe(derived);
  });

  test.each([
    ["Public Service", "https://public.example/mcp"],
    ["PUBLIC-SERVICE", "https://public.example/mcp"],
    [" public-service ", "https://public.example/mcp"],
    ["renamed", "https://public.example/mcp"],
    ["public-service", "https://custom.example/mcp"],
    ["public-service", "https://public.example/mcp/"],
    ["public-service", "https://public.example/MCP"],
    ["public-service", ""],
  ])("keeps non-exact identity %s / %s personal", (name, url) => {
    const connector = { name, config: { type: "remote" as const, url } };
    expect(matchPublicConnector(connector, [remote])).toBeUndefined();
    expect(resolveConnectorCatalogSource(connector, [remote])).toBe("personal");
  });

  test("missing catalog, missing URLs and blank URLs do not imply public origin", () => {
    const connector = { name: "public-service", config: { type: "remote" as const } };
    for (const entries of [[], [{ ...remote, url: undefined }], [{ ...remote, url: "  " }]]) {
      expect(matchPublicConnector(connector, entries)).toBeUndefined();
      expect(resolveConnectorCatalogSource(connector, entries)).toBe("personal");
    }
  });

  test("finds the matching endpoint among same-name catalog entries", () => {
    const connector = { name: "public-service", config: { type: "remote" as const, url: remote.url } };
    expect(matchPublicConnector(connector, [{ ...remote, url: "https://other.example/mcp" }, remote])).toBe(remote);
  });

  test("local requires explicit local type and an exact nonempty command array", () => {
    const connector = { name: "local-service", config: { type: "local" as const, command: [...local.command!] } };
    expect(matchPublicConnector(connector, [local])).toBe(local);
    expect(resolveConnectorCatalogSource(connector, [local])).toBe("public");
    for (const entry of [{ ...local, type: undefined }, { ...local, command: [] }, { ...local, command: undefined }]) {
      expect(matchPublicConnector(connector, [entry])).toBeUndefined();
    }
    const configs: McpServerConfig[] = [
      { type: "local", command: ["npx", "public-mcp", "-y"] },
      { type: "local", command: ["npx", "-y", "public-mcp", "extra"] },
      { type: "local", command: ["npx", "-y", "public-mcp "] },
      { type: "local", command: [] },
      { type: "local" },
      { type: "remote", url: "https://public.example/mcp" },
    ];
    for (const config of configs) {
      expect(resolveConnectorCatalogSource({ name: "local-service", config }, [local])).toBe("personal");
    }
    expect(matchPublicConnector({ name: "public-service", config: connector.config }, [remote])).toBeUndefined();
  });
});
