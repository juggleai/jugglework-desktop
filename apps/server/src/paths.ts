import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ApiError } from "./errors.js";

export function assertAbsolute(path: string): void {
  if (!isAbsolute(path)) {
    throw new ApiError(400, "invalid_path", "Path must be absolute");
  }
}

export async function resolveWithinRoot(root: string, ...segments: string[]): Promise<string> {
  const resolvedRoot = await realpath(root);
  const candidate = resolve(resolvedRoot, ...segments);
  if (candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + sep)) {
    throw new ApiError(400, "path_escape", "Path escapes workspace root");
  }

  const parts = relative(resolvedRoot, candidate).split(sep).filter(Boolean);
  let current = resolvedRoot;
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new ApiError(400, "path_escape", "Path traverses a symbolic link");
      }
      if (index < parts.length - 1 && !metadata.isDirectory()) {
        throw new ApiError(400, "invalid_path", "Path traverses a non-directory entry");
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return candidate;
}
