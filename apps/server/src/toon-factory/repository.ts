import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import {
  TOON_FACTORY_SCHEMA_VERSION,
  toonCanvasSchema,
  toonCanvasWriteRequestSchema,
  toonDeliveryManifestCreateRequestSchema,
  toonDeliveryManifestSchema,
  toonIdentifierSchema,
  toonProjectCreateRequestSchema,
  toonProjectSchema,
  toonProjectUpdateRequestSchema,
  toonTextActionOutputSchemas,
  toonTextWriteRequestSchema,
  type ToonCanvas,
  type ToonCanvasResponse,
  type ToonDeliveryManifest,
  type ToonDeliveryManifestCreateRequest,
  type ToonDeliveryManifestListResponse,
  type ToonDeliveryManifestResponse,
  type ToonProject,
  type ToonProjectCreateRequest,
  type ToonProjectListResponse,
  type ToonProjectResponse,
  type ToonProjectSummary,
  type ToonProjectUpdateRequest,
  type ToonTextResponse,
  type ToonTextGenerationAction,
  type ToonTextJob,
  type ToonTextJobResult,
  type ToonTextWriteRequest,
  type ToonMediaCandidate,
  type ToonMediaJob,
  type ToonFileReference,
  type ToonWorkflowStep,
} from "@jugglework/types/toon-factory";
import type { ZodType } from "zod";
import { ApiError } from "../errors.js";
import { resolveWithinRoot } from "../paths.js";

const PROJECT_FILE = "toon-project.json";
const DISCOVERY_EXCLUDES = new Set([".git", "node_modules"]);
const MAX_DISCOVERY_DIRECTORIES = 10_000;
const MAX_PROJECT_BYTES = 64 * 1024 * 1024;
const MAX_CANVAS_BYTES = 128 * 1024 * 1024;
const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const MAX_DELIVERY_MANIFEST_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const writeQueues = new Map<string, Promise<void>>();
const ATOMIC_PROTOCOL_VERSION = "v1";
const ATOMIC_ARTIFACT_PATTERN = /^(.*)\.jugglework-v1-(project|canvas|text|json)-(\d{13})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(bak|tmp)$/;

type FileSnapshot = { content: string; revision: string; dev: number | bigint; ino: number | bigint };
type ExpectedFileSnapshot = Pick<FileSnapshot, "revision" | "dev" | "ino"> | null;
type AtomicFileKind = "project" | "canvas" | "text" | "json";
type AtomicArtifact = {
  name: string;
  path: string;
  targetName: string;
  kind: AtomicFileKind;
  timestamp: number;
  transactionId: string;
  extension: "bak" | "tmp";
};
export type ToonFactoryRepositoryHooks = { beforeAtomicPublish?: (path: string) => void | Promise<void> };

function revision(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function jsonContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseInput<T>(schema: ZodType<T>, value: unknown, code: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, code, "Invalid Toon Factory request", { issues: parsed.error.issues });
  }
  return parsed.data;
}

function parseVersioned<T>(schema: ZodType<T>, value: unknown, kind: "project" | "canvas" | "delivery manifest"): T {
  const version = value && typeof value === "object" && "schemaVersion" in value
    ? (value as { schemaVersion?: unknown }).schemaVersion
    : undefined;
  if (version !== TOON_FACTORY_SCHEMA_VERSION) {
    throw new ApiError(422, "toon_factory_unsupported_version", `Unsupported Toon Factory ${kind} schema version`, {
      kind,
      supportedVersion: TOON_FACTORY_SCHEMA_VERSION,
      actualVersion: version ?? null,
    });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(422, `invalid_toon_${kind}`, `Invalid Toon Factory ${kind}`, { issues: parsed.error.issues });
  }
  return parsed.data;
}

function assertRequestedVersion(value: unknown, key: "project" | "canvas"): void {
  const document = value && typeof value === "object" && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
  const version = document && typeof document === "object" && "schemaVersion" in document
    ? (document as { schemaVersion?: unknown }).schemaVersion
    : undefined;
  if (version !== undefined && version !== TOON_FACTORY_SCHEMA_VERSION) {
    throw new ApiError(422, "toon_factory_unsupported_version", `Unsupported Toon Factory ${key} schema version`, {
      kind: key,
      supportedVersion: TOON_FACTORY_SCHEMA_VERSION,
      actualVersion: version,
    });
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

async function readRegularTextSnapshot(root: string, path: string, maxBytes: number): Promise<FileSnapshot | null> {
  let pathMetadata;
  try {
    pathMetadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) {
    throw new ApiError(400, "path_escape", "Toon Factory content path is unsafe");
  }

  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const nonBlocking = process.platform === "win32" ? 0 : constants.O_NONBLOCK;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow | nonBlocking);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ApiError(400, "path_escape", "Toon Factory content path is unsafe");
    }
    throw error;
  }

  try {
    const openedMetadata = await handle.stat();
    const [canonicalRoot, canonicalPath, currentPathMetadata] = await Promise.all([
      realpath(root),
      realpath(path),
      lstat(path),
    ]);
    if (
      !openedMetadata.isFile()
      || currentPathMetadata.isSymbolicLink()
      || !isWithinRoot(canonicalRoot, canonicalPath)
      || openedMetadata.dev !== pathMetadata.dev
      || openedMetadata.ino !== pathMetadata.ino
      || openedMetadata.dev !== currentPathMetadata.dev
      || openedMetadata.ino !== currentPathMetadata.ino
    ) {
      throw new ApiError(400, "path_escape", "Toon Factory content path is unsafe");
    }
    if (openedMetadata.size > maxBytes) {
      throw new ApiError(413, "toon_factory_content_too_large", "Toon Factory content is too large");
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes - totalBytes + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) {
        throw new ApiError(413, "toon_factory_content_too_large", "Toon Factory content is too large");
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks, totalBytes);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ApiError(422, "invalid_toon_text", "Toon Factory content is not valid UTF-8");
    }
    return { content, revision: revision(content), dev: openedMetadata.dev, ino: openedMetadata.ino };
  } finally {
    await handle.close();
  }
}

async function readRegularTextFile(root: string, path: string, maxBytes: number): Promise<string | null> {
  return (await readRegularTextSnapshot(root, path, maxBytes))?.content ?? null;
}

function parseJsonContent<T>(content: string, schema: ZodType<T>, kind: "project" | "canvas"): T {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new ApiError(422, `invalid_toon_${kind}`, `Toon Factory ${kind} contains invalid JSON`);
  }
  return parseVersioned(schema, value, kind);
}

async function readJsonFile<T>(root: string, path: string, schema: ZodType<T>, kind: "project" | "canvas" | "delivery manifest"): Promise<{ value: T; revision: string; snapshot: ExpectedFileSnapshot }> {
  const maxBytes = kind === "project" ? MAX_PROJECT_BYTES : kind === "canvas" ? MAX_CANVAS_BYTES : MAX_DELIVERY_MANIFEST_BYTES;
  const snapshot = await readRegularTextSnapshot(root, path, maxBytes);
  if (snapshot === null) {
    throw new ApiError(404, `toon_${kind.replace(" ", "_")}_not_found`, `Toon Factory ${kind} not found`);
  }
  if (kind === "delivery manifest") {
    let value: unknown;
    try {
      value = JSON.parse(snapshot.content);
    } catch {
      throw new ApiError(422, "invalid_toon_delivery_manifest", "Toon Factory delivery manifest contains invalid JSON");
    }
    return { value: parseVersioned(schema, value, kind), revision: snapshot.revision, snapshot };
  }
  return { value: parseJsonContent(snapshot.content, schema, kind), revision: snapshot.revision, snapshot };
}

async function assertAtomicWriteTarget(root: string, path: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  const relativePath = relative(canonicalRoot, path);
  const resolved = await resolveWithinRoot(canonicalRoot, relativePath);
  if (resolved !== resolve(path)) throw new ApiError(400, "path_escape", "Path escapes workspace root");
  const [parent, canonicalParent] = await Promise.all([lstat(dirname(path)), realpath(dirname(path))]);
  if (
    parent.isSymbolicLink()
    || !parent.isDirectory()
    || !isWithinRoot(canonicalRoot, canonicalParent)
    || canonicalParent !== resolve(dirname(path))
  ) {
    throw new ApiError(400, "path_escape", "Toon Factory content directory is unsafe");
  }
  const target = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (target && (target.isSymbolicLink() || !target.isFile())) {
    throw new ApiError(400, "path_escape", "Toon Factory content path is unsafe");
  }
}

