import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReviewRun } from "@jugglework/types/reviews";
import { inheritWorkspaceOpencodeConnection } from "../opencode-connection.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { workspaceIdForPath } from "../workspaces.js";

type ReviewIdentity = {
  id: string;
  repository: { fullName: string };
  number: number;
  title: string;
  url?: string;
  headRevision?: string;
};

function localDateFolder(now: Date): string {
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function safeSegment(value: string, fallback: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 96);
  return normalized || fallback;
}

async function createUniqueDirectory(parent: string, baseName: string): Promise<string> {
  await mkdir(parent, { recursive: true });
  for (let index = 1; index < 10_000; index += 1) {
    const path = join(parent, index === 1 ? baseName : `${baseName}-${index}`);
    try {
      await mkdir(path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not allocate a unique code review workspace directory.");
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function workspaceBelongsToReview(path: string, review: ReviewIdentity): Promise<boolean> {
  try {
    const metadata = JSON.parse(await readFile(join(path, ".jugglework", "review.json"), "utf8")) as Record<string, unknown>;
    // reviewId is authoritative for new workspaces. Repository + PR number is
    // retained as a safe migration path for workspaces created by older builds.
    return metadata.reviewId === review.id || (
      metadata.repository === review.repository.fullName
      && metadata.pullRequestNumber === review.number
    );
  } catch {
    return false;
  }
}

export function defaultCodeReviewRoot(): string {
  return join(homedir(), "Documents", "JuggleWork", "codereview");
}

export async function prepareCodeReviewWorkspace(input: {
  config: ServerConfig;
  review: ReviewIdentity;
  previous: ReviewRun | null;
  now?: Date;
  root?: string;
}): Promise<WorkspaceInfo> {
  const previousWorkspace = input.previous?.workspaceId
    ? input.config.workspaces.find((workspace) => workspace.id === input.previous?.workspaceId && workspace.hidden)
    : undefined;
  if (previousWorkspace?.path
      && await directoryExists(previousWorkspace.path)
      && await workspaceBelongsToReview(previousWorkspace.path, input.review)) return previousWorkspace;

  const repositoryName = input.review.repository.fullName.split("/").pop() || "repository";
  const baseName = safeSegment(`${repositoryName}-pr-${input.review.number}-${input.review.title}`, `pr-${input.review.number}`);
  const parent = join(input.root ?? defaultCodeReviewRoot(), localDateFolder(input.now ?? new Date()));
  const path = await createUniqueDirectory(parent, baseName);
  const createdAt = (input.now ?? new Date()).toISOString();
  const metadataDirectory = join(path, ".jugglework");
  await mkdir(metadataDirectory, { recursive: true });
  await writeFile(join(metadataDirectory, "review.json"), `${JSON.stringify({
    schemaVersion: 1,
    provider: "github",
    reviewId: input.review.id,
    repository: input.review.repository.fullName,
    pullRequestNumber: input.review.number,
    pullRequestUrl: input.review.url,
    headRevision: input.review.headRevision,
    createdAt,
  }, null, 2)}\n`, { mode: 0o600 });
  return {
    id: workspaceIdForPath(path),
    name: `PR #${input.review.number} ${input.review.title}`.slice(0, 120),
    path,
    preset: "starter",
    workspaceType: "local",
    hidden: true,
    ...inheritWorkspaceOpencodeConnection(input.config),
  };
}
