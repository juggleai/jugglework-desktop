import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

async function sources(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await sources(path));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) result.push(await readFile(path, "utf8"));
  }
  return result;
}

test("Toon workspace excludes forbidden runtimes and dynamic import contracts", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const dependencies = Object.keys(packageJson.dependencies ?? {});
  expect(dependencies.some((name) => name === "vue" || name.startsWith("@vue/") || name.startsWith("@toonflow/") || /electrobun|element-plus/i.test(name))).toBe(false);
  const source = (await sources(new URL("../src/react-app/domains/toon-factory", import.meta.url).pathname)).join("\n");
  expect(source).not.toMatch(/from\s+["'](?:vue|element-plus|electrobun|@toonflow\/)/);
  expect(source).not.toMatch(/https?:\/\/.*(?:\.umd\.js|toonflow)/i);
  expect(source).not.toMatch(/\beval\s*\(|new\s+Function\s*\(/);
});