async function atomicWrite(
  root: string,
  path: string,
  content: string,
  expected: ExpectedFileSnapshot | undefined = undefined,
  beforePublish?: (path: string) => void | Promise<void>,
): Promise<void> {
  await assertAtomicWriteTarget(root, path);
  const kind = atomicFileKind(root, path);
  const transactionId = randomUUID();
  const transactionTimestamp = Date.now();
  const artifactStem = `${path}.jugglework-${ATOMIC_PROTOCOL_VERSION}-${kind}-${transactionTimestamp}-${transactionId}`;
  const temporary = `${artifactStem}.tmp`;
  const backup = `${artifactStem}.bak`;
  let backupCreated = false;
  const conflict = async (expectedSnapshot: ExpectedFileSnapshot, currentPath = path): Promise<never> => {
    const current = await readRegularTextSnapshot(root, currentPath, Number.MAX_SAFE_INTEGER).catch(() => null);
    throw new ApiError(409, "toon_factory_revision_conflict", "Toon Factory content changed since it was loaded", {
      expectedRevision: expectedSnapshot?.revision ?? null,
      currentRevision: current?.revision ?? null,
      recoveryBackup: await lstat(backup).then(() => relative(root, backup).split(sep).join("/")).catch(() => null),
    });
  };
  try {
    await recoverAtomicTarget(root, path, true);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertAtomicWriteTarget(root, path);
    const expectedSnapshot = expected === undefined
      ? await readRegularTextSnapshot(root, path, Number.MAX_SAFE_INTEGER)
      : expected;
    if (expectedSnapshot !== null) {
      try {
        await rename(path, backup);
        backupCreated = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return await conflict(expectedSnapshot);
        throwCasUnsupported(error);
      }
      const moved = await readRegularTextSnapshot(root, backup, Number.MAX_SAFE_INTEGER);
      if (!moved || moved.revision !== expectedSnapshot.revision || moved.dev !== expectedSnapshot.dev || moved.ino !== expectedSnapshot.ino) {
        await restoreBackupWithoutOverwrite(backup, path);
        backupCreated = false;
        return await conflict(expectedSnapshot, backup);
      }
    } else if (await readRegularTextSnapshot(root, path, Number.MAX_SAFE_INTEGER)) {
      return await conflict(expectedSnapshot);
    }
    await beforePublish?.(path);
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return await conflict(expectedSnapshot);
      throwCasUnsupported(error);
    }
    await unlink(temporary);
    await rm(backup, { force: true });
    backupCreated = false;
    await syncDirectory(dirname(path));
  } catch (error) {
    if (backupCreated) await restoreBackupWithoutOverwrite(backup, path);
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function parseAtomicArtifact(directory: string, name: string): AtomicArtifact | null {
  const match = name.match(ATOMIC_ARTIFACT_PATTERN);
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5]) return null;
  return {
    name,
    path: join(directory, name),
    targetName: match[1],
    kind: match[2] as AtomicFileKind,
    timestamp: Number(match[3]),
    transactionId: match[4],
    extension: match[5] as "bak" | "tmp",
  };
}

function atomicFileKind(root: string, path: string): AtomicFileKind {
  const parts = relative(root, path).split(sep);
  if (basename(path) === PROJECT_FILE) return "project";
  if (parts.at(-2) === "canvases" && extname(path) === ".json") return "canvas";
  if (parts.at(-3) === "content" && parts.at(-2) === "nodes" && extname(path) === ".md") return "text";
  if (extname(path) === ".json" && (parts.includes("generations") || parts.includes("exports"))) return "json";
  throw new ApiError(400, "toon_factory_atomic_path_invalid", "Path is not a supported Toon Factory atomic file");
}

function assertAtomicArtifactMatchesTarget(root: string, target: string, artifact: AtomicArtifact): void {
  if (artifact.targetName !== basename(target) || artifact.kind !== atomicFileKind(root, target)) {
    throw new ApiError(409, "toon_factory_recovery_conflict", "Toon Factory recovery artifacts do not match their target");
  }
}

async function validateAtomicContent(root: string, path: string, kind: AtomicFileKind): Promise<FileSnapshot> {
  const maxBytes = kind === "project" ? MAX_PROJECT_BYTES : kind === "canvas" ? MAX_CANVAS_BYTES
    : kind === "text" ? MAX_TEXT_BYTES : MAX_DELIVERY_MANIFEST_BYTES;
  const snapshot = await readRegularTextSnapshot(root, path, maxBytes);
  if (!snapshot) throw new ApiError(409, "toon_factory_recovery_conflict", "Toon Factory recovery artifact disappeared during validation");
  if (kind === "text") {
    return snapshot;
  }
  let value: unknown;
  try { value = JSON.parse(snapshot.content); } catch {
    throw new ApiError(409, "toon_factory_recovery_conflict", "Toon Factory recovery artifact contains invalid JSON");
  }
  if (kind === "project") parseVersioned(toonProjectSchema, value, "project");
  if (kind === "canvas") parseVersioned(toonCanvasSchema, value, "canvas");
  return snapshot;
}

async function removeAtomicArtifacts(artifacts: readonly AtomicArtifact[]): Promise<void> {
  await Promise.all(artifacts.map((artifact) => rm(artifact.path, { force: true })));
}

async function recoverAtomicTarget(root: string, path: string, calledFromWrite = false): Promise<void> {
  const artifacts = (await readdir(dirname(path)))
    .map((name) => parseAtomicArtifact(dirname(path), name))
    .filter((artifact): artifact is AtomicArtifact => artifact?.targetName === basename(path));
  if (artifacts.length === 0) return;
  await assertAtomicWriteTarget(root, path);
  for (const artifact of artifacts) assertAtomicArtifactMatchesTarget(root, path, artifact);
  if (!calledFromWrite && writeQueues.has(path)) {
    throw new ApiError(503, "toon_factory_recovery_in_progress", "Toon Factory content is being atomically published; retry the read");
  }

  const target = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (target) {
    if (target.isSymbolicLink() || !target.isFile()) {
      throw new ApiError(409, "toon_factory_recovery_conflict", "Toon Factory recovery target is unsafe");
    }
    await validateAtomicContent(root, path, atomicFileKind(root, path));
    await removeAtomicArtifacts(artifacts);
    await syncDirectory(dirname(path));
    return;
  }
  const grouped = new Map<string, { backup?: AtomicArtifact; temporary?: AtomicArtifact }>();
  for (const artifact of artifacts) {
    const group = grouped.get(artifact.transactionId) ?? {};
    if (artifact.extension === "bak") group.backup = artifact;
    else group.temporary = artifact;
    grouped.set(artifact.transactionId, group);
  }
  const incomplete = [...grouped.values()].some((group) => !group.backup || !group.temporary);
  if (incomplete) {
    throw new ApiError(409, "toon_factory_recovery_conflict", "Incomplete Toon Factory recovery artifacts require manual recovery", {
      target: relative(root, path).split(sep).join("/"),
    });
  }

  const candidates = await Promise.all([...grouped.values()].map(async (group) => {
    const backup = group.backup!;
    const temporary = group.temporary!;
    const [backupSnapshot, backupMetadata] = await Promise.all([
      validateAtomicContent(root, backup.path, backup.kind),
      lstat(backup.path),
      validateAtomicContent(root, temporary.path, temporary.kind),
    ]);
    return { backup, temporary, backupSnapshot, mtimeMs: backupMetadata.mtimeMs };
  }));
  candidates.sort((left, right) => right.backup.timestamp - left.backup.timestamp);
  const newestByProtocol = candidates.filter((candidate) => candidate.backup.timestamp === candidates[0]!.backup.timestamp);
  const newestMtime = Math.max(...candidates.map((candidate) => candidate.mtimeMs));
  const newestByMtime = candidates.filter((candidate) => candidate.mtimeMs === newestMtime);
  const selected = newestByProtocol.length === 1 && newestByMtime.length === 1 && newestByProtocol[0] === newestByMtime[0]
    ? newestByProtocol[0]
    : null;
  if (!selected) {
    throw new ApiError(409, "toon_factory_recovery_conflict", "Ambiguous Toon Factory backups require manual recovery", {
      target: relative(root, path).split(sep).join("/"),
      candidates: candidates.map((candidate) => relative(root, candidate.backup.path).split(sep).join("/")),
    });
  }

  const beforeLink = await lstat(selected.backup.path);
  if (beforeLink.isSymbolicLink() || !beforeLink.isFile()
    || beforeLink.dev !== selected.backupSnapshot.dev || beforeLink.ino !== selected.backupSnapshot.ino) {
    throw new ApiError(409, "toon_factory_recovery_conflict", "Toon Factory recovery artifact changed during validation");
  }
  try {
    await link(selected.backup.path, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ApiError(409, "toon_factory_recovery_conflict", "Toon Factory content changed during recovery");
    }
    throwCasUnsupported(error);
  }
  const restored = await lstat(path);
  if (restored.isSymbolicLink() || !restored.isFile()
    || restored.dev !== selected.backupSnapshot.dev || restored.ino !== selected.backupSnapshot.ino) {
    await unlink(path).catch(() => undefined);
    throw new ApiError(409, "toon_factory_recovery_conflict", "Toon Factory recovery publication was unsafe");
  }
  await syncDirectory(dirname(path));
  await removeAtomicArtifacts(artifacts);
  await syncDirectory(dirname(path));
}

