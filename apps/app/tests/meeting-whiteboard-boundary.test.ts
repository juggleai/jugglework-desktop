import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const appRoot = join(import.meta.dir, "..");
const allowed = join("src", "react-app", "domains", "meeting", "whiteboard") + sep;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === "node_modules" || name === "dist") return [];
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx|mts|js|mjs|jsx)$/.test(name) ? [full] : [];
  });
}

test("only the meeting whiteboard adapter imports Excalidraw", () => {
  const offenders = sources(join(appRoot, "src"))
    .map((file) => relative(appRoot, file))
    .filter((file) => !file.startsWith(allowed))
    .filter((file) => /["']@excalidraw\/excalidraw(?:\/[^"']*)?["']/.test(readFileSync(join(appRoot, file), "utf8")));
  expect(offenders).toEqual([]);
});
