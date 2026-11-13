import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const target = process.argv.includes("--opencode-plugins-only")
  ? resolve(packageRoot, "dist", "opencode-plugins")
  : resolve(packageRoot, "dist");
await rm(target, { recursive: true, force: true });