async function recoverAtomicDirectory(root: string, directory: string): Promise<void> {
  const targets = new Set<string>();
  const canonicalDirectory = await realpath(directory);
  for (const name of await readdir(directory)) {
    const artifact = parseAtomicArtifact(directory, name);
    if (!artifact) continue;
    const target = join(canonicalDirectory, artifact.targetName);
    try {
      atomicFileKind(root, target);
    } catch (error) {
      if (error instanceof ApiError && error.code === "toon_factory_atomic_path_invalid") continue;
      throw error;
    }
    targets.add(target);
  }
  for (const target of targets) await recoverAtomicTarget(root, target);
}

async function restoreBackupWithoutOverwrite(backup: string, path: string): Promise<void> {
  try {
    await link(backup, path);
    await unlink(backup);
    await syncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throwCasUnsupported(error);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

function throwCasUnsupported(error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(code ?? "")) {
    throw new ApiError(409, "toon_factory_cas_unsupported", "This filesystem cannot guarantee non-overwriting Toon Factory publication");
  }
  throw error;
}

function assertExpectedRevision(expectedRevision: string | null | undefined, currentRevision: string | null): void {
  if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
    throw new ApiError(409, "toon_factory_revision_conflict", "Toon Factory content changed since it was loaded", {
      expectedRevision,
      currentRevision,
    });
  }
}

async function serializeWrite<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveQueue) => { release = resolveQueue; });
  const queued = previous.then(() => current);
  writeQueues.set(path, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (writeQueues.get(path) === queued) writeQueues.delete(path);
  }
}

function parseIdentifier(value: string, kind: string): string {
  const parsed = toonIdentifierSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, `invalid_toon_${kind}_id`, `Invalid Toon Factory ${kind} ID`);
  return parsed.data;
}

async function ensureSafeDirectory(root: string, relativePath: string): Promise<string> {
  const target = await resolveWithinRoot(root, relativePath);
  const canonicalRoot = await realpath(root);
  const parts = relative(canonicalRoot, target).split(sep).filter(Boolean);
  let current = canonicalRoot;
  for (const part of parts) {
    current = join(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new ApiError(400, "path_escape", "Project path traverses an unsafe filesystem entry");
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }
  return target;
}

async function existingSafeFile(root: string, relativePath: string): Promise<string> {
  const path = await resolveWithinRoot(root, relativePath);
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new ApiError(404, "toon_factory_content_not_found", "Toon Factory content not found");
  }
  return path;
}

async function optionalSafeFile(root: string, relativePath: string): Promise<string> {
  const path = await resolveWithinRoot(root, relativePath);
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) {
    throw new ApiError(400, "path_escape", "Toon Factory content path is unsafe");
  }
  return path;
}

export class ToonFactoryRepository {
  readonly workspaceRoot: string;

  constructor(workspaceRoot: string, private readonly hooks: ToonFactoryRepositoryHooks = {}) {
    this.workspaceRoot = resolve(workspaceRoot);
  }

