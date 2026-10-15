import { afterEach, expect, test } from "bun:test";

import { createJuggleWorkServerClient, parseJuggleWorkSkillItems } from "../src/app/lib/jugglework-server";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("getSkillDetail requests the exact global path and returns file metadata", async () => {
  const path = "/home/user/.config/opencode/skills/writer/SKILL.md";
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return Response.json({
      item: { name: "writer", path, description: "Writes", scope: "global" },
      content: "# Writer",
      files: [{ relPath: "SKILL.md", size: 8 }],
    });
  }) as typeof fetch;

  const client = createJuggleWorkServerClient({ baseUrl: "http://127.0.0.1:8787" });
  const detail = await client.getSkillDetail("workspace/id", { path, scope: "global" });
  const url = new URL(requestUrl);

  expect(url.pathname).toBe("/workspace/workspace%2Fid/skills/detail");
  expect(url.searchParams.get("scope")).toBe("global");
  expect(url.searchParams.get("path")).toBe(path);
  expect(new Headers(requestInit?.headers).has("Authorization")).toBe(false);
  expect(detail).toEqual({
    item: { name: "writer", path, description: "Writes", scope: "global" },
    content: "# Writer",
    files: [{ relPath: "SKILL.md", size: 8 }],
  });
});

test("skill inventory parser retains optional server provenance and rejects malformed rows", () => {
  expect(parseJuggleWorkSkillItems({ items: [
    { name: "plugin-skill", path: "/skills/plugin/SKILL.md", description: "Plugin", scope: "global", ownerPluginId: "plugin-1", sourceKind: "plugin", enabled: true },
    { name: "standalone", path: "/skills/standalone/SKILL.md", description: "Standalone", scope: "global", sourceKind: "standalone" },
    { name: "public", path: "/skills/public/SKILL.md", description: "Public", scope: "global", sourceKind: "public" },
    { name: "broken", scope: "global" },
  ] })).toEqual({ items: [
    { name: "plugin-skill", path: "/skills/plugin/SKILL.md", description: "Plugin", scope: "global", ownerPluginId: "plugin-1", sourceKind: "plugin", enabled: true },
    { name: "standalone", path: "/skills/standalone/SKILL.md", description: "Standalone", scope: "global", sourceKind: "standalone" },
    { name: "public", path: "/skills/public/SKILL.md", description: "Public", scope: "global", sourceKind: "public" },
  ] });
});
