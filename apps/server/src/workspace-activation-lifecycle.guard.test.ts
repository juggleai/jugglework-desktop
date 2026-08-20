import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("workspace activation lifecycle guard", () => {
  test("keeps registry activation independent from engine disposal and bootstrap", async () => {
    const source = await readFile(join(import.meta.dir, "routes", "workspaces.ts"), "utf8");
    const activation = source.match(
      /addRoute\(routes, "POST", "\/workspaces\/:id\/activate"[\s\S]*?return jsonResponse\(\{ activeId:/,
    )?.[0] ?? "";

    expect(activation).not.toBe("");
    expect(activation).not.toContain("reloadOpencodeEngine");
    expect(activation).not.toContain("/instance/dispose");
    expect(activation).not.toContain("resolveWorkspace(config");
    expect(activation).toContain("resolveWorkspaceForRegistry");
  });
});