  async recoverWorkspace(): Promise<void> {
    let visited = 0;
    const visit = async (directory: string): Promise<void> => {
      if (++visited > MAX_DISCOVERY_DIRECTORIES) {
        throw new ApiError(422, "toon_factory_recovery_limit", "Too many workspace directories to recover Toon Factory files");
      }
      await recoverAtomicDirectory(this.workspaceRoot, directory);
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || DISCOVERY_EXCLUDES.has(entry.name)) continue;
        await visit(join(directory, entry.name));
      }
    };
    await visit(this.workspaceRoot);
  }

  async listProjects(): Promise<ToonProjectListResponse> {
    const items: ToonProjectSummary[] = [];
    let visited = 0;
    const visit = async (directory: string): Promise<void> => {
      if (++visited > MAX_DISCOVERY_DIRECTORIES) {
        throw new ApiError(422, "toon_factory_discovery_limit", "Too many workspace directories to discover Toon Factory projects");
      }
      await recoverAtomicDirectory(this.workspaceRoot, directory);
      const entries = await readdir(directory, { withFileTypes: true });
      if (entries.some((entry) => entry.name === PROJECT_FILE && entry.isFile() && !entry.isSymbolicLink())) {
        const projectPath = await existingSafeFile(this.workspaceRoot, relative(this.workspaceRoot, join(directory, PROJECT_FILE)));
        const result = await readJsonFile(this.workspaceRoot, projectPath, toonProjectSchema, "project");
        items.push({
          id: result.value.id,
          name: result.value.name,
          directory: relative(this.workspaceRoot, directory).split(sep).join("/"),
          updatedAt: result.value.updatedAt,
          episodeCount: result.value.episodes.length,
          revision: result.revision,
        });
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || DISCOVERY_EXCLUDES.has(entry.name)) continue;
        await visit(join(directory, entry.name));
      }
    };
    await visit(this.workspaceRoot);
    return { schemaVersion: TOON_FACTORY_SCHEMA_VERSION, items: items.sort((a, b) => a.directory.localeCompare(b.directory)) };
  }

  async createProject(input: unknown): Promise<ToonProjectResponse> {
    const request = parseInput(toonProjectCreateRequestSchema, input, "invalid_toon_project_request") as ToonProjectCreateRequest;
    const directory = request.directory;
    const projectRoot = await resolveWithinRoot(this.workspaceRoot, directory);
    const existing = await lstat(projectRoot).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (existing) throw new ApiError(409, "toon_project_directory_exists", "Project directory already exists");

    const now = new Date().toISOString();
    const id = `toon-${randomUUID()}`;
    const project: ToonProject = {
      schemaVersion: TOON_FACTORY_SCHEMA_VERSION,
      id,
      name: request.name,
      createdAt: now,
      updatedAt: now,
      episodes: [],
    };
    const canvas: ToonCanvas = {
      schemaVersion: TOON_FACTORY_SCHEMA_VERSION,
      id: "main",
      name: "Main",
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };

    let createdProjectRoot = false;
    try {
      const parent = dirname(directory);
      if (parent !== ".") await ensureSafeDirectory(this.workspaceRoot, parent);
      try {
        await mkdir(projectRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new ApiError(409, "toon_project_directory_exists", "Project directory already exists");
        }
        throw error;
      }
      createdProjectRoot = true;
      for (const child of ["canvases", "content/nodes", "assets", "generations/manifests", "exports"]) {
        await ensureSafeDirectory(this.workspaceRoot, `${directory}/${child}`);
      }
      await atomicWrite(this.workspaceRoot, join(projectRoot, PROJECT_FILE), jsonContent(project));
      await atomicWrite(this.workspaceRoot, join(projectRoot, "canvases", "main.json"), jsonContent(canvas));
    } catch (error) {
      if (createdProjectRoot) await rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return this.projectResponse(directory, project, revision(jsonContent(project)));
  }

  async getProject(projectId: string): Promise<ToonProjectResponse> {
    const summary = await this.findProject(projectId);
    const path = await existingSafeFile(this.workspaceRoot, `${summary.directory}/${PROJECT_FILE}`);
    const result = await readJsonFile(this.workspaceRoot, path, toonProjectSchema, "project");
    return this.projectResponse(summary.directory, result.value, result.revision);
  }

  async assertTextJobPrerequisites(projectId: string, request: Pick<ToonTextJob, "episodeId" | "canvasId" | "nodeId" | "stage" | "action">): Promise<void> {
    const expected = textWorkflowTarget(request.action);
    if (request.stage !== expected.stage) throw workflowPrerequisiteError();
    const project = await this.getProject(projectId);
    const episode = project.project.episodes.find((item) => item.id === request.episodeId && item.canvasId === request.canvasId);
    const step = episode?.steps?.find((item) => item.id === expected.stepId && item.stage === expected.stage);
    if (!episode || !step || !workflowStepIsAvailable(episode.steps ?? [], step)) throw workflowPrerequisiteError();
    const canvas = await this.readCanvas(projectId, request.canvasId);
    if (!canvas.canvas.nodes.some((node) => node.id === request.nodeId)) throw workflowPrerequisiteError();
  }

  async assertMediaJobPrerequisites(projectId: string, request: Pick<ToonMediaJob, "episodeId" | "canvasId" | "nodeId" | "stepId" | "kind">): Promise<void> {
    const expected = request.kind === "image"
      ? { stage: "images" as const, stepId: "image-candidates", nodeKind: "image-generation" as const }
      : { stage: "videos" as const, stepId: "video-clips", nodeKind: "video-generation" as const };
    if (request.stepId !== expected.stepId) throw workflowPrerequisiteError();
    const project = await this.getProject(projectId);
    const episode = project.project.episodes.find((item) => item.id === request.episodeId && item.canvasId === request.canvasId);
    const step = episode?.steps?.find((item) => item.id === expected.stepId && item.stage === expected.stage);
    if (!episode || !step || !workflowStepIsAvailable(episode.steps ?? [], step)) throw workflowPrerequisiteError();
    const canvas = await this.readCanvas(projectId, request.canvasId);
    if (canvas.canvas.nodes.find((node) => node.id === request.nodeId)?.kind !== expected.nodeKind) throw workflowPrerequisiteError();
  }

  async resolveMediaReference(projectId: string, reference: ToonFileReference): Promise<string> {
    const project = await this.getProject(projectId);
    const relativePath = reference.scope === "project" ? `${project.directory}/${reference.path}` : reference.path;
    return existingSafeFile(this.workspaceRoot, relativePath);
  }

  async updateProject(projectId: string, input: unknown): Promise<ToonProjectResponse> {
    assertRequestedVersion(input, "project");
    const request = parseInput(toonProjectUpdateRequestSchema, input, "invalid_toon_project_request") as ToonProjectUpdateRequest;
    if (request.project.id !== projectId) throw new ApiError(400, "toon_project_id_mismatch", "Project ID cannot be changed");
    const summary = await this.findProject(projectId);
    const path = await existingSafeFile(this.workspaceRoot, `${summary.directory}/${PROJECT_FILE}`);
    return serializeWrite(path, async () => {
      const current = await readJsonFile(this.workspaceRoot, path, toonProjectSchema, "project");
      assertExpectedRevision(request.expectedRevision, current.revision);
      const content = jsonContent(request.project);
      await atomicWrite(this.workspaceRoot, path, content, current.snapshot, this.hooks.beforeAtomicPublish);
      return this.projectResponse(summary.directory, request.project, revision(content));
    });
  }

  async readCanvas(projectId: string, canvasId: string): Promise<ToonCanvasResponse> {
    parseIdentifier(canvasId, "canvas");
    const project = await this.findProject(projectId);
    const candidate = await resolveWithinRoot(this.workspaceRoot, `${project.directory}/canvases/${canvasId}.json`);
    await recoverAtomicTarget(this.workspaceRoot, candidate);
    const path = await existingSafeFile(this.workspaceRoot, `${project.directory}/canvases/${canvasId}.json`);
    const result = await readJsonFile(this.workspaceRoot, path, toonCanvasSchema, "canvas");
    return { canvas: result.value, revision: result.revision };
  }

  async writeCanvas(projectId: string, canvasId: string, input: unknown): Promise<ToonCanvasResponse> {
    parseIdentifier(canvasId, "canvas");
    assertRequestedVersion(input, "canvas");
    const request = parseInput(toonCanvasWriteRequestSchema, input, "invalid_toon_canvas");
    if (request.canvas.id !== canvasId) throw new ApiError(400, "toon_canvas_id_mismatch", "Canvas ID cannot be changed");
    const project = await this.findProject(projectId);
    const relativePath = `${project.directory}/canvases/${canvasId}.json`;
    const path = await optionalSafeFile(this.workspaceRoot, relativePath);
    return serializeWrite(path, async () => {
      const current = await readRegularTextSnapshot(this.workspaceRoot, path, MAX_CANVAS_BYTES);
      if (current !== null) parseJsonContent(current.content, toonCanvasSchema, "canvas");
      assertExpectedRevision(request.expectedRevision, current?.revision ?? null);
      const content = jsonContent(request.canvas);
      await atomicWrite(this.workspaceRoot, path, content, current, this.hooks.beforeAtomicPublish);
      return { canvas: request.canvas, revision: revision(content) };
    });
  }

  async readText(projectId: string, nodeId: string): Promise<ToonTextResponse> {
    parseIdentifier(nodeId, "node");
    const project = await this.findProject(projectId);
    const candidate = await resolveWithinRoot(this.workspaceRoot, `${project.directory}/content/nodes/${nodeId}.md`);
    await recoverAtomicTarget(this.workspaceRoot, candidate);
    const path = await existingSafeFile(this.workspaceRoot, `${project.directory}/content/nodes/${nodeId}.md`);
    const content = await readRegularTextFile(this.workspaceRoot, path, MAX_TEXT_BYTES);
    if (content === null) throw new ApiError(404, "toon_factory_content_not_found", "Toon Factory content not found");
    return { nodeId, content, revision: revision(content) };
  }

  async writeText(projectId: string, nodeId: string, input: unknown): Promise<ToonTextResponse> {
    parseIdentifier(nodeId, "node");
    const request = parseInput(toonTextWriteRequestSchema, input, "invalid_toon_text") as ToonTextWriteRequest;
    const project = await this.findProject(projectId);
    const path = await optionalSafeFile(this.workspaceRoot, `${project.directory}/content/nodes/${nodeId}.md`);
    return serializeWrite(path, async () => {
      const current = await readRegularTextSnapshot(this.workspaceRoot, path, MAX_TEXT_BYTES);
      assertExpectedRevision(request.expectedRevision, current?.revision ?? null);
      await atomicWrite(this.workspaceRoot, path, request.content, current, this.hooks.beforeAtomicPublish);
      return { nodeId, content: request.content, revision: revision(request.content) };
    });
  }

  async commitTextJobResult(job: ToonTextJob, output: unknown): Promise<ToonTextJobResult> {
    parseIdentifier(job.nodeId, "node");
    const summary = await this.findProject(job.projectId);
    const projectPath = await existingSafeFile(this.workspaceRoot, `${summary.directory}/${PROJECT_FILE}`);
    return serializeWrite(projectPath, async () => {
      const current = await readJsonFile(this.workspaceRoot, projectPath, toonProjectSchema, "project");
      const episode = current.value.episodes.find((candidate) => candidate.id === job.episodeId);
      if (!episode || episode.canvasId !== job.canvasId) {
        throw new ApiError(409, "toon_text_job_target_changed", "The Toon Factory episode target changed before generation completed");
      }
      const canvas = await this.readCanvas(job.projectId, job.canvasId);
      if (!canvas.canvas.nodes.some((node) => node.id === job.nodeId)) {
        throw new ApiError(409, "toon_text_job_target_changed", "The Toon Factory node target changed before generation completed");
      }
      const stepId = actionStepId(job.action);
      const step = episode.steps?.find((candidate) => candidate.id === stepId);
      if (!step || step.stage !== job.stage) {
        throw new ApiError(409, "toon_text_job_target_changed", "The Toon Factory workflow target changed before generation completed");
      }

      const now = new Date().toISOString();
      const resultId = `result-${job.id}`;
      const contentRef = `content/nodes/${job.nodeId}.${job.id}.md`;
      const resultRef = `generations/manifests/${job.id}.json`;
      const existingResult = step.generatedResults?.find((result) => result.jobId === job.id);
      if (existingResult) {
        const manifestPath = join(dirname(projectPath), existingResult.resultRef);
        const manifestContent = await readRegularTextFile(this.workspaceRoot, manifestPath, MAX_DELIVERY_MANIFEST_BYTES);
        if (manifestContent === null) throw new ApiError(409, "toon_text_result_incomplete", "The persisted Toon Factory text result is incomplete");
        const manifest = JSON.parse(manifestContent) as { output?: unknown };
        return {
          workflowRecordId: existingResult.id,
          resultRef: existingResult.resultRef,
          contentRef: existingResult.contentRef,
          outputRevision: existingResult.outputRevision,
          output: manifest.output,
        };
      }
      const validatedOutput = toonTextActionOutputSchemas[job.action].safeParse(output);
      if (!validatedOutput.success) {
        throw new ApiError(422, "toon_text_result_malformed", "The model returned an invalid structured result", {
          issues: validatedOutput.error.issues,
        });
      }
      const content = renderGeneratedText(job.action, validatedOutput.data);
      const outputRevision = revision(content);
      const generatedResult = {
        id: resultId,
        jobId: job.id,
        action: job.action,
        status: "awaiting-review" as const,
        nodeId: job.nodeId,
        resultRef,
        contentRef,
        outputRevision,
        recordedAt: now,
      };
      const manifest = {
        schemaVersion: TOON_FACTORY_SCHEMA_VERSION,
        id: resultId,
        jobId: job.id,
        request: job.requestSnapshot,
        selectedModel: job.selectedModel,
        outputSchema: job.outputSchema,
        output: validatedOutput.data,
        outputRevision,
        status: "awaiting-review",
        contentRef,
        recordedAt: now,
      };
      const updatedProject: ToonProject = {
        ...current.value,
        episodes: current.value.episodes.map((candidate) => candidate.id !== episode.id ? candidate : {
          ...candidate,
          steps: candidate.steps?.map((candidateStep) => candidateStep.id !== step.id ? candidateStep : {
            ...candidateStep,
            status: "awaiting-review",
            outputRevision,
            generationJobId: job.id,
            generatedResults: [...(candidateStep.generatedResults ?? []), generatedResult],
            history: [...candidateStep.history, {
              id: `version-${candidateStep.id}-${candidateStep.history.length + 1}`,
              status: candidateStep.status,
              ...(candidateStep.inputRevision ? { inputRevision: candidateStep.inputRevision } : {}),
              ...(candidateStep.outputRevision ? { outputRevision: candidateStep.outputRevision } : {}),
              recordedAt: now,
            }],
            updatedAt: now,
          }),
          stages: candidate.stages.map((stage) => stage.stage === job.stage
            ? { ...stage, status: "awaiting-review" as const, outputRevision, updatedAt: now }
            : stage),
          updatedAt: now,
        }),
        updatedAt: now,
      };

      const projectRoot = dirname(projectPath);
      await atomicWrite(this.workspaceRoot, join(projectRoot, contentRef), content);
      await atomicWrite(this.workspaceRoot, join(projectRoot, resultRef), jsonContent(manifest));
       await atomicWrite(this.workspaceRoot, projectPath, jsonContent(updatedProject), current.snapshot, this.hooks.beforeAtomicPublish);
      return { workflowRecordId: resultId, resultRef, contentRef, outputRevision, output: validatedOutput.data };
    });
  }

  async readCommittedTextJobResult(job: ToonTextJob): Promise<ToonTextJobResult | null> {
    const project = await this.getProject(job.projectId);
    const episode = project.project.episodes.find((item) => item.id === job.episodeId);
    const result = episode?.steps?.find((step) => step.id === actionStepId(job.action))
      ?.generatedResults?.find((item) => item.jobId === job.id);
    if (!result) return null;
    const manifestPath = await existingSafeFile(this.workspaceRoot, `${project.directory}/${result.resultRef}`);
    const content = await readRegularTextFile(this.workspaceRoot, manifestPath, MAX_DELIVERY_MANIFEST_BYTES);
    if (content === null) return null;
    let manifest: { output?: unknown };
    try { manifest = JSON.parse(content) as { output?: unknown }; } catch { return null; }
    return {
      workflowRecordId: result.id,
      resultRef: result.resultRef,
      contentRef: result.contentRef,
      outputRevision: result.outputRevision,
      output: manifest.output,
    };
  }

  async queueTextJob(job: ToonTextJob): Promise<ToonProjectResponse> {
    await this.assertTextJobPrerequisites(job.projectId, job);
    const summary = await this.findProject(job.projectId);
    const projectPath = await existingSafeFile(this.workspaceRoot, `${summary.directory}/${PROJECT_FILE}`);
    return serializeWrite(projectPath, async () => {
      const current = await readJsonFile(this.workspaceRoot, projectPath, toonProjectSchema, "project");
      const episode = current.value.episodes.find((candidate) => candidate.id === job.episodeId);
      const stepId = actionStepId(job.action);
      const step = episode?.steps?.find((candidate) => candidate.id === stepId);
      if (!episode || episode.canvasId !== job.canvasId || !step || step.stage !== job.stage) {
        throw new ApiError(409, "toon_text_job_target_changed", "The Toon Factory workflow target is unavailable");
      }
      const canvas = await this.readCanvas(job.projectId, job.canvasId);
      if (!canvas.canvas.nodes.some((node) => node.id === job.nodeId)) {
        throw new ApiError(409, "toon_text_job_target_changed", "The Toon Factory node target is unavailable");
      }
      const now = new Date().toISOString();
      const project: ToonProject = {
        ...current.value,
        episodes: current.value.episodes.map((candidate) => candidate.id !== episode.id ? candidate : {
          ...candidate,
          steps: candidate.steps?.map((candidateStep) => candidateStep.id !== step.id ? candidateStep : {
            ...candidateStep,
            status: "queued",
            generationJobId: job.id,
            updatedAt: now,
          }),
          stages: candidate.stages.map((stage) => stage.stage === job.stage
            ? { ...stage, status: "queued" as const, updatedAt: now }
            : stage),
          updatedAt: now,
        }),
        updatedAt: now,
      };
      const content = jsonContent(project);
      await atomicWrite(this.workspaceRoot, projectPath, content, current.snapshot, this.hooks.beforeAtomicPublish);
      return this.projectResponse(summary.directory, project, revision(content));
    });
  }

  async ownsTextJob(job: ToonTextJob): Promise<boolean> {
    const project = await this.getProject(job.projectId);
    const episode = project.project.episodes.find((item) => item.id === job.episodeId && item.canvasId === job.canvasId);
    const step = episode?.steps?.find((item) => item.id === actionStepId(job.action) && item.stage === job.stage);
    if (!step || step.generationJobId !== job.id) return false;
    const canvas = await this.readCanvas(job.projectId, job.canvasId);
    return canvas.canvas.nodes.some((node) => node.id === job.nodeId);
  }

  async reconcileTextJob(job: ToonTextJob): Promise<ToonProjectResponse> {
    const summary = await this.findProject(job.projectId);
    const projectPath = await existingSafeFile(this.workspaceRoot, `${summary.directory}/${PROJECT_FILE}`);
    return serializeWrite(projectPath, async () => {
      const current = await readJsonFile(this.workspaceRoot, projectPath, toonProjectSchema, "project");
      const episode = current.value.episodes.find((item) => item.id === job.episodeId);
      const stepId = actionStepId(job.action);
      const step = episode?.steps?.find((item) => item.id === stepId);
      if (!episode || !step || step.generationJobId !== job.id) {
        return this.projectResponse(summary.directory, current.value, current.revision);
      }
      const status = job.status === "queued" ? "queued"
        : job.status === "running" || job.status === "cancel_requested" ? "running"
          : job.status === "completed" ? "awaiting-review"
            : job.status === "cancelled" ? "cancelled" : "failed";
      if (step.status === status) return this.projectResponse(summary.directory, current.value, current.revision);
      const now = new Date().toISOString();
      const project: ToonProject = {
        ...current.value,
        episodes: current.value.episodes.map((item) => item.id !== episode.id ? item : {
          ...item,
          steps: item.steps?.map((itemStep) => itemStep.id === step.id && itemStep.generationJobId === job.id
            ? { ...itemStep, status, updatedAt: now }
            : itemStep),
          stages: item.stages.map((stage) => stage.stage === job.stage ? { ...stage, status, updatedAt: now } : stage),
          updatedAt: now,
        }),
        updatedAt: now,
      };
      const content = jsonContent(project);
      await atomicWrite(this.workspaceRoot, projectPath, content, current.snapshot, this.hooks.beforeAtomicPublish);
      return this.projectResponse(summary.directory, project, revision(content));
    });
  }

  async writeMediaJobManifest(job: ToonMediaJob): Promise<void> {
    const summary = await this.findProject(job.projectId);
    const path = await optionalSafeFile(this.workspaceRoot, `${summary.directory}/generations/manifests/${job.id}.json`);
    await serializeWrite(path, () => atomicWrite(this.workspaceRoot, path, jsonContent(job)));
  }

  async reconcileMediaJob(job: ToonMediaJob): Promise<ToonProjectResponse> {
    const summary = await this.findProject(job.projectId);
    const projectPath = await existingSafeFile(this.workspaceRoot, `${summary.directory}/${PROJECT_FILE}`);
    return serializeWrite(projectPath, async () => {
      const current = await readJsonFile(this.workspaceRoot, projectPath, toonProjectSchema, "project");
      const episode = current.value.episodes.find((item) => item.id === job.episodeId);
      const step = episode?.steps?.find((item) => item.id === job.stepId);
      if (!episode || !step || step.generationJobId !== job.id) {
        return this.projectResponse(summary.directory, current.value, current.revision);
      }
      const status = workflowStatusForMediaJob(job);
      const now = new Date().toISOString();
      const project: ToonProject = {
        ...current.value,
        episodes: current.value.episodes.map((item) => item.id !== episode.id ? item : {
          ...item,
          steps: item.steps?.map((itemStep) => itemStep.id !== step.id || itemStep.generationJobId !== job.id
            ? itemStep
            : { ...itemStep, status, updatedAt: now }),
          stages: item.stages.map((stage) => stage.stage === step.stage ? { ...stage, status, updatedAt: now } : stage),
          updatedAt: now,
        }),
        updatedAt: now,
      };
      const content = jsonContent(project);
      await atomicWrite(this.workspaceRoot, projectPath, content, current.snapshot, this.hooks.beforeAtomicPublish);
      return this.projectResponse(summary.directory, project, revision(content));
    });
  }

  async queueMediaJob(job: ToonMediaJob): Promise<ToonProjectResponse> {
    await this.assertMediaJobPrerequisites(job.projectId, job);
    const summary = await this.findProject(job.projectId);
    const projectPath = await existingSafeFile(this.workspaceRoot, `${summary.directory}/${PROJECT_FILE}`);
    return serializeWrite(projectPath, async () => {
      const current = await readJsonFile(this.workspaceRoot, projectPath, toonProjectSchema, "project");
      const episode = current.value.episodes.find((item) => item.id === job.episodeId);
      const step = episode?.steps?.find((item) => item.id === job.stepId);
      if (!episode || episode.canvasId !== job.canvasId || !step) {
        throw new ApiError(409, "toon_media_job_target_changed", "The Toon Factory workflow target is unavailable");
      }
      const canvas = await this.readCanvas(job.projectId, job.canvasId);
      if (!canvas.canvas.nodes.some((node) => node.id === job.nodeId)) {
        throw new ApiError(409, "toon_media_job_target_changed", "The Toon Factory node target is unavailable");
      }
      const now = new Date().toISOString();
      const project: ToonProject = {
        ...current.value,
        episodes: current.value.episodes.map((item) => item.id !== episode.id ? item : {
          ...item,
          steps: item.steps?.map((itemStep) => itemStep.id !== step.id ? itemStep : {
            ...itemStep,
            status: "queued",
            generationJobId: job.id,
            computeAuthorizations: itemStep.computeAuthorizations.some((authorization) => authorization.id === job.authorization.id)
              ? itemStep.computeAuthorizations
              : [...itemStep.computeAuthorizations, {
                  id: job.authorization.id,
                  scopeRevision: job.authorization.scopeHash,
                  authorizedAt: job.authorization.authorizedAt,
                }],
            updatedAt: now,
          }),
          stages: item.stages.map((stage) => stage.stage === step.stage ? { ...stage, status: "queued" as const, updatedAt: now } : stage),
          updatedAt: now,
        }),
        updatedAt: now,
      };
      const content = jsonContent(project);
      await atomicWrite(this.workspaceRoot, projectPath, content, current.snapshot, this.hooks.beforeAtomicPublish);
      return this.projectResponse(summary.directory, project, revision(content));
    });
  }

  async ownsMediaJob(job: ToonMediaJob): Promise<boolean> {
    const project = await this.getProject(job.projectId);
    const episode = project.project.episodes.find((item) => item.id === job.episodeId && item.canvasId === job.canvasId);
    const step = episode?.steps?.find((item) => item.id === job.stepId);
    if (!step || step.generationJobId !== job.id) return false;
    const canvas = await this.readCanvas(job.projectId, job.canvasId);
    return canvas.canvas.nodes.some((node) => node.id === job.nodeId);
  }

  async adoptMediaCandidate(job: ToonMediaJob, candidate: ToonMediaCandidate): Promise<ToonProjectResponse> {
    if (!candidate.artifact) throw new ApiError(409, "toon_media_artifact_missing", "The selected candidate has no published artifact");
    await this.resolveMediaReference(job.projectId, candidate.artifact);
    const summary = await this.findProject(job.projectId);
    const projectPath = await existingSafeFile(this.workspaceRoot, `${summary.directory}/${PROJECT_FILE}`);
    return serializeWrite(projectPath, async () => {
      const current = await readJsonFile(this.workspaceRoot, projectPath, toonProjectSchema, "project");
      const episode = current.value.episodes.find((item) => item.id === job.episodeId);
      const step = episode?.steps?.find((item) => item.id === job.stepId);
      if (!episode || episode.canvasId !== job.canvasId || !step) {
        throw new ApiError(409, "toon_media_job_target_changed", "The Toon Factory workflow target is unavailable");
      }
      if (step.generationJobId !== job.id) {
        throw new ApiError(409, "toon_media_job_superseded", "A newer Toon Factory generation job owns this workflow step");
      }
      const activeAdoption = step.resultAdoptions.find((adoption) => !adoption.supersededAt && adoption.resultId === candidate.id);
      const canvasPath = await existingSafeFile(this.workspaceRoot, `${summary.directory}/canvases/${job.canvasId}.json`);
      if (activeAdoption) {
        const canvas = await readJsonFile(this.workspaceRoot, canvasPath, toonCanvasSchema, "canvas");
        if (canvas.value.nodes.find((node) => node.id === job.nodeId)?.data.generationRecordId !== job.id) {
          const nextCanvas: ToonCanvas = {
            ...canvas.value,
            nodes: canvas.value.nodes.map((node) => node.id === job.nodeId
              ? { ...node, data: { ...node.data, generationRecordId: job.id } }
              : node),
          };
          await atomicWrite(this.workspaceRoot, canvasPath, jsonContent(nextCanvas), canvas.snapshot, this.hooks.beforeAtomicPublish);
        }
        return this.projectResponse(summary.directory, current.value, current.revision);
      }
      const now = new Date().toISOString();
      const nextProject: ToonProject = {
        ...current.value,
        episodes: current.value.episodes.map((item) => item.id !== episode.id ? item : {
          ...item,
          steps: item.steps?.map((itemStep) => itemStep.id !== step.id ? itemStep : {
            ...itemStep,
            status: "adopted",
            resultAdoptions: itemStep.resultAdoptions.some((adoption) => !adoption.supersededAt && adoption.resultId === candidate.id)
              ? itemStep.resultAdoptions
              : [
                  ...itemStep.resultAdoptions.map((adoption) => adoption.supersededAt ? adoption : { ...adoption, supersededAt: now }),
                  { id: `adoption-${randomUUID()}`, resultId: candidate.id, artifactPath: candidate.artifact!.path, artifactScope: candidate.artifact!.scope, adoptedAt: now },
                ],
            updatedAt: now,
          }),
          stages: item.stages.map((stage) => stage.stage === step.stage ? { ...stage, status: "adopted" as const, updatedAt: now } : stage),
          updatedAt: now,
        }),
        updatedAt: now,
      };
      await serializeWrite(canvasPath, async () => {
        const currentCanvas = await readJsonFile(this.workspaceRoot, canvasPath, toonCanvasSchema, "canvas");
        if (!currentCanvas.value.nodes.some((node) => node.id === job.nodeId)) {
          throw new ApiError(409, "toon_media_job_target_changed", "The Toon Factory node target is unavailable");
        }
        const nextCanvas: ToonCanvas = {
          ...currentCanvas.value,
          nodes: currentCanvas.value.nodes.map((node) => node.id !== job.nodeId ? node : {
            ...node,
            data: { ...node.data, generationRecordId: job.id },
          }),
        };
        await atomicWrite(this.workspaceRoot, canvasPath, jsonContent(nextCanvas), currentCanvas.snapshot, this.hooks.beforeAtomicPublish);
      });
      const content = jsonContent(nextProject);
      await atomicWrite(this.workspaceRoot, projectPath, content, current.snapshot, this.hooks.beforeAtomicPublish);
      return this.projectResponse(summary.directory, nextProject, revision(content));
    });
  }

  async getDeliveryManifest(projectId: string, episodeId: string): Promise<ToonDeliveryManifestResponse> {
    parseIdentifier(episodeId, "episode");
    const summary = await this.findProject(projectId);
    const project = await this.getProject(projectId);
    if (!project.project.episodes.some((episode) => episode.id === episodeId)) {
      throw new ApiError(404, "toon_episode_not_found", "Toon Factory episode not found");
    }
    const manifestPath = this.deliveryManifestPath(summary.directory, episodeId);
    const path = await optionalSafeFile(this.workspaceRoot, manifestPath);
    const content = await readRegularTextFile(this.workspaceRoot, path, MAX_DELIVERY_MANIFEST_BYTES);
    if (content === null) return { manifest: null, path: null, revision: null };
    const parsed = await readJsonFile(this.workspaceRoot, path, toonDeliveryManifestSchema, "delivery manifest");
    return { manifest: parsed.value, path: manifestPath, revision: parsed.revision };
  }

  async listDeliveryManifests(projectId: string): Promise<ToonDeliveryManifestListResponse> {
    const project = await this.getProject(projectId);
    const items: ToonDeliveryManifestListResponse["items"] = [];
    for (const episode of project.project.episodes) {
      const response = await this.getDeliveryManifest(projectId, episode.id);
      if (response.manifest && response.path && response.revision) {
        items.push({ manifest: response.manifest, path: response.path, revision: response.revision });
      }
    }
    return { items };
  }

  async createDeliveryManifest(projectId: string, episodeId: string, jobs: ToonMediaJob[], input: unknown): Promise<ToonDeliveryManifestResponse> {
    parseIdentifier(episodeId, "episode");
    const request = parseInput(toonDeliveryManifestCreateRequestSchema, input, "invalid_toon_delivery_manifest_request") as ToonDeliveryManifestCreateRequest;
    const summary = await this.findProject(projectId);
    const projectPath = await existingSafeFile(this.workspaceRoot, `${summary.directory}/${PROJECT_FILE}`);
    const manifestRelativePath = this.deliveryManifestPath(summary.directory, episodeId);
    await ensureSafeDirectory(this.workspaceRoot, dirname(manifestRelativePath));
    const manifestPath = await optionalSafeFile(this.workspaceRoot, manifestRelativePath);
    return serializeWrite(manifestPath, async () => {
      const project = await readJsonFile(this.workspaceRoot, projectPath, toonProjectSchema, "project");
      const episode = project.value.episodes.find((item) => item.id === episodeId);
      if (!episode) throw new ApiError(404, "toon_episode_not_found", "Toon Factory episode not found");
      const currentSnapshot = await readRegularTextSnapshot(this.workspaceRoot, manifestPath, MAX_DELIVERY_MANIFEST_BYTES);
      if (currentSnapshot !== null) {
        let currentValue: unknown;
        try { currentValue = JSON.parse(currentSnapshot.content); } catch { throw new ApiError(422, "invalid_toon_delivery_manifest", "Toon Factory delivery manifest contains invalid JSON"); }
        parseVersioned(toonDeliveryManifestSchema, currentValue, "delivery manifest");
      }
      assertExpectedRevision(request.expectedRevision, currentSnapshot?.revision ?? null);

      const activeAdoptions = (episode.steps ?? []).filter((step) => step.stage === "images" || step.stage === "videos").flatMap((step) => step.resultAdoptions
        .filter((adoption) => !adoption.supersededAt)
        .map((adoption) => ({ step, adoption })));
      const artifacts: ToonDeliveryManifest["artifacts"] = [];
      const omissions: ToonDeliveryManifest["omissions"] = [];
      for (const { step, adoption } of activeAdoptions) {
        const job = jobs.find((item) => item.projectId === projectId && item.episodeId === episodeId
          && item.candidates.some((candidate) => candidate.id === adoption.resultId));
        const candidate = job?.candidates.find((item) => item.id === adoption.resultId);
        const kind = job?.kind ?? (step.stage === "images" ? "image" : "video");
        if (!job || !candidate?.artifact || candidate.status !== "adopted" || candidate.review.decision !== "adopted") {
          omissions.push({ kind, code: "provenance_missing", reason: "The adopted result has no matching persisted generation artifact and provenance.", adoptionId: adoption.id, resultId: adoption.resultId, ...(adoption.artifactPath ? { path: adoption.artifactPath } : {}) });
          continue;
        }
        if (!adoption.artifactPath || adoption.artifactPath !== candidate.artifact.path || adoption.artifactScope !== candidate.artifact.scope) {
          omissions.push({ kind: job.kind, code: "artifact_path_mismatch", reason: "The adoption path does not match the persisted generation candidate.", adoptionId: adoption.id, resultId: adoption.resultId, ...(adoption.artifactPath ? { path: adoption.artifactPath } : {}) });
          continue;
        }
        const validated = await this.validateDeliveryArtifact(job.projectId, { path: adoption.artifactPath, scope: adoption.artifactScope }, job.kind, candidate.artifact.mimeType);
        if (!validated.ok) {
          omissions.push({ kind: job.kind, code: validated.code, reason: validated.reason, adoptionId: adoption.id, resultId: adoption.resultId, path: adoption.artifactPath });
          continue;
        }
        artifacts.push({
          id: adoption.id,
          kind: job.kind,
          path: adoption.artifactPath,
          scope: adoption.artifactScope,
          mimeType: validated.mimeType,
          bytes: validated.bytes,
          sha256: validated.sha256,
          adoptionId: adoption.id,
          generationRecordId: job.id,
          candidateId: candidate.id,
          provenance: candidate.provenance,
        });
      }
      for (const kind of ["image", "video"] as const) {
        if (activeAdoptions.some(({ adoption }) => jobs.some((job) => job.kind === kind && job.candidates.some((candidate) => candidate.id === adoption.resultId)))) continue;
        const skipped = (episode.steps ?? []).find((step) => step.stage === (kind === "image" ? "images" : "videos") && step.status === "skipped");
        omissions.push(skipped
          ? { kind, code: "explicitly_skipped", reason: skipped.skipReason ?? `The ${kind} output was explicitly skipped.` }
          : { kind, code: "no_adopted_output", reason: `No ${kind} output has been adopted for this episode.` });
      }

      const manifest = toonDeliveryManifestSchema.parse({
        schemaVersion: TOON_FACTORY_SCHEMA_VERSION,
        manifestVersion: 1,
        id: `manifest-${randomUUID()}`,
        projectId,
        episodeId,
        createdAt: new Date().toISOString(),
        artifacts,
        omissions,
        deliveryType: "adopted-media-and-manifest",
        composition: { status: "not-produced", excludedCapabilities: ["timeline", "composition", "subtitles", "audio-mixing"] },
      });
      const content = jsonContent(manifest);
      await atomicWrite(this.workspaceRoot, manifestPath, content, currentSnapshot, this.hooks.beforeAtomicPublish);
      return { manifest, path: manifestRelativePath, revision: revision(content) };
    });
  }

  async resolveDeliveryArtifact(projectId: string, episodeId: string, artifactId: string, jobs: ToonMediaJob[]): Promise<{ path: string; stream: NodeJS.ReadableStream; mimeType: string; bytes: number }> {
    parseIdentifier(artifactId, "artifact");
    const response = await this.getDeliveryManifest(projectId, episodeId);
    const artifact = response.manifest?.artifacts.find((item) => item.id === artifactId);
    if (!artifact) throw new ApiError(404, "toon_delivery_artifact_not_found", "Toon Factory delivery artifact not found");
    const project = await this.getProject(projectId);
    const episode = project.project.episodes.find((item) => item.id === episodeId);
    const adoption = episode?.steps?.flatMap((step) => step.resultAdoptions).find((item) => item.id === artifact.adoptionId && !item.supersededAt);
    const job = jobs.find((item) => item.id === artifact.generationRecordId && item.projectId === projectId && item.episodeId === episodeId && item.kind === artifact.kind);
    const candidate = job?.candidates.find((item) => item.id === artifact.candidateId && item.id === adoption?.resultId);
    if (!adoption || adoption.artifactPath !== artifact.path || adoption.artifactScope !== artifact.scope || candidate?.status !== "adopted" || candidate.review.decision !== "adopted" || candidate.artifact?.path !== artifact.path || candidate.artifact.scope !== artifact.scope || candidate.artifact.mimeType !== artifact.mimeType) {
      throw new ApiError(404, "toon_delivery_artifact_not_found", "Toon Factory delivery artifact is not a current adopted generation output");
    }
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const absolutePath = await this.resolveMediaReference(projectId, artifact);
    const handle = await open(absolutePath, constants.O_RDONLY | noFollow).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new ApiError(404, "toon_delivery_artifact_unavailable", "The adopted artifact is no longer a safe regular workspace file.");
      }
      throw error;
    });
    try {
      const metadata = await handle.stat();
      const signature = Buffer.alloc(16);
      const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      let position = 0;
      while (position < metadata.size) {
        const read = await handle.read(buffer, 0, Math.min(buffer.length, metadata.size - position), position);
        if (read.bytesRead === 0) break;
        digest.update(buffer.subarray(0, read.bytesRead));
        position += read.bytesRead;
      }
      if (!metadata.isFile() || metadata.size !== artifact.bytes || position !== artifact.bytes
        || digest.digest("hex") !== artifact.sha256
        || deliveryMime(signature.subarray(0, bytesRead), extname(artifact.path).toLowerCase()) !== artifact.mimeType) {
        throw new ApiError(404, "toon_delivery_artifact_unavailable", "The adopted artifact changed after manifest validation.");
      }
      return { path: artifact.path, stream: handle.createReadStream(), mimeType: artifact.mimeType, bytes: metadata.size };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private deliveryManifestPath(projectDirectory: string, episodeId: string): string {
    return `${projectDirectory}/exports/episodes/${episodeId}/delivery-manifest.json`;
  }

  private async validateDeliveryArtifact(projectId: string, reference: ToonFileReference, kind: "image" | "video", declaredMimeType: string): Promise<
    | { ok: true; absolutePath: string; mimeType: string; bytes: number; sha256: string }
    | { ok: false; code: "artifact_missing" | "artifact_unsafe" | "artifact_type_mismatch" | "artifact_invalid_signature"; reason: string }
  > {
    let path: string;
    try {
      path = await this.resolveMediaReference(projectId, reference);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return { ok: false, code: "artifact_missing", reason: "The adopted artifact file no longer exists." };
      }
      return { ok: false, code: "artifact_unsafe", reason: "The adopted artifact path is not a safe workspace-relative file path." };
    }
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, code: "artifact_missing", reason: "The adopted artifact file no longer exists." };
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) return { ok: false, code: "artifact_unsafe", reason: "The adopted artifact is not a safe regular workspace file." };
    const extension = extname(reference.path).toLowerCase();
    const allowedMime = kind === "image"
      ? new Map([["image/png", [".png"]], ["image/jpeg", [".jpg", ".jpeg"]], ["image/webp", [".webp"]]])
      : new Map([["video/mp4", [".mp4", ".m4v"]], ["video/quicktime", [".mov"]], ["video/webm", [".webm"]]]);
    if (!allowedMime.get(declaredMimeType)?.includes(extension)) {
      return { ok: false, code: "artifact_type_mismatch", reason: `The adopted ${kind} extension and declared MIME type do not match.` };
    }
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | noFollow);
      const opened = await handle.stat();
      const signature = Buffer.alloc(16);
      const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
      const bytes = signature.subarray(0, bytesRead);
      const actualMime = deliveryMime(bytes, extension);
      if (actualMime !== declaredMimeType) return { ok: false, code: "artifact_invalid_signature", reason: `The adopted ${kind} file signature does not match its declared MIME type.` };
      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      let position = 0;
      while (position < opened.size) {
        const read = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - position), position);
        if (read.bytesRead === 0) break;
        digest.update(buffer.subarray(0, read.bytesRead));
        position += read.bytesRead;
      }
      if (position !== opened.size) return { ok: false, code: "artifact_unsafe", reason: "The adopted artifact changed while it was being validated." };
      return { ok: true, absolutePath: path, mimeType: actualMime, bytes: opened.size, sha256: digest.digest("hex") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") return { ok: false, code: "artifact_unsafe", reason: "The adopted artifact resolves through an unsafe symbolic link." };
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private async findProject(projectId: string): Promise<ToonProjectSummary> {
    parseIdentifier(projectId, "project");
    const list = await this.listProjects();
    const matches = list.items.filter((item) => item.id === projectId);
    if (matches.length === 0) throw new ApiError(404, "toon_project_not_found", "Toon Factory project not found");
    if (matches.length > 1) throw new ApiError(409, "toon_project_id_conflict", "Multiple Toon Factory projects use the same ID");
    return matches[0]!;
  }

  private projectResponse(directory: string, project: ToonProject, projectRevision: string): ToonProjectResponse {
    return { project, directory, revision: projectRevision };
  }
}

