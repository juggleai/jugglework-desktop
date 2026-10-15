import { readFileSync } from "node:fs";
import { expect, mock, test } from "bun:test";
import ts from "typescript";

const route = readFileSync(new URL("../src/react-app/shell/settings-route.tsx", import.meta.url), "utf8");
const block = route.slice(route.indexOf("const loadGlobalSkillDetail ="), route.indexOf("const refreshGlobalSkills ="));
// Execute the route's callback without mounting unrelated settings providers.
const createLoader = new Function("inventoryClient", "selectedWorkspaceEndpoint", "selectedWorkspace", "runtimeWorkspaceId", "globalInventoryScope", "useCallback",
  ts.transpileModule(`${block}\nreturn loadGlobalSkillDetail;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);

const detail = (path: string) => ({
  item: { name: "writer", path, description: "", scope: "global" as const },
  content: "---\nname: writer\n---\nExact runtime content",
  files: [{ relPath: "SKILL.md", size: 120 }, { relPath: "references/guide.md", size: 2048 }],
});

function setup(options: { remote?: boolean; endpoint?: boolean; workspaceId?: string } = {}) {
  const getSkillDetail = mock(async (_id: string, input: { path: string; scope: "global" }) => detail(input.path));
  const scope = { active: true };
  const endpoint = options.endpoint === false ? null : { client: { getSkillDetail } };
  const inventoryClient = endpoint?.client ?? { getSkillDetail };
  const load = createLoader(
    inventoryClient,
    endpoint,
    { workspaceType: options.remote === false ? "local" : "remote" },
    options.workspaceId === undefined ? "runtime-id" : options.workspaceId,
    scope,
    (callback: unknown) => callback,
  );
  return { load, getSkillDetail, scope };
}

test("route wires exact API and returns content plus files for the inventory path", async () => {
  expect(route).toContain("loadSkillDetail={loadGlobalSkillDetail}");
  const { load, getSkillDetail } = setup();
  const path = "/home/user/.config/opencode/skills/writer/SKILL.md";
  const result = await load({ name: "writer", path });
  expect(getSkillDetail).toHaveBeenCalledWith("runtime-id", { path, scope: "global" });
  expect(result).toEqual({ content: detail(path).content, path, files: detail(path).files });
});

test("remote without its owning endpoint never falls back to the local inventory client", async () => {
  const { load, getSkillDetail } = setup({ endpoint: false });
  await expect(load({ name: "writer", path: "/global/writer/SKILL.md" })).rejects.toThrow("Exact skill file reading is unavailable");
  expect(getSkillDetail).not.toHaveBeenCalled();
});

test.each(["", "   "])("empty path %j is rejected before the exact API call", async (path) => {
  const { load, getSkillDetail } = setup();
  await expect(load({ name: "writer", path })).rejects.toThrow("Exact skill file reading is unavailable");
  expect(getSkillDetail).not.toHaveBeenCalled();
});

test("a mismatched response path is rejected with no content or files exposed", async () => {
  const { load, getSkillDetail } = setup();
  getSkillDetail.mockResolvedValue(detail("/global/another/SKILL.md"));
  await expect(load({ name: "writer", path: "/global/writer/SKILL.md" })).rejects.toThrow("Exact skill file reading is unavailable");
});

test("stale runtime context is rejected before and after the exact API response", async () => {
  const before = setup();
  before.scope.active = false;
  await expect(before.load({ name: "writer", path: "/global/writer/SKILL.md" })).rejects.toThrow();
  expect(before.getSkillDetail).not.toHaveBeenCalled();

  const after = setup();
  after.getSkillDetail.mockImplementation(async (_id, input) => {
    after.scope.active = false;
    return detail(input.path);
  });
  await expect(after.load({ name: "writer", path: "/global/writer/SKILL.md" })).rejects.toThrow();
});

test("missing runtime context is rejected before the exact API call", async () => {
  const { load, getSkillDetail } = setup({ workspaceId: "" });
  await expect(load({ name: "writer", path: "/global/writer/SKILL.md" })).rejects.toThrow();
  expect(getSkillDetail).not.toHaveBeenCalled();
});
