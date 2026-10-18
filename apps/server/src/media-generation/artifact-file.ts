import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";

function isContained(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

export async function readWorkspaceArtifact(input: {
  workspaceRoot: string;
  relativePath: string;
  expectedBytes?: number;
  maxBytes: number;
  pathError: string;
  artifactError: string;
}): Promise<Uint8Array> {
  const root = await realpath(input.workspaceRoot);
  const lexicalPath = resolve(root, input.relativePath);
  if (lexicalPath === root || !isContained(root, lexicalPath)) throw new Error(input.pathError);

  let parent: string;
  try {
    parent = await realpath(dirname(lexicalPath));
  } catch {
    throw new Error(input.artifactError);
  }
  if (!isContained(root, parent)) throw new Error(input.pathError);
  const path = resolve(parent, basename(lexicalPath));

  const noFollow = process.platform !== "win32" && typeof constants.O_NOFOLLOW === "number";
  try {
    // Windows has no O_NOFOLLOW. This preflight narrows symlink exposure, while all
    // metadata and content decisions after open still use the same file handle.
    if (!noFollow) {
      const beforeOpen = await lstat(path);
      if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink()) throw new Error(input.artifactError);
      const resolved = await realpath(path);
      if (!isContained(root, resolved)) throw new Error(input.pathError);
    }

    const handle = await open(path, constants.O_RDONLY | (noFollow ? constants.O_NOFOLLOW : 0));
    try {
      const metadata = await handle.stat();
      const resolved = await realpath(path);
      if (!isContained(root, resolved)) throw new Error(input.pathError);
      const pathMetadata = await lstat(path);
      if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink() ||
        pathMetadata.dev !== metadata.dev || pathMetadata.ino !== metadata.ino) {
        throw new Error(input.artifactError);
      }
      if (!metadata.isFile() || metadata.size <= 0 || metadata.size > input.maxBytes ||
        (input.expectedBytes !== undefined && metadata.size !== input.expectedBytes)) {
        throw new Error(input.artifactError);
      }
      const bytes = new Uint8Array(await handle.readFile());
      if (bytes.byteLength !== metadata.size ||
        (input.expectedBytes !== undefined && bytes.byteLength !== input.expectedBytes)) {
        throw new Error(input.artifactError);
      }
      return bytes;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof Error && (error.message === input.pathError || error.message === input.artifactError)) throw error;
    throw new Error(input.artifactError);
  }
}