function deliveryMime(bytes: Uint8Array, extension: string): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(4, 8)).toString("ascii") === "ftyp") return extension === ".mov" ? "video/quicktime" : "video/mp4";
  return null;
}

function actionStepId(action: ToonTextGenerationAction): string {
  if (action === "script") return "episode-script";
  return action;
}

function textWorkflowTarget(action: ToonTextGenerationAction): { stage: ToonTextJob["stage"]; stepId: string } {
  if (action === "script") return { stage: "content-script", stepId: "episode-script" };
  if (action === "asset-plan") return { stage: "assets", stepId: "asset-plan" };
  return { stage: "directing-storyboard", stepId: "storyboard" };
}

function workflowStepIsAvailable(steps: readonly ToonWorkflowStep[], step: ToonWorkflowStep): boolean {
  if (step.status === "stale") return false;
  return step.dependencies.every((dependencyId) => {
    const dependency = steps.find((candidate) => candidate.id === dependencyId);
    return dependency !== undefined && ["approved", "adopted", "skipped"].includes(dependency.status);
  });
}

function workflowPrerequisiteError(): ApiError {
  return new ApiError(409, "workflow_prerequisite_incomplete", "The Toon Factory workflow step is not available or its prerequisites are incomplete");
}

function workflowStatusForMediaJob(job: ToonMediaJob): ToonProject["episodes"][number]["stages"][number]["status"] {
  if (job.status === "queued") return "queued";
  if (["submitting", "running", "cancel_requested"].includes(job.status)) return "running";
  if (job.status === "awaiting-review") return "awaiting-review";
  if (job.status === "adopted") return "adopted";
  if (job.status === "cancelled") return "cancelled";
  return "failed";
}

function renderGeneratedText(action: ToonTextGenerationAction, output: unknown): string {
  if (action === "script") {
    const script = output as { title: string; logline: string; scenes: Array<{ heading: string; summary: string; dialogue: Array<{ speaker: string; line: string }> }> };
    return [`# ${script.title}`, "", script.logline, "", ...script.scenes.flatMap((scene) => [
      `## ${scene.heading}`,
      "",
      scene.summary,
      "",
      ...scene.dialogue.map((line) => `**${line.speaker}:** ${line.line}`),
      "",
    ])].join("\n");
  }
  if (action === "asset-plan") {
    const plan = output as { assets: Array<{ name: string; category: string; description: string }> };
    return ["# Asset plan", "", ...plan.assets.flatMap((asset) => [
      `## ${asset.name}`,
      "",
      `Category: ${asset.category}`,
      "",
      asset.description,
      "",
    ])].join("\n");
  }
  const storyboard = output as { shots: Array<{ id: string; sceneId: string; shot: string; description: string; dialogue?: string; imagePrompt: string }> };
  return ["# Storyboard", "", ...storyboard.shots.flatMap((shot) => [
    `## ${shot.id} - ${shot.shot}`,
    "",
    `Scene: ${shot.sceneId}`,
    "",
    shot.description,
    ...(shot.dialogue ? ["", `Dialogue: ${shot.dialogue}`] : []),
    "",
    `Image prompt: ${shot.imagePrompt}`,
    "",
  ])].join("\n");
}
