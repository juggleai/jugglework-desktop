import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import {
  TOON_WORKSPACE_SCHEMA_VERSION,
  TOON_CANONICAL_WORKFLOW_STAGES,
  TOON_CANONICAL_WORKFLOW_STEPS,
  toonAssetCatalogSchema,
  toonCanvasCatalogSchema,
  toonCanvasCheckpointCreateRequestSchema,
  toonCanvasCheckpointRestoreRequestSchema,
  toonCanvasCheckpointSchema,
  toonCanvasLeaseRequestSchema,
  toonDocumentCatalogSchema,
  toonDocumentRevisionListResponseSchema,
  toonDocumentRevisionRestoreRequestSchema,
  toonDocumentRevisionSchema,
  toonDocumentSearchRequestSchema,
  toonMigrationApplyRequestSchema,
  toonPortableProjectBundleSchema,
  toonProjectInitializeRequestSchema,
  toonWorkflowEnsureRequestSchema,
  toonWorkspaceCanvasSchema,
  toonWorkspaceCommandSchema,
  toonWorkspaceOperationOutcomeSchema,
  toonWorkspaceProjectSchema,
  toonWorkspaceQuerySchema,
  type ToonAssetCatalog,
  type ToonAssetDescriptor,
  type ToonAssetImportResult,
  type ToonAssetReferenceImpact,
  type ToonCanvasCatalog,
  type ToonCanvasCheckpoint,
  type ToonDocumentCatalog,
  type ToonDocumentRevision,
  type ToonDocumentRevisionListResponse,
  type ToonDocumentSearchResponse,
  type ToonMigrationBackupManifest,
  type ToonMigrationPreflight,
  type ToonPortableProjectBundle,
  type ToonPortableReference,
  type ToonProjectInitializeRequest,
  type ToonWorkflowEnsureRequest,
  type ToonWorkspaceCanvas,
  type ToonWorkspaceCommand,
  type ToonWorkspaceOperationOutcome,
  type ToonWorkspaceProject,
  type ToonWorkspaceQuery,
  type ToonWorkspaceQueryResponse,
  type ToonWorkflowDependencyLink,
  type ToonWorkspaceGenerationRecord,
} from "@jugglework/types/toon-workspace";
import { toonCanvasSchema, toonDeliveryManifestSchema, toonMediaJobSchema, toonProjectSchema, type ToonCanvas, type ToonMediaJob, type ToonProject } from "@jugglework/types/toon-factory";
import type { ZodType } from "zod";
import { ApiError } from "../errors.js";
import { resolveWithinRoot } from "../paths.js";
import { ToonWorkspaceRuntimeStore } from "./workspace-runtime-store.js";
import { assetChecksum, compatibleAssetNode, inspectAssetBytes, inspectAssetStream, isSafeAssetPreviewMime, normalizeAssetFilename, type InspectedAssetStream } from "./workspace-assets.js";

const PROJECT_FILE = "toon-project.json";
const CATALOG_PATHS = {
  canvases: "catalogs/canvases.json",
  documents: "catalogs/documents.json",
  assets: "catalogs/assets.json",
} as const;
const MAX_JSON_BYTES = 128 * 1024 * 1024;
const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const MAX_DISCOVERY_DIRECTORIES = 10_000;
const MAX_SEARCH_FILES = 100;
const MAX_SEARCH_BYTES = 2 * 1024 * 1024;
const BLOCKED_DOCUMENT_SEGMENTS = new Set(["generated", "node_modules", ".git", ".toon-history", ".toon-journal", ".toon-trash", ".toon-backups", "secrets"]);
const PROJECT_LOCKS = new Map<string, Promise<void>>();

type JournalEntry = {
  target: string;
  temporary: string;
  backup: string;
  desiredRevision: string | null;
  previousRevision: string | null;
  previousDev?: number;
  previousIno?: number;
  rootLast: boolean;
  parentDev?: number;
  parentIno?: number;
};

type JournalPayload = {
  projectRoot: string;
  entries: JournalEntry[];
  sourceSnapshots?: FileSnapshot[];
  outcome: ToonWorkspaceOperationOutcome;
  removeProjectRootOnRollback?: boolean;
};

type WorkspaceWriteContent = string | Uint8Array | null | {
  sourceRoot: string;
  sourcePath: string;
  revision: string;
  bytes: number;
  sourceDev?: number;
  sourceIno?: number;
  parentDev?: number;
  parentIno?: number;
};

type WorkspaceWrite = { path: string; content: WorkspaceWriteContent; rootLast?: boolean };
type FileSnapshot = { path: string; bytes: number; revision: string; dev: number; ino: number; content?: Buffer };
type CommandAuthority =
  | { kind: "ordinary" }
  | { kind: "human-interaction"; principalId: string }
  | { kind: "trusted-internal"; coordinator: "migration" | "recovery" };

const PROTECTED_WORKFLOW_COMMANDS = new Set<ToonWorkspaceCommand["kind"]>([
  "workflow.approve", "workflow.skip", "workflow.authorize", "workflow.adopt", "workflow.delivery",
]);
const INTERNAL_WORKSPACE_COMMANDS = new Set<ToonWorkspaceCommand["kind"]>([
  "asset.cleanup", "generation.project", "workflow.configure", "workflow.invalidate",
]);

export const TOON_WORKSPACE_CLEANUP_GRACE = Object.freeze({
  completedJournalsMs: 7 * 24 * 60 * 60 * 1_000,
  unavailableMappingsMs: 30 * 24 * 60 * 60 * 1_000,
  assistantEventsMs: 30 * 24 * 60 * 60 * 1_000,
  assetTrashMs: 30 * 24 * 60 * 60 * 1_000,
  retainedAssistantEvents: 500,
});

export type ToonWorkspaceCoordinatorHooks = {
  crashAt?: "after-prepare" | "during-publish" | "after-publish" | "after-commit";
  crashAfterEntry?: number;
  beforeMigrationCapture?: () => void | Promise<void>;
  beforePublish?: () => void | Promise<void>;
  afterDestinationCheck?: (path: string) => void | Promise<void>;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function entityRevision(value: unknown): string {
  return sha256(canonical(value));
}

function dependencyKey(reference: Pick<ToonPortableReference, "kind" | "id">): string {
  return `${reference.kind}:${reference.id}`;
}

function migratedGenerationStatus(status: ToonMediaJob["status"]): ToonWorkspaceGenerationRecord["status"] {
  switch (status) {
    case "queued": case "submitting": case "running": case "awaiting-review": case "adopted": case "failed": case "cancelled": case "submission_unknown":
      return status;
    case "cancel_requested":
      return "running";
    default:
      return "failed";
  }
}

function parse<T>(schema: ZodType<T>, value: unknown, code: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, code, "Invalid Toon workspace request", { issues: parsed.error.issues });
  return parsed.data;
}

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function commandAffected(command: ToonWorkspaceCommand): ToonPortableReference[] {
  if (command.kind === "canvas.duplicate") return [{ kind: "canvas", id: command.newCanvasId }];
  if (command.kind === "canvas.create") return [{ kind: "canvas", id: command.canvas.id }];
  if (command.kind === "folder.create") return [{ kind: "canvas-folder", id: command.folder.id }];
  if (command.kind === "document.create") return [{ kind: "document", id: command.document.id }];
  if (command.kind === "document.copy") return [{ kind: "document", id: command.newDocumentId }];
  if (command.kind.startsWith("document.folder.")) return [];
  if (command.kind === "asset.register") return [{ kind: "asset", id: command.asset.id }];
  if (command.kind === "asset.import") return [{ kind: "asset", id: command.assetId }];
  if (command.kind === "generation.prepare") return [{ kind: "generation", id: command.generation.id }];
  if (command.kind === "generation.project") return [{ kind: "generation", id: command.generationId }];
  if (command.kind === "workflow.authorize" || command.kind === "workflow.adopt") return [{ kind: "generation", id: command.generationId }, { kind: "workflow", id: `${command.episodeId}.${command.workflowRecordId}` }];
  if (command.kind.startsWith("workflow.") && "workflowRecordId" in command && "episodeId" in command) return [{ kind: "workflow", id: `${command.episodeId}.${command.workflowRecordId}` }];
  if ("canvasId" in command) return [{ kind: "canvas", id: command.canvasId }];
  if ("folderId" in command && command.folderId) return [{ kind: "canvas-folder", id: command.folderId }];
  if ("documentId" in command) return [{ kind: "document", id: command.documentId }];
  if ("assetId" in command) return [{ kind: "asset", id: command.assetId }];
  return [];
}

function assertDocumentPath(path: string): void {
  const parts = path.toLocaleLowerCase().split("/");
  if (!path.startsWith("documents/") || parts.some((part) => BLOCKED_DOCUMENT_SEGMENTS.has(part)) || /(?:^|\/)(?:\.env|id_rsa|id_ed25519|credentials?)(?:\.|$)/i.test(path)) {
    throw new ApiError(400, "toon_document_path_unsafe", "Document paths must remain in a safe project document directory");
  }
}

async function serializeProject<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = PROJECT_LOCKS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => { release = resolveLock; });
  const queued = previous.then(() => current);
  PROJECT_LOCKS.set(key, queued);
  await previous;
  try { return await operation(); } finally {
    release();
    if (PROJECT_LOCKS.get(key) === queued) PROJECT_LOCKS.delete(key);
  }
}

async function readSafeFile(root: string, relativePath: string, maxBytes = MAX_JSON_BYTES): Promise<Buffer | null> {
  const path = await resolveWithinRoot(root, relativePath);
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!metadata) return null;
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new ApiError(400, "path_escape", "Toon workspace path is unsafe");
  if (metadata.size > maxBytes) throw new ApiError(413, "toon_workspace_content_too_large", "Toon workspace content is too large");
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    const [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(path)]);
    if (!opened.isFile() || (canonicalPath !== canonicalRoot && !canonicalPath.startsWith(canonicalRoot + sep))) {
      throw new ApiError(400, "path_escape", "Toon workspace path is unsafe");
    }
    return Buffer.from(await handle.readFile());
  } finally {
    await handle.close();
  }
}

async function readJson<T>(root: string, relativePath: string, schema: ZodType<T>): Promise<{ value: T; revision: string }> {
  const bytes = await readSafeFile(root, relativePath);
  if (!bytes) throw new ApiError(404, "toon_workspace_content_not_found", "Toon workspace content not found");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new ApiError(422, "invalid_toon_workspace_json", "Toon workspace JSON is invalid"); }
  const version = value && typeof value === "object" && "schemaVersion" in value ? (value as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (typeof version === "number" && version > TOON_WORKSPACE_SCHEMA_VERSION) {
    throw new ApiError(422, "toon_factory_unsupported_version", "Unsupported Toon workspace schema version", { supportedVersion: TOON_WORKSPACE_SCHEMA_VERSION, actualVersion: version });
  }
  if (relativePath === PROJECT_FILE) value = normalizeLegacyWorkflowScopes(value);
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(422, "invalid_toon_workspace", "Toon workspace content is invalid", { issues: parsed.error.issues });
  return { value: parsed.data, revision: sha256(bytes) };
}

function normalizeLegacyWorkflowScopes(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const project = value as Record<string, unknown>;
  if (project.schemaVersion !== 2 || !project.workflow || typeof project.workflow !== "object" || Array.isArray(project.workflow)) return value;
  const workflow = project.workflow as Record<string, unknown>;
  if (!Array.isArray(workflow.adoptions) || !Array.isArray(workflow.generations)) return value;
  const generations = workflow.generations.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  let changed = false;
  const adoptions = workflow.adoptions.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof (item as Record<string, unknown>).episodeId === "string") return item;
    const adoption = item as Record<string, unknown>;
    const owners = generations.filter((generation) => generation.id === adoption.generationId && typeof generation.episodeId === "string");
    if (owners.length !== 1) return item;
    changed = true;
    return { ...adoption, episodeId: owners[0]!.episodeId };
  });
  return changed ? { ...project, workflow: { ...workflow, adoptions } } : value;
}

async function ensureSafeDirectory(root: string, relativePath: string): Promise<string> {
  const target = await resolveWithinRoot(root, relativePath);
  const canonicalRoot = await realpath(root);
  const parts = relative(canonicalRoot, target).split(sep).filter(Boolean);
  let current = canonicalRoot;
  for (const part of parts) {
    current = join(current, part);
    const metadata = await lstat(current).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (metadata && (metadata.isSymbolicLink() || !metadata.isDirectory())) throw new ApiError(400, "path_escape", "Project path traverses an unsafe entry");
    if (!metadata) await mkdir(current);
  }
  return target;
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function safeParentSnapshot(root: string, target: string): Promise<{ dev: number; ino: number }> {
  const parentPath = dirname(target);
  const [canonicalRoot, canonicalParent, metadata] = await Promise.all([realpath(root), realpath(parentPath), lstat(parentPath)]);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (canonicalParent !== canonicalRoot && !canonicalParent.startsWith(canonicalRoot + sep)) || canonicalParent !== resolve(parentPath)) {
    throw new ApiError(400, "path_escape", "Toon workspace publication parent is unsafe");
  }
  return { dev: Number(metadata.dev), ino: Number(metadata.ino) };
}

async function assertSafeParentSnapshot(root: string, target: string, expected: { parentDev?: number; parentIno?: number }): Promise<void> {
  const current = await safeParentSnapshot(root, target);
  if (expected.parentDev === undefined || expected.parentIno === undefined) {
    expected.parentDev = current.dev;
    expected.parentIno = current.ino;
  }
  if (current.dev !== expected.parentDev || current.ino !== expected.parentIno) {
    throw new ApiError(409, "toon_workspace_parent_changed", "A project directory changed during atomic publication");
  }
}

function projectIdForInitialization(operationId: string): string {
  return `toon-${operationId}`.slice(0, 128);
}

function canonicalWorkflowStep(now: string, definition: typeof TOON_CANONICAL_WORKFLOW_STEPS[number]) {
  return {
    id: definition.id,
    stage: definition.stage,
    title: definition.title,
    status: definition.dependencies.length === 0 ? "pending-confirmation" as const : "draft" as const,
    dependencies: [...definition.dependencies],
    dependencyLinks: [],
    contentApprovals: [],
    computeAuthorizations: [],
    resultAdoptions: [],
    history: [],
    updatedAt: now,
  };
}

function workflowStatus(steps: ToonWorkspaceProject["workflow"]["episodes"][number]["steps"], stage: typeof TOON_CANONICAL_WORKFLOW_STAGES[number]) {
  const stageSteps = (steps ?? []).filter((step) => step.stage === stage);
  if (stageSteps.some((step) => step.status === "stale")) return "stale" as const;
  if (stageSteps.length && stageSteps.every((step) => step.status === "skipped")) return "skipped" as const;
  if (stageSteps.length && stageSteps.every((step) => ["approved", "adopted", "skipped"].includes(step.status))) return "approved" as const;
  if (stageSteps.some((step) => step.status === "pending-confirmation")) return "pending-confirmation" as const;
  return "draft" as const;
}

function promoteAvailableWorkflowSteps(steps: NonNullable<ToonWorkspaceProject["workflow"]["episodes"][number]["steps"]>, now: string) {
  return steps.map((step) => step.status === "draft" && step.dependencies.every((dependencyId) => {
    const dependency = steps.find((candidate) => candidate.id === dependencyId);
    return dependency && ["approved", "adopted", "skipped"].includes(dependency.status);
  }) ? { ...step, status: "pending-confirmation" as const, updatedAt: now } : step);
}

function ensureCanonicalWorkflow(project: ToonWorkspaceProject, canvasId: string, now: string, episodeId = "episode-main"): { project: ToonWorkspaceProject; changed: boolean } {
  const existingEpisode = project.workflow.episodes.find((episode) => episode.canvasId === canvasId) ?? project.workflow.episodes[0];
  const episode = existingEpisode ?? {
    id: episodeId,
    title: "Episode 1",
    ordinal: 0,
    canvasId,
    stages: [],
    steps: [],
    createdAt: now,
    updatedAt: now,
  };
  const existingStepIds = new Set((episode.steps ?? []).map((step) => step.id));
  const missingSteps = TOON_CANONICAL_WORKFLOW_STEPS.filter((step) => !existingStepIds.has(step.id)).map((step) => canonicalWorkflowStep(now, step));
  const steps = [...(episode.steps ?? []), ...missingSteps];
  const existingStages = new Map(episode.stages.map((stage) => [stage.stage, stage]));
  const missingStages = TOON_CANONICAL_WORKFLOW_STAGES.filter((stage) => !existingStages.has(stage)).map((stage) => ({ stage, status: workflowStatus(steps, stage), updatedAt: now }));
  if (!missingSteps.length && !missingStages.length) return { project, changed: false };
  const merged = { ...episode, stages: [...episode.stages, ...missingStages], steps, updatedAt: now };
  return {
    changed: true,
    project: {
      ...project,
      workflow: {
        ...project.workflow,
        episodes: existingEpisode
          ? project.workflow.episodes.map((item) => item.id === existingEpisode.id ? merged : item)
          : [merged],
      },
      metadata: { ...project.metadata, updatedAt: now },
    },
  };
}

function rejectedOutcome(command: Pick<ToonWorkspaceCommand, "operationId" | "origin" | "actor">, payloadHash: string, affected: ToonPortableReference[], error: unknown): ToonWorkspaceOperationOutcome {
  const sanitized = error instanceof ApiError
    ? { code: error.code, message: error.message.slice(0, 2_000) }
    : { code: "toon_workspace_operation_failed", message: "The Toon workspace operation failed" };
  return toonWorkspaceOperationOutcomeSchema.parse({
    operationId: command.operationId,
    payloadHash,
    status: "rejected",
    origin: command.origin,
    actor: command.actor,
    affected,
    revisions: {},
    error: sanitized,
    committedAt: new Date().toISOString(),
  });
}

function returnOrThrowPrior(outcome: ToonWorkspaceOperationOutcome | null): ToonWorkspaceOperationOutcome | null {
  if (outcome?.status === "rejected") {
    throw new ApiError(409, outcome.error?.code ?? "toon_workspace_operation_rejected", outcome.error?.message ?? "The Toon workspace operation was rejected");
  }
  return outcome;
}

export class ToonWorkspaceCoordinator {
  constructor(
    readonly workspaceScope: string,
    readonly workspaceRoot: string,
    private readonly runtime: ToonWorkspaceRuntimeStore,
    private readonly hooks: ToonWorkspaceCoordinatorHooks = {},
  ) {}

  async initialize(input: unknown): Promise<ToonWorkspaceOperationOutcome> {
    const request = parse(toonProjectInitializeRequestSchema, input, "invalid_toon_project_initialize") as ToonProjectInitializeRequest;
    const projectId = projectIdForInitialization(request.operationId);
    const payloadHash = sha256(canonical(request));
    const prior = returnOrThrowPrior(this.runtime.getOutcome(this.workspaceScope, projectId, request.operationId, payloadHash));
    if (prior) return prior;
    const projectRoot = await resolveWithinRoot(this.workspaceRoot, request.directory);
    return this.serializeMutation(projectId, request.operationId, async () => {
      const existing = await lstat(projectRoot).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
      if (existing) throw new ApiError(409, "toon_project_directory_exists", "Project directory already exists");
      const parent = dirname(request.directory);
      if (parent !== ".") await ensureSafeDirectory(this.workspaceRoot, parent);
      await mkdir(projectRoot);
      for (const child of ["catalogs", "canvases", "documents", "assets", "content", "generations/manifests", "exports", ".toon-journal", ".toon-trash"]) {
        await ensureSafeDirectory(projectRoot, child);
      }
      const now = new Date().toISOString();
      const canvas: ToonWorkspaceCanvas = { schemaVersion: 2, id: "main", nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
      const canvasContent = json(canvas);
      const emptyProject: ToonWorkspaceProject = {
        schemaVersion: 2,
        metadata: { id: projectId, name: request.name, createdAt: now, updatedAt: now },
        catalogs: { canvases: CATALOG_PATHS.canvases, documents: CATALOG_PATHS.documents, assets: CATALOG_PATHS.assets },
        activeCanvasId: "main",
        workflow: { episodes: [], generations: [], adoptions: [] },
      };
      const project = ensureCanonicalWorkflow(emptyProject, "main", now, request.episodeId).project;
      const canvases: ToonCanvasCatalog = {
        schemaVersion: 2, projectId, folders: [],
        canvases: [{ id: "main", title: "Episode 1", kind: "episode", order: 0, file: "canvases/main.json", revision: sha256(canvasContent), state: "active" }],
      };
      const documents: ToonDocumentCatalog = { schemaVersion: 2, projectId, folders: [], documents: [] };
      const assets: ToonAssetCatalog = { schemaVersion: 2, projectId, assets: [] };
      this.runtime.reconcileProject(this.workspaceScope, projectId, projectRoot, 2);
      return this.publish(projectId, request.operationId, payloadHash, request.origin, request.actor, [{ path: "canvases/main.json", content: canvasContent }, { path: CATALOG_PATHS.canvases, content: json(canvases) }, { path: CATALOG_PATHS.documents, content: json(documents) }, { path: CATALOG_PATHS.assets, content: json(assets) }, { path: PROJECT_FILE, content: json(project), rootLast: true }], [{ kind: "project", id: projectId }], { project, directory: request.directory }, projectRoot, true);
    });
  }

  async ensureWorkflow(projectId: string, input: unknown): Promise<ToonWorkspaceOperationOutcome> {
    const request = parse(toonWorkflowEnsureRequestSchema, input, "invalid_toon_workflow_ensure") as ToonWorkflowEnsureRequest;
    const payloadHash = sha256(canonical(request));
    const prior = returnOrThrowPrior(this.runtime.getOutcome(this.workspaceScope, projectId, request.operationId, payloadHash));
    if (prior) return prior;
    return this.serializeMutation(projectId, request.operationId, async () => {
      const loaded = await this.load(projectId);
      this.assertExpected({ [PROJECT_FILE]: request.expectedRevision }, loaded.revisions);
      const canvasId = loaded.bundle.project.activeCanvasId ?? loaded.bundle.canvases.canvases.find((canvas) => canvas.state === "active")?.id;
      if (!canvasId) throw new ApiError(409, "toon_workflow_canvas_required", "A workflow requires an active project canvas");
      const ensured = ensureCanonicalWorkflow(loaded.bundle.project, canvasId, new Date().toISOString());
      const writes = ensured.changed ? [{ path: PROJECT_FILE, content: json(ensured.project), rootLast: true }] : [];
      return this.publish(projectId, request.operationId, payloadHash, request.origin, request.actor, writes, [{ kind: "project", id: projectId }], { changed: ensured.changed, episodeId: ensured.project.workflow.episodes.find((episode) => episode.canvasId === canvasId)?.id }, undefined, false, loaded.revisions);
    });
  }

  async execute(projectId: string, input: unknown, options: { requireCompleteExpected?: boolean; requireCanvasLease?: boolean } = {}): Promise<ToonWorkspaceOperationOutcome> {
    return this.executeAuthorized(projectId, input, { kind: "ordinary" }, options);
  }

  async executeHumanInteraction(projectId: string, input: unknown, principalId: string): Promise<ToonWorkspaceOperationOutcome> {
    if (!principalId) throw new ApiError(401, "unauthorized", "Authenticated principal identity is unavailable");
    return this.executeAuthorized(projectId, input, { kind: "human-interaction", principalId });
  }

  async executeMigrationCommand(projectId: string, input: unknown): Promise<ToonWorkspaceOperationOutcome> {
    return this.executeAuthorized(projectId, { ...(input as object), actor: { kind: "system" }, origin: "migration" }, { kind: "trusted-internal", coordinator: "migration" });
  }

  async executeRecoveryCommand(projectId: string, input: unknown): Promise<ToonWorkspaceOperationOutcome> {
    return this.executeAuthorized(projectId, { ...(input as object), actor: { kind: "system" }, origin: "recovery" }, { kind: "trusted-internal", coordinator: "recovery" });
  }

  private async executeAuthorized(projectId: string, input: unknown, authority: CommandAuthority, options: { requireCompleteExpected?: boolean; requireCanvasLease?: boolean } = {}): Promise<ToonWorkspaceOperationOutcome> {
    const command = parse(toonWorkspaceCommandSchema, input, "invalid_toon_workspace_command") as ToonWorkspaceCommand;
    this.assertCommandAuthority(command, authority);
    const payloadHash = sha256(canonical(command));
    const prior = returnOrThrowPrior(this.runtime.getOutcome(this.workspaceScope, projectId, command.operationId, payloadHash));
    if (prior) return prior;
    if (command.kind === "canvas.write" && options.requireCanvasLease) {
      this.runtime.assertCanvasLease(this.workspaceScope, projectId, command.canvasId, command.leaseToken, command.leaseGeneration);
    }
    return this.serializeMutation(projectId, command.operationId, async () => {
      try {
        const loaded = await this.load(projectId);
        const writes = await this.applyCommand(loaded, command);
        this.assertExpected(command.expectedRevisions, loaded.revisions);
        if (options.requireCompleteExpected) this.assertCompleteExpected(writes, command.expectedRevisions, loaded.revisions);
        const candidate = this.applyWritesToBundle(loaded.bundle, writes);
        const validated = toonPortableProjectBundleSchema.safeParse(candidate);
        if (!validated.success) throw new ApiError(409, "toon_reference_integrity", "The command would create invalid or dangling project references", { issues: validated.error.issues });
        const result = command.kind === "asset.import"
          ? (() => {
              const checksum = assetChecksum(Buffer.from(command.contentBase64, "base64"));
              const asset = candidate.assets.assets.find((item) => item.checksum === checksum && item.state === "active");
              if (!asset) throw new ApiError(500, "toon_asset_import_failed", "Imported asset was not cataloged");
              return { asset, reused: asset.id !== command.assetId, ...(command.canvas ? { nodeId: `${command.assetId}-node`.slice(0, 128) } : {}) } satisfies ToonAssetImportResult;
            })()
          : { kind: command.kind };
        const affected = command.kind === "asset.import" && "asset" in result
          ? [{ kind: "asset" as const, id: result.asset.id }, ...(result.nodeId ? [{ kind: "node" as const, id: result.nodeId }] : [])]
          : commandAffected(command);
        const invalidatedAuthorizationIds = loaded.bundle.project.workflow.generations.flatMap((generation) => {
          const next = candidate.project.workflow.generations.find((item) => item.id === generation.id);
          return generation.authorization && !generation.authorization.invalidatedAt && next?.authorization?.invalidatedAt ? [generation.authorization.id] : [];
        });
        const outcome = await this.publish(projectId, command.operationId, payloadHash, command.origin, command.actor, writes, affected, result, undefined, false, loaded.revisions);
        if (invalidatedAuthorizationIds.length) this.runtime.invalidateGenerationAuthorizations(this.workspaceScope, projectId, invalidatedAuthorizationIds);
        return outcome;
      } catch (error) {
        if (!this.runtime.hasRecoverable(this.workspaceScope, projectId, command.operationId)) {
          this.runtime.saveOutcome(this.workspaceScope, projectId, rejectedOutcome(command, payloadHash, commandAffected(command), error));
        }
        throw error;
      }
    });
  }

  async listProjects(): Promise<Array<{ projectId: string; name: string; directory: string; revision: string; updatedAt: string }>> {
    const items: Array<{ projectId: string; name: string; directory: string; revision: string; updatedAt: string }> = [];
    const workspaceRoot = await realpath(this.workspaceRoot);
    let visited = 0;
    const visit = async (directory: string): Promise<void> => {
      if (++visited > MAX_DISCOVERY_DIRECTORIES) throw new ApiError(422, "toon_factory_discovery_limit", "Too many workspace directories to discover Toon projects");
      const entries = await readdir(directory, { withFileTypes: true });
      if (entries.some((entry) => entry.name === PROJECT_FILE && entry.isFile() && !entry.isSymbolicLink())) {
        const bytes = await readSafeFile(directory, PROJECT_FILE);
        let root: unknown;
        try { root = bytes ? JSON.parse(bytes.toString("utf8")) : null; } catch { throw new ApiError(422, "invalid_toon_project", "Toon project contains invalid JSON"); }
        const version = root && typeof root === "object" ? (root as { schemaVersion?: unknown }).schemaVersion : undefined;
        if (typeof version === "number" && version > TOON_WORKSPACE_SCHEMA_VERSION) throw new ApiError(422, "toon_factory_unsupported_version", "Unsupported Toon project schema version", { supportedVersion: TOON_WORKSPACE_SCHEMA_VERSION, actualVersion: version });
        if (version === 2) {
          const parsed = toonWorkspaceProjectSchema.safeParse(root);
          if (!parsed.success) throw new ApiError(422, "invalid_toon_workspace", "Toon workspace root is invalid", { issues: parsed.error.issues });
          this.runtime.reconcileProject(this.workspaceScope, parsed.data.metadata.id, directory, 2);
          items.push({ projectId: parsed.data.metadata.id, name: parsed.data.metadata.name, directory: portablePath(relative(workspaceRoot, directory)), revision: sha256(bytes!), updatedAt: parsed.data.metadata.updatedAt });
        }
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || [".git", "node_modules", ".toon-backups", ".toon-journal", ".toon-trash"].includes(entry.name)) continue;
        await visit(join(directory, entry.name));
      }
    };
    await visit(workspaceRoot);
    return items.sort((left, right) => left.directory.localeCompare(right.directory));
  }

  async openProjectDirectory(directory: string): Promise<{ project: { projectId: string; name: string; directory: string; revision: string; updatedAt: string }; imported: false }> {
    const root = await resolveWithinRoot(this.workspaceRoot, directory);
    const rootResult = await readJson(root, PROJECT_FILE, toonWorkspaceProjectSchema);
    const loaded = await this.load(rootResult.value.metadata.id);
    if (await realpath(loaded.root) !== await realpath(root)) throw new ApiError(409, "toon_project_id_conflict", "The selected project ID resolves to another project directory");
    const workspaceRoot = await realpath(this.workspaceRoot);
    return {
      project: {
        projectId: loaded.bundle.project.metadata.id,
        name: loaded.bundle.project.metadata.name,
        directory: portablePath(relative(workspaceRoot, loaded.root)),
        revision: loaded.revisions[PROJECT_FILE]!,
        updatedAt: loaded.bundle.project.metadata.updatedAt,
      },
      imported: false,
    };
  }

  async cleanupLifecycle(now = Date.now()): Promise<{ runtime: ReturnType<ToonWorkspaceRuntimeStore["cleanup"]>; trashedAssets: number }> {
    const runtime = this.runtime.cleanup({
      now,
      completedJournalGraceMs: TOON_WORKSPACE_CLEANUP_GRACE.completedJournalsMs,
      unavailableMappingGraceMs: TOON_WORKSPACE_CLEANUP_GRACE.unavailableMappingsMs,
      assistantEventGraceMs: TOON_WORKSPACE_CLEANUP_GRACE.assistantEventsMs,
      retainedAssistantEvents: TOON_WORKSPACE_CLEANUP_GRACE.retainedAssistantEvents,
    });
    let trashedAssets = 0;
    for (const project of await this.listProjects()) {
      const catalogs = await this.query(project.projectId, { kind: "catalogs.read" });
      if (catalogs.kind !== "catalogs.read" || !catalogs.assets.assets.some((asset) => asset.state === "trashed" && asset.trashedAt && Date.parse(asset.trashedAt) < now - TOON_WORKSPACE_CLEANUP_GRACE.assetTrashMs)) continue;
      const operationId = `cleanup-${now}`;
      const outcome = await this.executeRecoveryCommand(project.projectId, {
        operationId, expectedRevisions: {}, kind: "asset.cleanup",
        before: new Date(now - TOON_WORKSPACE_CLEANUP_GRACE.assetTrashMs).toISOString(), limit: 100,
      });
      if (outcome.status === "committed" || outcome.status === "recovered") trashedAssets += 1;
    }
    return { runtime, trashedAssets };
  }

  async query(projectId: string, input: unknown): Promise<ToonWorkspaceQueryResponse> {
    const query = parse(toonWorkspaceQuerySchema, input, "invalid_toon_workspace_query") as ToonWorkspaceQuery;
    const loaded = await this.load(projectId);
    if (query.kind === "project.read") return { kind: query.kind, project: loaded.bundle.project, revision: loaded.revisions[PROJECT_FILE]!, revisions: loaded.revisions, directory: portablePath(relative(this.workspaceRoot, loaded.root)) };
    if (query.kind === "catalogs.read") return { kind: query.kind, canvases: loaded.bundle.canvases, documents: loaded.bundle.documents, assets: loaded.bundle.assets, revisions: loaded.revisions };
    if (query.kind === "canvas.read") {
      const descriptor = loaded.bundle.canvases.canvases.find((item) => item.id === query.canvasId);
      if (!descriptor) throw new ApiError(404, "toon_canvas_not_found", "Toon canvas not found");
      return { kind: query.kind, canvas: loaded.bundle.canvasFiles[descriptor.file]!, descriptor, revision: loaded.revisions[descriptor.file]!, revisions: loaded.revisions };
    }
    if (query.kind === "document.read") {
      const descriptor = loaded.bundle.documents.documents.find((item) => item.id === query.documentId);
      if (!descriptor) throw new ApiError(404, "toon_document_not_found", "Toon document not found");
      const bytes = await readSafeFile(loaded.root, descriptor.path, MAX_TEXT_BYTES);
      if (!bytes) throw new ApiError(404, "toon_document_not_found", "Toon document not found");
      return { kind: query.kind, document: descriptor, content: bytes.toString("utf8"), revision: sha256(bytes), revisions: loaded.revisions };
    }
    if (query.kind === "asset.read") {
      const asset = loaded.bundle.assets.assets.find((item) => item.id === query.assetId);
      if (!asset) throw new ApiError(404, "toon_asset_not_found", "Toon asset not found");
      return { kind: query.kind, asset, revisions: loaded.revisions };
    }
    if (query.kind === "asset.search") {
      const normalized = query.query.toLocaleLowerCase();
      const items = loaded.bundle.assets.assets.filter((asset) => {
        if (query.state !== "all" && asset.state !== query.state) return false;
        if (query.mimeGroup !== "all" && !(query.mimeGroup === "other" ? !/^(?:image|video|audio|text)\//.test(asset.mimeType) : asset.mimeType.startsWith(`${query.mimeGroup}/`))) return false;
        return !normalized || `${asset.title}\n${asset.path}\n${asset.mimeType}\n${asset.origin}`.toLocaleLowerCase().includes(normalized);
      }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return { kind: query.kind, items, total: items.length, revisions: loaded.revisions };
    }
    if (query.kind === "asset.references") {
      const asset = loaded.bundle.assets.assets.find((item) => item.id === query.assetId);
      if (!asset) throw new ApiError(404, "toon_asset_not_found", "Toon asset not found");
      return { kind: query.kind, asset, impacts: await this.assetReferenceImpacts(loaded, asset.id), revisions: loaded.revisions };
    }
    if (query.kind === "content.read") {
      const bytes = await readSafeFile(loaded.root, query.path, MAX_TEXT_BYTES);
      if (!bytes) throw new ApiError(404, "toon_workspace_content_not_found", "Toon workspace content not found");
      return { kind: query.kind, path: query.path, content: bytes.toString("utf8"), revision: sha256(bytes), revisions: loaded.revisions };
    }
    if (query.kind === "generation.read") {
      const generation = loaded.bundle.project.workflow.generations.find((item) => item.id === query.generationId);
      if (!generation) throw new ApiError(404, "toon_generation_not_found", "Toon generation record not found");
      return { kind: query.kind, generation, projectRevision: loaded.revisions[PROJECT_FILE]!, revisions: loaded.revisions };
    }
    return { kind: query.kind, target: query.target, references: this.findReferences(loaded.bundle, query.target), revisions: loaded.revisions };
  }

  async exportProject(projectId: string): Promise<ToonPortableProjectBundle> {
    return (await this.load(projectId)).bundle;
  }

  async observeDependencies(projectId: string, references: ToonPortableReference[]): Promise<ToonWorkflowDependencyLink[]> {
    const loaded = await this.load(projectId);
    return references.map((target) => {
      const revision = this.dependencyRevision(loaded.bundle, target);
      if (!revision) throw new ApiError(409, "toon_reference_integrity", "A workflow dependency target is missing", { target });
      return { target: { kind: target.kind, id: target.id }, revision };
    });
  }

  async observeGenerationDependencies(projectId: string, episodeId: string, workflowRecordId: string, references: ToonPortableReference[]): Promise<ToonWorkflowDependencyLink[]> {
    const loaded = await this.load(projectId);
    const found = this.requireWorkflowStep(loaded.bundle.project, episodeId, workflowRecordId);
    this.assertWorkflowStepCurrent(loaded.bundle, found.episode, found.step);
    return this.generationDependencyReferences(loaded.bundle, found.episode, found.step, references).map((target) => ({
      target: { kind: target.kind, id: target.id },
      revision: this.dependencyRevision(loaded.bundle, target)!,
    }));
  }

  async assertGenerationPrerequisites(projectId: string, generationId: string): Promise<ToonWorkspaceGenerationRecord> {
    const loaded = await this.load(projectId);
    const generation = loaded.bundle.project.workflow.generations.find((item) => item.id === generationId);
    if (!generation) throw new ApiError(404, "toon_generation_not_found", "Toon generation record not found");
    try {
      const found = this.requireWorkflowStep(loaded.bundle.project, generation.episodeId, generation.workflowRecordId);
      this.assertWorkflowStepCurrent(loaded.bundle, found.episode, found.step);
      this.assertDependencyLinks(loaded.bundle, generation.dependencyLinks);
      this.assertCompleteDependencyClosure(generation.dependencyLinks, this.generationDependencyReferences(loaded.bundle, found.episode, found.step, [
        { kind: "canvas", id: generation.canvasId }, { kind: "node", id: generation.nodeId }, ...generation.plan.references,
      ]));
    } catch (error) {
      if (generation.authorization) this.runtime.invalidateAuthorization(generation.authorization.id);
      throw error;
    }
    return generation;
  }

  async resolveProjectFile(projectId: string, relativePath: string): Promise<string> {
    const loaded = await this.load(projectId);
    const path = await resolveWithinRoot(loaded.root, relativePath);
    const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new ApiError(404, "toon_workspace_content_not_found", "Toon workspace content not found");
    return path;
  }

  async readAssetContent(projectId: string, assetId: string): Promise<{ bytes: Uint8Array; asset: ToonAssetDescriptor }> {
    const loaded = await this.load(projectId);
    const asset = loaded.bundle.assets.assets.find((item) => item.id === assetId && item.state !== "tombstone");
    if (!asset) throw new ApiError(404, "toon_asset_not_found", "Toon asset not found");
    const relativePath = asset.state === "trashed" ? asset.trashPath : asset.path;
    if (!relativePath) throw new ApiError(404, "toon_asset_content_not_found", "Asset content is unavailable");
    const bytes = await readSafeFile(loaded.root, relativePath, Number.MAX_SAFE_INTEGER);
    if (!bytes || bytes.byteLength !== asset.bytes || sha256(bytes) !== asset.checksum) throw new ApiError(409, "toon_asset_integrity_mismatch", "Asset content is unavailable or changed");
    return { bytes, asset };
  }

  async importAsset(projectId: string, input: { operationId: string; assetId: string; filename: string; declaredMimeType?: string; origin: "imported" | "generated" | "document" | "migration"; actor: { kind: "human" | "assistant" | "system"; id?: string }; canvas?: { id: string; expectedRevision: string; position: { x: number; y: number } } }, bytes: Uint8Array): Promise<ToonWorkspaceOperationOutcome> {
    const loaded = input.canvas ? await this.load(projectId) : null;
    const canvasDescriptor = input.canvas ? loaded!.bundle.canvases.canvases.find((item) => item.id === input.canvas!.id) : null;
    if (input.canvas && !canvasDescriptor) throw new ApiError(404, "toon_canvas_not_found", "Toon canvas not found");
    return this.execute(projectId, {
      operationId: input.operationId,
      actor: input.actor,
      origin: input.actor.kind === "assistant" ? "assistant-tool" : "human-ui",
      expectedRevisions: input.canvas ? { [canvasDescriptor!.file]: input.canvas.expectedRevision } : {},
      kind: "asset.import",
      assetId: input.assetId,
      filename: input.filename,
      ...(input.declaredMimeType ? { declaredMimeType: input.declaredMimeType } : {}),
      assetOrigin: input.origin,
      contentBase64: Buffer.from(bytes).toString("base64"),
      ...(input.canvas ? { canvas: { id: input.canvas.id, position: input.canvas.position } } : {}),
    });
  }

  async importAuthorizedAsset(projectId: string, input: { operationId: string; assetId: string; filename: string; sourcePath: string; declaredMimeType?: string; origin: "imported" | "generated" | "document" | "migration"; actor: { kind: "human" | "assistant" | "system"; id?: string }; canvas?: { id: string; expectedRevision: string; position: { x: number; y: number } } }): Promise<ToonWorkspaceOperationOutcome> {
    const filename = normalizeAssetFilename(input.filename);
    const inspected = await this.inspectSafeAssetFile(this.workspaceRoot, input.sourcePath, filename, input.declaredMimeType);
    const semanticInput = { ...input, sourcePath: undefined, filename, checksum: inspected.checksum, bytes: inspected.bytes };
    const payloadHash = sha256(canonical(semanticInput));
    const prior = returnOrThrowPrior(this.runtime.getOutcome(this.workspaceScope, projectId, input.operationId, payloadHash));
    if (prior) return prior;
    const origin = input.actor.kind === "assistant" ? "assistant-tool" as const : "human-ui" as const;
    const command = { operationId: input.operationId, actor: input.actor, origin };
    return this.serializeMutation(projectId, input.operationId, async () => {
      try {
        const loaded = await this.load(projectId);
        if (input.canvas) {
          const descriptor = loaded.bundle.canvases.canvases.find((item) => item.id === input.canvas!.id);
          if (!descriptor) throw new ApiError(404, "toon_canvas_not_found", "Toon canvas not found");
          this.assertExpected({ [descriptor.file]: input.canvas.expectedRevision }, loaded.revisions);
        }
        const built = await this.buildStreamedAssetImport(loaded, input, filename, inspected);
        const candidate = this.applyWritesToBundle(loaded.bundle, built.writes);
        const validated = toonPortableProjectBundleSchema.safeParse(candidate);
        if (!validated.success) throw new ApiError(409, "toon_reference_integrity", "The import would create invalid or ambiguous project references", { issues: validated.error.issues });
        return this.publish(projectId, input.operationId, payloadHash, origin, input.actor, built.writes, built.affected, built.result, undefined, false, loaded.revisions);
      } catch (error) {
        if (!this.runtime.hasRecoverable(this.workspaceScope, projectId, input.operationId)) {
          this.runtime.saveOutcome(this.workspaceScope, projectId, rejectedOutcome(command, payloadHash, [{ kind: "asset", id: input.assetId }], error));
        }
        throw error;
      }
    });
  }

  async searchDocuments(projectId: string, input: unknown, signal?: AbortSignal): Promise<ToonDocumentSearchResponse> {
    const request = parse(toonDocumentSearchRequestSchema, input, "invalid_toon_document_search");
    const loaded = await this.load(projectId);
    const needle = request.query.toLocaleLowerCase();
    const items: ToonDocumentSearchResponse["items"] = [];
    let scannedFiles = 0;
    let scannedBytes = 0;
    let truncated = false;
    const documents = loaded.bundle.documents.documents;
    let nextCursor: number | null = null;
    for (let index = request.cursor; index < documents.length; index += 1) {
      const document = documents[index]!;
      if (signal?.aborted) throw new DOMException("Document search cancelled", "AbortError");
      if (document.state !== "active" || !["markdown", "text"].includes(document.kind)) {
        nextCursor = index + 1 < documents.length ? index + 1 : null;
        continue;
      }
      assertDocumentPath(document.path);
      if (scannedFiles >= MAX_SEARCH_FILES || scannedBytes >= MAX_SEARCH_BYTES || items.length >= request.limit) { truncated = true; nextCursor = index; break; }
      scannedFiles += 1;
      if (request.mode !== "content" && `${document.title}\n${document.path}`.toLocaleLowerCase().includes(needle)) {
        items.push({ documentId: document.id, title: document.title, path: document.path, revision: document.revision, match: "filename", preview: document.path });
        if (items.length >= request.limit) { truncated = true; nextCursor = index + 1 < documents.length ? index + 1 : null; break; }
      }
      if (request.mode === "filename") { nextCursor = index + 1 < documents.length ? index + 1 : null; continue; }
      const bytes = await readSafeFile(loaded.root, document.path, Math.min(MAX_TEXT_BYTES, MAX_SEARCH_BYTES)).catch((error) => {
        if (error instanceof ApiError && error.code === "toon_workspace_content_too_large") return null;
        throw error;
      });
      if (!bytes) { nextCursor = index + 1 < documents.length ? index + 1 : null; continue; }
      if (scannedBytes + bytes.byteLength > MAX_SEARCH_BYTES) { truncated = true; nextCursor = index; scannedFiles -= 1; break; }
      scannedBytes += bytes.byteLength;
      const lines = bytes.toString("utf8").split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        if (signal?.aborted) throw new DOMException("Document search cancelled", "AbortError");
        const line = lines[lineIndex]!;
        const from = line.toLocaleLowerCase().indexOf(needle);
        if (from < 0) continue;
        items.push({ documentId: document.id, title: document.title, path: document.path, revision: document.revision, match: "content", line: lineIndex + 1, from, to: from + request.query.length, preview: line.slice(Math.max(0, from - 120), Math.min(line.length, from + request.query.length + 120)) });
        if (items.length >= request.limit) { truncated = true; nextCursor = index + 1 < documents.length ? index + 1 : null; break; }
        break;
      }
      if (items.length >= request.limit) break;
      nextCursor = index + 1 < documents.length ? index + 1 : null;
    }
    return { items, scannedFiles, scannedBytes, truncated: truncated && nextCursor !== null, nextCursor };
  }

  async listDocumentRevisions(projectId: string, documentId: string): Promise<ToonDocumentRevisionListResponse> {
    const loaded = await this.load(projectId);
    if (!loaded.bundle.documents.documents.some((document) => document.id === documentId)) throw new ApiError(404, "toon_document_not_found", "Toon document not found");
    return (await this.readDocumentRevisions(loaded.root, documentId)).response;
  }

  private async readDocumentRevisions(root: string, documentId: string): Promise<{ response: ToonDocumentRevisionListResponse; revision: string | null }> {
    const bytes = await readSafeFile(root, `.toon-history/documents/${documentId}/index.json`, MAX_JSON_BYTES);
    if (!bytes) return { response: { items: [] }, revision: null };
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new ApiError(422, "invalid_toon_document_history", "Document history is invalid"); }
    return { response: toonDocumentRevisionListResponseSchema.parse({ items: value }), revision: sha256(bytes) };
  }

  async restoreDocumentRevision(projectId: string, documentId: string, revisionId: string, input: unknown): Promise<ToonWorkspaceOperationOutcome> {
    const request = parse(toonDocumentRevisionRestoreRequestSchema, input, "invalid_toon_document_revision_restore");
    const payloadHash = sha256(canonical({ ...request, documentId, revisionId }));
    const prior = returnOrThrowPrior(this.runtime.getOutcome(this.workspaceScope, projectId, request.operationId, payloadHash));
    if (prior) return prior;
    const affected: ToonPortableReference[] = [{ kind: "document", id: documentId }];
    const command = { operationId: request.operationId, origin: request.origin, actor: request.actor };
    return this.serializeMutation(projectId, request.operationId, async () => {
      const loaded = await this.load(projectId);
      const descriptor = loaded.bundle.documents.documents.find((document) => document.id === documentId);
      if (!descriptor) throw new ApiError(404, "toon_document_not_found", "Toon document not found");
      this.assertExpected({ [descriptor.path]: request.expectedRevision }, loaded.revisions);
      const historyPath = `.toon-history/documents/${documentId}/index.json`;
      const history = await this.readDocumentRevisions(loaded.root, documentId);
      if (history.revision) loaded.revisions[historyPath] = history.revision;
      const revision = history.response.items.find((item) => item.id === revisionId);
      if (!revision) throw new ApiError(404, "toon_document_revision_not_found", "Document revision not found");
      const bytes = await readSafeFile(loaded.root, revision.path, MAX_TEXT_BYTES);
      if (!bytes || sha256(bytes) !== revision.revision) throw new ApiError(409, "toon_document_revision_invalid", "Document revision content is missing or invalid");
      const writes = await this.applyCommand(loaded, { operationId: request.operationId, actor: request.actor, origin: request.origin, expectedRevisions: { [descriptor.path]: request.expectedRevision }, kind: "document.write", documentId, content: bytes.toString("utf8") });
      return this.publish(projectId, request.operationId, payloadHash, request.origin, request.actor, writes, affected, { restoredRevisionId: revision.id }, undefined, false, loaded.revisions);
    }).catch((error) => {
      this.runtime.saveOutcome(this.workspaceScope, projectId, rejectedOutcome(command, payloadHash, affected, error));
      throw error;
    });
  }

  async acquireCanvasLease(projectId: string, input: unknown): Promise<{ leaseId: string; canvasId: string; leaseToken: string; generation: number; expiresAt: number }> {
    const request = parse(toonCanvasLeaseRequestSchema, input, "invalid_toon_canvas_lease");
    const loaded = await this.load(projectId);
    if (!loaded.bundle.canvases.canvases.some((canvas) => canvas.id === request.canvasId && canvas.state === "active")) throw new ApiError(404, "toon_canvas_not_found", "Toon canvas not found");
    const expiresAt = Date.now() + request.ttlMs;
    const lease = this.runtime.acquireCanvasLease(this.workspaceScope, projectId, request.canvasId, request.leaseId, request.holder, expiresAt);
    return { leaseId: request.leaseId, canvasId: request.canvasId, ...lease, expiresAt };
  }

  releaseCanvasLease(projectId: string, canvasId: string, leaseId: string): void {
    this.runtime.releaseCanvasLease(this.workspaceScope, projectId, canvasId, leaseId);
  }

  async listCanvasCheckpoints(projectId: string, canvasId: string): Promise<{ items: ToonCanvasCheckpoint[] }> {
    const loaded = await this.load(projectId);
    if (!loaded.bundle.canvases.canvases.some((canvas) => canvas.id === canvasId)) throw new ApiError(404, "toon_canvas_not_found", "Toon canvas not found");
    const path = `.toon-history/${canvasId}/index.json`;
    const bytes = await readSafeFile(loaded.root, path, MAX_JSON_BYTES);
    if (!bytes) return { items: [] };
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new ApiError(422, "invalid_toon_canvas_history", "Canvas history is invalid"); }
    const parsed = toonCanvasCheckpointSchema.array().safeParse(value);
    if (!parsed.success) throw new ApiError(422, "invalid_toon_canvas_history", "Canvas history is invalid", { issues: parsed.error.issues });
    return { items: parsed.data };
  }

  async createCanvasCheckpoint(projectId: string, input: unknown): Promise<ToonWorkspaceOperationOutcome> {
    const request = parse(toonCanvasCheckpointCreateRequestSchema, input, "invalid_toon_canvas_checkpoint");
    const command = { operationId: request.operationId, origin: request.origin, actor: request.actor };
    const payloadHash = sha256(canonical(request));
    const prior = returnOrThrowPrior(this.runtime.getOutcome(this.workspaceScope, projectId, request.operationId, payloadHash));
    if (prior) return prior;
    return this.serializeMutation(projectId, request.operationId, async () => {
      const loaded = await this.load(projectId);
      const descriptor = loaded.bundle.canvases.canvases.find((canvas) => canvas.id === request.canvasId);
      if (!descriptor) throw new ApiError(404, "toon_canvas_not_found", "Toon canvas not found");
      this.assertExpected({ [descriptor.file]: request.expectedRevision }, loaded.revisions);
      const checkpointId = `checkpoint-${request.operationId}`.slice(0, 128);
      const checkpointPath = `.toon-history/${request.canvasId}/${checkpointId}.json`;
      const indexPath = `.toon-history/${request.canvasId}/index.json`;
      const existing = await this.listCanvasCheckpoints(projectId, request.canvasId);
      const checkpoint: ToonCanvasCheckpoint = toonCanvasCheckpointSchema.parse({
        id: checkpointId, canvasId: request.canvasId, title: request.title, canvasRevision: request.expectedRevision,
        path: checkpointPath, origin: request.origin, actor: request.actor, createdAt: new Date().toISOString(),
      });
      return this.publish(projectId, request.operationId, payloadHash, request.origin, request.actor, [
        { path: checkpointPath, content: json(loaded.bundle.canvasFiles[descriptor.file]) },
        { path: indexPath, content: json([...existing.items, checkpoint]) },
      ], [{ kind: "canvas", id: request.canvasId }], { checkpoint });
    }).catch((error) => {
      this.runtime.saveOutcome(this.workspaceScope, projectId, rejectedOutcome(command, payloadHash, [{ kind: "canvas", id: request.canvasId }], error));
      throw error;
    });
  }

  async restoreCanvasCheckpoint(projectId: string, canvasId: string, input: unknown): Promise<ToonWorkspaceOperationOutcome> {
    const request = parse(toonCanvasCheckpointRestoreRequestSchema, input, "invalid_toon_canvas_checkpoint_restore");
    if (request.checkpointId.length === 0) throw new ApiError(400, "invalid_toon_canvas_checkpoint_restore", "Checkpoint ID is required");
    const payloadHash = sha256(canonical({ ...request, canvasId }));
    const prior = returnOrThrowPrior(this.runtime.getOutcome(this.workspaceScope, projectId, request.operationId, payloadHash));
    if (prior) return prior;
    const affected: ToonPortableReference[] = [{ kind: "canvas", id: canvasId }];
    const command = { operationId: request.operationId, origin: request.origin, actor: request.actor };
    return this.serializeMutation(projectId, request.operationId, async () => {
      const loaded = await this.load(projectId);
      const descriptor = loaded.bundle.canvases.canvases.find((canvas) => canvas.id === canvasId);
      if (!descriptor) throw new ApiError(404, "toon_canvas_not_found", "Toon canvas not found");
      this.assertExpected({ [descriptor.file]: request.expectedRevision }, loaded.revisions);
      const history = await this.listCanvasCheckpoints(projectId, canvasId);
      const checkpoint = history.items.find((item) => item.id === request.checkpointId);
      if (!checkpoint) throw new ApiError(404, "toon_canvas_checkpoint_not_found", "Canvas checkpoint not found");
      const bytes = await readSafeFile(loaded.root, checkpoint.path, MAX_JSON_BYTES);
      if (!bytes) throw new ApiError(404, "toon_canvas_checkpoint_not_found", "Canvas checkpoint content is missing");
      const restored = parse(toonWorkspaceCanvasSchema, JSON.parse(bytes.toString("utf8")), "invalid_toon_canvas_checkpoint");
      const beforeId = `checkpoint-before-${request.operationId}`.slice(0, 128);
      const beforePath = `.toon-history/${canvasId}/${beforeId}.json`;
      const before: ToonCanvasCheckpoint = toonCanvasCheckpointSchema.parse({
        id: beforeId, canvasId, title: `Before restore: ${checkpoint.title}`, canvasRevision: request.expectedRevision,
        path: beforePath, origin: request.origin, actor: request.actor, createdAt: new Date().toISOString(),
      });
      const body = { ...restored, revisionId: `revision-${request.operationId}`.slice(0, 128) };
      const writes = await this.applyCommand(loaded, {
        operationId: request.operationId, actor: request.actor, origin: request.origin,
        expectedRevisions: { [descriptor.file]: request.expectedRevision }, kind: "canvas.write", canvasId, body,
      });
      writes.unshift(
        { path: beforePath, content: json(loaded.bundle.canvasFiles[descriptor.file]) },
        { path: `.toon-history/${canvasId}/index.json`, content: json([...history.items, before]) },
      );
      return this.publish(projectId, request.operationId, payloadHash, request.origin, request.actor, writes, affected, { restoredCheckpointId: checkpoint.id, preservedCheckpointId: before.id });
    }).catch((error) => {
      this.runtime.saveOutcome(this.workspaceScope, projectId, rejectedOutcome(command, payloadHash, affected, error));
      throw error;
    });
  }

  async migrationPreflight(projectId: string): Promise<ToonMigrationPreflight> {
    const v1 = await this.loadV1(projectId);
    const files = await this.listProjectFiles(v1.root);
    const backupLocation = `.toon-backups/migrate-${v1.revision.slice(0, 12)}`;
    const changedFiles = [CATALOG_PATHS.canvases, CATALOG_PATHS.documents, CATALOG_PATHS.assets, ...v1.canvases.map((item) => `canvases/${item.id}.json`), PROJECT_FILE];
    const requiredBytes = files.reduce((sum, file) => sum + file.bytes, 0) * 2 + changedFiles.length * 4096;
    return {
      sourceVersion: 1,
      targetVersion: 2,
      projectId,
      projectRevision: v1.revision,
      changedFiles,
      unsupportedContent: this.runtime.hasActiveTextJobs(this.workspaceScope, projectId)
        ? [{ path: PROJECT_FILE, reason: "Active text generation must finish or be cancelled before migration so its runtime ownership is not orphaned." }]
        : [],
      requiredBytes,
      backupLocation,
      rollbackEligible: true,
      rollbackLimits: ["In-place rollback is disabled after v2-only edits are committed."],
    };
  }

  async migrate(projectId: string, input: unknown): Promise<ToonWorkspaceOperationOutcome> {
    const request = parse(toonMigrationApplyRequestSchema, input, "invalid_toon_migration_request");
    const payloadHash = sha256(canonical(request));
    const prior = returnOrThrowPrior(this.runtime.getOutcome(this.workspaceScope, projectId, request.operationId, payloadHash));
    if (prior) return prior;
    return this.serializeMutation(projectId, request.operationId, async () => {
      const v1 = await this.loadV1(projectId);
      if (v1.revision !== request.expectedRevision) throw new ApiError(409, "toon_factory_revision_conflict", "The v1 project changed after migration preflight", { expectedRevision: request.expectedRevision, currentRevision: v1.revision });
      if (this.runtime.hasActiveTextJobs(this.workspaceScope, projectId)) throw new ApiError(409, "toon_migration_active_text_job", "Active text generation must finish or be cancelled before migration");
      const backupRoot = `.toon-backups/${request.operationId}`;
      await this.hooks.beforeMigrationCapture?.();
      const files = await this.listProjectFiles(v1.root, true);
      const captured = new Map(files.map((file) => [file.path, file.revision]));
      if (captured.get(PROJECT_FILE) !== v1.revision || [...v1.canvasRevisions].some(([path, revision]) => captured.get(path) !== revision)) {
        throw new ApiError(409, "toon_migration_source_changed", "A migration source changed while the complete source snapshot was captured");
      }
      const manifestEntries: ToonMigrationBackupManifest["entries"] = [];
      for (const file of files) {
        const destination = `${backupRoot}/files/${file.path}`;
        manifestEntries.push({ path: file.path, backupPath: destination, revision: file.revision, bytes: file.bytes });
      }
      const backupManifest: ToonMigrationBackupManifest = {
        schemaVersion: 1, projectId, operationId: request.operationId, createdAt: new Date().toISOString(), entries: manifestEntries, rollbackEligible: true,
      };
      const backupManifestPath = `${backupRoot}/manifest.json`;
      const now = new Date().toISOString();
      const canvasFiles: Record<string, ToonWorkspaceCanvas> = {};
      const canvasDescriptors: ToonCanvasCatalog["canvases"] = [];
      const usedNodeIds = new Set<string>();
      const nodeRemaps = new Map<string, Map<string, string>>();
      for (const [index, canvas] of v1.canvases.entries()) {
        const remap = new Map<string, string>();
        for (const [nodeIndex, node] of canvas.nodes.entries()) {
          let next = node.id;
          if (usedNodeIds.has(next)) next = `${canvas.id}-${node.id}-${nodeIndex + 1}`.slice(0, 128);
          while (usedNodeIds.has(next)) next = `${next}-${nodeIndex + 1}`.slice(0, 128);
          usedNodeIds.add(next);
          remap.set(node.id, next);
        }
        nodeRemaps.set(canvas.id, remap);
        const converted = this.convertCanvas(canvas, remap);
        const path = `canvases/v2/${canvas.id}.json`;
        const content = json(converted);
        canvasFiles[path] = converted;
        canvasDescriptors.push({ id: canvas.id, title: canvas.name, kind: "episode", order: index, file: path, revision: sha256(content), state: "active" });
      }
      const mediaJobs: ToonMediaJob[] = [];
      for (const file of files.filter((item) => /^generations\/manifests\/[^/]+\.json$/.test(item.path))) {
        try {
          const parsed = toonMediaJobSchema.safeParse(JSON.parse(file.content!.toString("utf8")));
          if (parsed.success && parsed.data.projectId === projectId) mediaJobs.push(parsed.data);
        } catch { /* Preserve unknown manifests in the backup without executing them. */ }
      }
      const migratedAssets: ToonAssetCatalog["assets"] = [];
      const migratedAssetContents = new Map<string, Uint8Array>();
      const assetByCandidate = new Map<string, ToonAssetDescriptor>();
      const migratedGenerations: ToonWorkspaceProject["workflow"]["generations"] = [];
      const migratedAdoptions: ToonWorkspaceProject["workflow"]["adoptions"] = [];
      const generationIdByRuntimeJob = new Map<string, string>();
      for (const job of mediaJobs) {
        const episode = v1.project.episodes.find((item) => item.id === job.episodeId && item.canvasId === job.canvasId);
        const step = episode?.steps?.find((item) => item.id === job.stepId);
        const nodeId = nodeRemaps.get(job.canvasId)?.get(job.nodeId) ?? job.nodeId;
        if (!episode || !step || !usedNodeIds.has(nodeId)) continue;
        const generationId = `generation-${job.requestHash.slice(0, 24)}`;
        generationIdByRuntimeJob.set(job.id, generationId);
        const references: ToonPortableReference[] = [];
        for (const path of job.requestSnapshot.plan.referencePaths) {
          const asset = migratedAssets.find((item) => item.path === path);
          if (asset) references.push({ kind: "asset", id: asset.id, revision: asset.checksum });
        }
        const candidates: ToonWorkspaceGenerationRecord["candidates"] = [];
        for (const candidate of job.candidates) {
          let asset: ToonAssetDescriptor | undefined;
          if (candidate.artifact) {
            const sourceRoot = candidate.artifact.scope === "project" ? v1.root : this.workspaceRoot;
            const bytes = await readSafeFile(sourceRoot, candidate.artifact.path, Number.MAX_SAFE_INTEGER);
            if (bytes) {
              const assetId = `asset-${candidate.id}`.slice(0, 128);
              const checksum = sha256(bytes);
              const assetPath = candidate.artifact.scope === "project" && candidate.artifact.path.startsWith("assets/")
                ? candidate.artifact.path
                : `assets/generated/${generationId}/${candidate.id}${extname(candidate.artifact.path) || ".bin"}`;
              asset = migratedAssets.find((item) => item.path === assetPath || item.checksum === checksum) ?? {
                id: assetId, title: basename(candidate.artifact.path), path: assetPath,
                mimeType: candidate.artifact.mimeType, bytes: bytes.byteLength, checksum, origin: "generated", state: "active",
                references: [{ kind: "generation", id: generationId, revision: job.requestHash }, { kind: "node", id: nodeId }, { kind: "workflow", id: job.stepId }],
                createdAt: candidate.createdAt, updatedAt: candidate.updatedAt,
              };
              if (!migratedAssets.some((item) => item.id === asset!.id)) migratedAssets.push(asset);
              if (assetPath !== candidate.artifact.path || candidate.artifact.scope === "workspace") migratedAssetContents.set(assetPath, bytes);
              assetByCandidate.set(candidate.id, asset);
            }
          }
          candidates.push({
            id: candidate.id, ordinal: candidate.ordinal, status: candidate.status,
            ...(candidate.progress !== undefined ? { progress: candidate.progress } : {}),
            ...(asset ? { assetId: asset.id, mimeType: asset.mimeType, bytes: asset.bytes, checksum: asset.checksum } : {}),
            ...(candidate.error ? { error: candidate.error } : {}), createdAt: candidate.createdAt, updatedAt: candidate.updatedAt,
          });
        }
        const status = migratedGenerationStatus(job.status);
        migratedGenerations.push({
          id: generationId, requestId: job.requestSnapshot.requestId, episodeId: job.episodeId, workflowRecordId: job.stepId,
          canvasId: job.canvasId, nodeId, source: "canvas",
          plan: {
            kind: job.requestSnapshot.plan.kind, model: job.requestSnapshot.plan.model, object: job.requestSnapshot.plan.object,
            quantity: job.requestSnapshot.plan.quantity, prompt: job.requestSnapshot.plan.prompt, references,
            parameters: job.requestSnapshot.plan.kind === "image"
              ? { mode: job.requestSnapshot.plan.mode, ...(job.requestSnapshot.plan.size ? { size: job.requestSnapshot.plan.size } : {}) }
              : { mode: job.requestSnapshot.plan.mode, durationSeconds: job.requestSnapshot.plan.durationSeconds, resolution: job.requestSnapshot.plan.resolution },
            executionCount: job.requestSnapshot.plan.executionCount, knownCost: job.requestSnapshot.plan.knownCost,
          },
          requestHash: job.requestHash, revision: entityRevision({ status, candidates }), status,
          dependencyLinks: [], authorization: job.authorization, candidates, createdAt: job.createdAt, updatedAt: job.updatedAt,
        });
        for (const adoption of step.resultAdoptions) {
          const asset = assetByCandidate.get(adoption.resultId);
          if (!asset || !candidates.some((candidate) => candidate.id === adoption.resultId)) continue;
          migratedAdoptions.push({
            id: adoption.id, generationId, candidateId: adoption.resultId, assetId: asset.id, canvasId: job.canvasId,
            nodeId, episodeId: job.episodeId, workflowRecordId: job.stepId,
            revision: entityRevision({ generationId, candidateId: adoption.resultId, assetId: asset.id, adoptedAt: adoption.adoptedAt }),
            adoptedAt: adoption.adoptedAt, ...(adoption.supersededAt ? { supersededAt: adoption.supersededAt } : {}),
          });
        }
        const canvasPath = canvasDescriptors.find((item) => item.id === job.canvasId)?.file;
        if (canvasPath) {
          const canvas = canvasFiles[canvasPath]!;
          canvasFiles[canvasPath] = { ...canvas, nodes: canvas.nodes.map((node) => node.id === nodeId ? { ...node, config: { ...node.config, generation: { kind: "generation", id: generationId, revision: job.requestHash }, ...(migratedAdoptions.find((item) => item.generationId === generationId && !item.supersededAt) ? { asset: { kind: "asset", id: migratedAdoptions.find((item) => item.generationId === generationId && !item.supersededAt)!.assetId } } : {}) } } : node) };
        }
      }
      const textResultIds = new Map<string, string>();
      const migratedTextContents = new Map<string, string>();
      const migratedTextManifests = new Map<string, string>();
      for (const episode of v1.project.episodes) for (const step of episode.steps ?? []) for (const result of step.generatedResults ?? []) {
        const portableResultId = `text-result-${sha256(`${episode.id}\0${step.id}\0${result.id}\0${result.outputRevision}`).slice(0, 24)}`;
        textResultIds.set(result.id, portableResultId);
        const nodeId = nodeRemaps.get(episode.canvasId)?.get(result.nodeId) ?? result.nodeId;
        const contentRef = `content/generated/${portableResultId}.md`;
        const resultRef = `generations/manifests/${portableResultId}.json`;
        const content = await readSafeFile(v1.root, result.contentRef, MAX_TEXT_BYTES);
        if (content) migratedTextContents.set(contentRef, content.toString("utf8"));
        const manifestBytes = await readSafeFile(v1.root, result.resultRef, MAX_JSON_BYTES);
        let source: Record<string, unknown> = {};
        try {
          const parsed = manifestBytes ? JSON.parse(manifestBytes.toString("utf8")) : {};
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) source = parsed as Record<string, unknown>;
        } catch { /* The validated backup retains malformed legacy manifests. */ }
        migratedTextManifests.set(resultRef, json({
          schemaVersion: 2, id: portableResultId, action: result.action, status: result.status,
          nodeId, outputRevision: result.outputRevision, contentRef, recordedAt: result.recordedAt,
          ...(source.request && typeof source.request === "object" ? { request: source.request } : {}),
          ...(source.selectedModel && typeof source.selectedModel === "object" ? { selectedModel: source.selectedModel } : {}),
          ...(source.outputSchema && typeof source.outputSchema === "object" ? { outputSchema: source.outputSchema } : {}),
          ...(source.output !== undefined ? { output: source.output } : {}),
        }));
        const canvasPath = canvasDescriptors.find((item) => item.id === episode.canvasId)?.file;
        if (canvasPath) {
          const canvas = canvasFiles[canvasPath]!;
          canvasFiles[canvasPath] = { ...canvas, nodes: canvas.nodes.map((node) => node.id === nodeId ? { ...node, config: { ...node.config, generation: { kind: "generation", id: portableResultId, revision: result.outputRevision } } } : node) };
        }
      }
      const migratedDeliveryManifests = new Map<string, string>();
      for (const file of files.filter((item) => /^exports\/episodes\/[^/]+\/delivery-manifest\.json$/.test(item.path))) {
        try {
          const parsed = toonDeliveryManifestSchema.safeParse(JSON.parse(file.content!.toString("utf8")));
          if (!parsed.success) continue;
          const artifacts = parsed.data.artifacts.flatMap((artifact) => {
            const generationRecordId = generationIdByRuntimeJob.get(artifact.generationRecordId);
            return generationRecordId ? [{ ...artifact, generationRecordId }] : [];
          });
          migratedDeliveryManifests.set(file.path, json({ ...parsed.data, artifacts }));
        } catch { /* The validated backup retains malformed legacy delivery manifests. */ }
      }
      for (const descriptor of canvasDescriptors) descriptor.revision = sha256(json(canvasFiles[descriptor.file]!));
      const project: ToonWorkspaceProject = {
        schemaVersion: 2,
        metadata: { id: v1.project.id, name: v1.project.name, createdAt: v1.project.createdAt, updatedAt: v1.project.updatedAt },
        catalogs: { canvases: CATALOG_PATHS.canvases, documents: CATALOG_PATHS.documents, assets: CATALOG_PATHS.assets },
        ...(v1.project.episodes[0]?.canvasId ? { activeCanvasId: v1.project.episodes[0].canvasId } : canvasDescriptors[0] ? { activeCanvasId: canvasDescriptors[0].id } : {}),
        ...(v1.project.selectedModels ? { modelDefaults: v1.project.selectedModels } : {}),
        workflow: { episodes: v1.project.episodes.map(({ steps, ...episode }) => ({
          ...episode,
          ...(steps ? { steps: steps.map((step) => {
            const { generationJobId, generatedResults, ...portableStep } = step;
            const remappedResults = generatedResults?.map(({ jobId: _jobId, ...result }) => {
              const id = textResultIds.get(result.id) ?? result.id;
              return { ...result, id, nodeId: nodeRemaps.get(episode.canvasId)?.get(result.nodeId) ?? result.nodeId, contentRef: `content/generated/${id}.md`, resultRef: `generations/manifests/${id}.json` };
            });
            return {
              ...portableStep,
              resultAdoptions: portableStep.resultAdoptions.map((adoption) => ({ ...adoption, resultId: textResultIds.get(adoption.resultId) ?? adoption.resultId })),
              dependencyLinks: [],
              ...(remappedResults?.length ? {
                generationRefs: remappedResults.map((result) => ({ kind: "generation" as const, id: result.id, revision: result.outputRevision })),
                generatedResults: remappedResults,
              } : {}),
            };
          }) } : {}),
        })), generations: migratedGenerations, adoptions: migratedAdoptions },
        migration: { sourceVersion: 1, migratedAt: now, backupManifestRef: backupManifestPath },
      };
      const canvases: ToonCanvasCatalog = { schemaVersion: 2, projectId, folders: [], canvases: canvasDescriptors };
      const migratedDocuments: ToonDocumentCatalog["documents"] = [];
      const migratedDocumentContents = new Map<string, string>();
      const seenDocuments = new Set<string>();
      const seenAssets = new Set<string>();
      for (const canvas of v1.canvases) {
        const remap = nodeRemaps.get(canvas.id)!;
        for (const node of canvas.nodes) {
          const migratedNodeId = remap.get(node.id)!;
          if (node.data.contentRef && !seenDocuments.has(migratedNodeId)) {
            const bytes = await readSafeFile(v1.root, node.data.contentRef, MAX_TEXT_BYTES);
            if (bytes) {
              const path = node.data.contentRef.replace(/^content\/nodes\//, "documents/");
              migratedDocuments.push({ id: migratedNodeId, title: node.data.label ?? migratedNodeId, path, kind: "markdown", mimeType: "text/markdown", revision: sha256(bytes), state: "active", updatedAt: now });
              migratedDocumentContents.set(path, bytes.toString("utf8"));
              seenDocuments.add(migratedNodeId);
            }
          }
          if (node.data.assetRef && !seenAssets.has(migratedNodeId)) {
            const bytes = await readSafeFile(v1.root, node.data.assetRef, Number.MAX_SAFE_INTEGER);
            if (bytes) {
              const metadata = await lstat(await resolveWithinRoot(v1.root, node.data.assetRef));
               if (!migratedAssets.some((item) => item.id === migratedNodeId || item.path === node.data.assetRef)) migratedAssets.push({ id: migratedNodeId, title: node.data.label ?? migratedNodeId, path: node.data.assetRef, mimeType: "application/octet-stream", bytes: metadata.size, checksum: sha256(bytes), origin: "migration", state: "active", references: [{ kind: "node", id: migratedNodeId }], createdAt: now, updatedAt: now });
              seenAssets.add(migratedNodeId);
            }
          }
        }
      }
      const documents: ToonDocumentCatalog = { schemaVersion: 2, projectId, folders: [], documents: migratedDocuments };
      const assets: ToonAssetCatalog = { schemaVersion: 2, projectId, assets: migratedAssets };
      toonPortableProjectBundleSchema.parse({ project, canvases, documents, assets, canvasFiles });
      this.runtime.reconcileProject(this.workspaceScope, projectId, v1.root, 2);
      const writes = [
        ...files.map((file) => ({ path: `${backupRoot}/files/${file.path}`, content: file.content! })),
        { path: backupManifestPath, content: json(backupManifest) },
        ...Object.entries(canvasFiles).map(([path, canvas]) => ({ path, content: json(canvas) })),
        ...[...migratedDocumentContents].map(([path, content]) => ({ path, content })),
        ...[...migratedTextContents].map(([path, content]) => ({ path, content })),
        ...[...migratedTextManifests].map(([path, content]) => ({ path, content })),
        ...[...migratedDeliveryManifests].map(([path, content]) => ({ path, content })),
        ...[...migratedAssetContents].map(([path, content]) => ({ path, content })),
        { path: CATALOG_PATHS.canvases, content: json(canvases) },
        { path: CATALOG_PATHS.documents, content: json(documents) },
        { path: CATALOG_PATHS.assets, content: json(assets) },
        { path: PROJECT_FILE, content: json(project), rootLast: true },
      ];
      const outcome = await this.publish(projectId, request.operationId, payloadHash, "migration", request.actor, writes, [{ kind: "project", id: projectId }], { migrated: true, backupManifest: backupManifestPath }, v1.root, false, undefined, files);
      await this.load(projectId);
      return outcome;
    });
  }

  async recover(): Promise<number> {
    let recovered = 0;
    for (const record of this.runtime.listRecoverable(this.workspaceScope)) {
      await this.serializeMutation(record.projectId, `recovery-${record.operationId}`, async () => {
        const payload = record.journal as unknown as JournalPayload;
        if (!payload || !Array.isArray(payload.entries) || typeof payload.projectRoot !== "string") {
          this.runtime.updateJournal(record.workspaceScope, record.projectId, record.operationId, "terminal", "invalid");
          return;
        }
        if (record.state === "prepared") {
          await this.cleanupPrepared(payload);
          this.runtime.updateJournal(record.workspaceScope, record.projectId, record.operationId, "terminal", "rolled_back");
          recovered += 1;
          return;
        }
        try {
          await this.resumePublish(payload);
        } catch (error) {
          if (!await this.publicationStarted(payload)) {
            await this.cleanupPrepared(payload);
            this.runtime.updateJournal(record.workspaceScope, record.projectId, record.operationId, "terminal", "rolled_back");
            recovered += 1;
            return;
          }
          throw error;
        }
        this.runtime.updateJournal(record.workspaceScope, record.projectId, record.operationId, "committed");
        const outcome = toonWorkspaceOperationOutcomeSchema.parse({
          ...payload.outcome,
          status: "recovered",
          origin: "recovery",
          actor: { kind: "system" },
        });
        this.runtime.saveOutcome(record.workspaceScope, record.projectId, outcome);
        this.runtime.updateJournal(record.workspaceScope, record.projectId, record.operationId, "terminal", "recovered");
        await this.cleanupPublished(payload);
        recovered += 1;
      });
    }
    return recovered;
  }

  private async load(projectId: string): Promise<{ root: string; bundle: ToonPortableProjectBundle; revisions: Record<string, string> }> {
    const found = await this.findProject(projectId, 2);
    const rootResult = await readJson(found.root, PROJECT_FILE, toonWorkspaceProjectSchema);
    const canvasCatalog = await readJson(found.root, rootResult.value.catalogs.canvases, toonCanvasCatalogSchema);
    const documentCatalog = await readJson(found.root, rootResult.value.catalogs.documents, toonDocumentCatalogSchema);
    const assetCatalog = await readJson(found.root, rootResult.value.catalogs.assets, toonAssetCatalogSchema);
    const canvasFiles: Record<string, ToonWorkspaceCanvas> = {};
    const revisions: Record<string, string> = {
      [PROJECT_FILE]: rootResult.revision,
      [rootResult.value.catalogs.canvases]: canvasCatalog.revision,
      [rootResult.value.catalogs.documents]: documentCatalog.revision,
      [rootResult.value.catalogs.assets]: assetCatalog.revision,
    };
    for (const descriptor of canvasCatalog.value.canvases) {
      const canvas = await readJson(found.root, descriptor.file, toonWorkspaceCanvasSchema);
      if (canvas.revision !== descriptor.revision) throw new ApiError(409, "toon_canvas_revision_mismatch", "Canvas descriptor revision does not match its file", { canvasId: descriptor.id });
      canvasFiles[descriptor.file] = canvas.value;
      revisions[descriptor.file] = canvas.revision;
    }
    for (const descriptor of documentCatalog.value.documents) {
      const bytes = await readSafeFile(found.root, descriptor.path, MAX_TEXT_BYTES);
      if (!bytes && descriptor.state === "active") throw new ApiError(409, "toon_document_missing", "An active catalog document is missing", { documentId: descriptor.id });
      if (bytes) {
        const documentRevision = sha256(bytes);
        if (documentRevision !== descriptor.revision) throw new ApiError(409, "toon_document_revision_mismatch", "Document descriptor revision does not match its file", { documentId: descriptor.id });
        revisions[descriptor.path] = documentRevision;
      }
    }
    for (const descriptor of assetCatalog.value.assets) {
      const path = descriptor.state === "trashed" ? descriptor.trashPath : descriptor.state === "active" ? descriptor.path : undefined;
      if (!path) continue;
      const bytes = await readSafeFile(found.root, path, Number.MAX_SAFE_INTEGER);
      if (!bytes) throw new ApiError(409, "toon_asset_missing", "Cataloged asset content is missing", { assetId: descriptor.id });
      if (bytes.byteLength !== descriptor.bytes || sha256(bytes) !== descriptor.checksum) throw new ApiError(409, "toon_asset_integrity_mismatch", "Cataloged asset content failed integrity validation", { assetId: descriptor.id });
      if (isSafeAssetPreviewMime(descriptor.mimeType)) inspectAssetBytes(bytes, basename(descriptor.path), descriptor.mimeType);
      revisions[path] = descriptor.checksum;
    }
    const bundle = toonPortableProjectBundleSchema.parse({ project: rootResult.value, canvases: canvasCatalog.value, documents: documentCatalog.value, assets: assetCatalog.value, canvasFiles });
    this.runtime.reconcileProject(this.workspaceScope, projectId, found.root, 2);
    for (const generation of bundle.project.workflow.generations) {
      const job = this.runtime.mediaJobByRequest(this.workspaceScope, projectId, generation.requestId);
      if (!job || job.requestHash !== generation.requestHash || job.canvasId !== generation.canvasId || job.nodeId !== generation.nodeId || job.workflowRecordId !== generation.workflowRecordId) continue;
      this.runtime.linkGeneration({ workspaceScope: this.workspaceScope, projectId, generationId: generation.id, runtimeJobId: job.id, canvasId: generation.canvasId, nodeId: generation.nodeId });
    }
    return { root: found.root, bundle, revisions };
  }

  private async serializeMutation<T>(projectId: string, operationId: string, operation: () => Promise<T>): Promise<T> {
    return serializeProject(`${this.workspaceScope}:${projectId}`, async () => {
      const leaseId = `lease-${randomUUID()}`;
      this.runtime.acquireLease(this.workspaceScope, projectId, leaseId, operationId.slice(0, 512), Date.now() + 60_000);
      try { return await operation(); } finally { this.runtime.releaseLease(this.workspaceScope, projectId, leaseId); }
    });
  }

  private async loadV1(projectId: string): Promise<{ root: string; project: ToonProject; canvases: ToonCanvas[]; canvasRevisions: Map<string, string>; revision: string }> {
    const found = await this.findProject(projectId, 1);
    const project = await readJson(found.root, PROJECT_FILE, toonProjectSchema);
    const canvasIds = new Set(["main", ...project.value.episodes.map((episode) => episode.canvasId)]);
    const canvases: ToonCanvas[] = [];
    const canvasRevisions = new Map<string, string>();
    for (const canvasId of canvasIds) {
      const bytes = await readSafeFile(found.root, `canvases/${canvasId}.json`);
      if (!bytes) continue;
      const parsed = toonCanvasSchema.safeParse(JSON.parse(bytes.toString("utf8")));
      if (!parsed.success) throw new ApiError(422, "invalid_toon_canvas", "A v1 canvas is invalid", { issues: parsed.error.issues });
      canvases.push(parsed.data);
      canvasRevisions.set(`canvases/${canvasId}.json`, sha256(bytes));
    }
    return { root: found.root, project: project.value, canvases, canvasRevisions, revision: project.revision };
  }

  private async findProject(projectId: string, version: 1 | 2): Promise<{ root: string }> {
    const workspaceRoot = await realpath(this.workspaceRoot);
    let visited = 0;
    const matches: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      if (++visited > MAX_DISCOVERY_DIRECTORIES) throw new ApiError(422, "toon_factory_discovery_limit", "Too many workspace directories to discover Toon projects");
      const entries = await readdir(directory, { withFileTypes: true });
      const projectEntry = entries.find((entry) => entry.name === PROJECT_FILE && entry.isFile() && !entry.isSymbolicLink());
      if (projectEntry) {
        const bytes = await readSafeFile(directory, PROJECT_FILE);
        let root: unknown;
        try { root = bytes ? JSON.parse(bytes.toString("utf8")) : null; } catch { throw new ApiError(422, "invalid_toon_project", "Toon project contains invalid JSON"); }
        const actualVersion = root && typeof root === "object" ? (root as { schemaVersion?: unknown }).schemaVersion : undefined;
        if (typeof actualVersion === "number" && actualVersion > TOON_WORKSPACE_SCHEMA_VERSION) throw new ApiError(422, "toon_factory_unsupported_version", "Unsupported Toon project schema version", { supportedVersion: TOON_WORKSPACE_SCHEMA_VERSION, actualVersion });
        const actualId = actualVersion === 2 ? (root as { metadata?: { id?: unknown } }).metadata?.id : (root as { id?: unknown }).id;
        if (actualId === projectId && actualVersion === version) matches.push(directory);
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || [".git", "node_modules", ".toon-backups", ".toon-journal", ".toon-trash"].includes(entry.name)) continue;
        await visit(join(directory, entry.name));
      }
    };
    await visit(workspaceRoot);
    if (matches.length === 0) throw new ApiError(404, "toon_project_not_found", "Toon project not found");
    if (matches.length > 1) throw new ApiError(409, "toon_project_id_conflict", "Multiple Toon projects use the same ID");
    return { root: matches[0]! };
  }

  private assertExpected(expected: Record<string, string | null>, current: Record<string, string>): void {
    for (const [path, revision] of Object.entries(expected)) {
      const currentRevision = current[path] ?? null;
      if (revision !== currentRevision) throw new ApiError(409, "toon_factory_revision_conflict", "Toon workspace content changed since it was loaded", { path, expectedRevision: revision, currentRevision });
    }
  }

  private assertCompleteExpected(
    writes: Array<{ path: string; content: string | Uint8Array | null }>,
    expected: Record<string, string | null>,
    current: Record<string, string>,
  ): void {
    const missing = writes
      .map((write) => write.path)
      .filter((path) => !path.startsWith(".toon-history/") && !Object.prototype.hasOwnProperty.call(expected, path));
    if (missing.length) throw new ApiError(400, "toon_expected_revision_required", "Every mutated portable path requires an expected revision", { paths: [...new Set(missing)].sort() });
    for (const path of Object.keys(expected)) {
      if (expected[path] === null && current[path] !== undefined) throw new ApiError(409, "toon_factory_revision_conflict", "A create destination is already occupied", { path, expectedRevision: null, currentRevision: current[path] });
    }
  }

  private async applyCommand(loaded: Awaited<ReturnType<ToonWorkspaceCoordinator["load"]>>, command: ToonWorkspaceCommand): Promise<Array<{ path: string; content: string | Uint8Array | null; rootLast?: boolean }>> {
    const { bundle } = loaded;
    const now = new Date().toISOString();
    let project = bundle.project;
    let canvases = bundle.canvases;
    let documents = bundle.documents;
    let assets = bundle.assets;
    const writes = new Map<string, { path: string; content: string | Uint8Array | null; rootLast?: boolean }>();
    const changed = new Map<string, ToonPortableReference>();
    const write = (path: string, value: unknown, rootLast = false) => writes.set(path, { path, content: value === null ? null : typeof value === "string" || value instanceof Uint8Array ? value : json(value), ...(rootLast ? { rootLast: true } : {}) });
    const markChanged = (reference: ToonPortableReference) => changed.set(dependencyKey(reference), reference);
    const touchProject = () => {
      project = { ...project, metadata: { ...project.metadata, updatedAt: now }, ...(project.migration ? { migration: { ...project.migration, v2EditedAt: project.migration.v2EditedAt ?? now } } : {}) };
      write(PROJECT_FILE, project, true);
    };
    const requireCanvas = (id: string) => {
      const item = canvases.canvases.find((candidate) => candidate.id === id);
      if (!item) throw new ApiError(404, "toon_canvas_not_found", "Toon canvas not found");
      return item;
    };
    const requireFolder = (id: string) => {
      const item = canvases.folders.find((candidate) => candidate.id === id);
      if (!item) throw new ApiError(404, "toon_canvas_folder_not_found", "Toon canvas folder not found");
      return item;
    };
    const requireDocument = (id: string) => {
      const item = documents.documents.find((candidate) => candidate.id === id);
      if (!item) throw new ApiError(404, "toon_document_not_found", "Toon document not found");
      return item;
    };
    const requireAsset = (id: string) => {
      const item = assets.assets.find((candidate) => candidate.id === id);
      if (!item) throw new ApiError(404, "toon_asset_not_found", "Toon asset not found");
      return item;
    };

    switch (command.kind) {
      case "project.update":
        project = { ...project, metadata: { ...project.metadata, ...(command.name ? { name: command.name } : {}), updatedAt: now }, ...(command.activeCanvasId ? { activeCanvasId: command.activeCanvasId } : {}), ...(command.modelDefaults ? { modelDefaults: command.modelDefaults } : {}) };
        write(PROJECT_FILE, project, true);
        break;
      case "folder.create":
        if (canvases.folders.some((item) => item.id === command.folder.id)) throw new ApiError(409, "toon_duplicate_id", "Canvas folder ID already exists");
        canvases = { ...canvases, folders: [...canvases.folders, command.folder] }; write(CATALOG_PATHS.canvases, canvases); touchProject(); break;
      case "folder.rename":
        requireFolder(command.folderId); canvases = { ...canvases, folders: canvases.folders.map((item) => item.id === command.folderId ? { ...item, title: command.title } : item) }; write(CATALOG_PATHS.canvases, canvases); touchProject(); break;
      case "folder.reorder": {
        const known = new Set(canvases.folders.map((item) => item.id));
        if (new Set(command.folderIds).size !== known.size || command.folderIds.some((id) => !known.has(id))) throw new ApiError(409, "toon_invalid_reorder", "Folder reorder must contain every folder exactly once");
        canvases = { ...canvases, folders: command.folderIds.map((id, order) => ({ ...requireFolder(id), order })) }; write(CATALOG_PATHS.canvases, canvases); touchProject(); break;
      }
      case "folder.delete": {
        requireFolder(command.folderId);
        const children = canvases.canvases.filter((item) => item.folderId === command.folderId && item.state === "active");
        if (children.length && !command.recursive) throw new ApiError(409, "toon_folder_not_empty", "Canvas folder contains active canvases", { affected: children.map((item) => item.id) });
        canvases = { ...canvases, folders: canvases.folders.map((item) => item.id === command.folderId ? { ...item, state: "trashed" as const } : item), canvases: canvases.canvases.map((item) => command.recursive && item.folderId === command.folderId ? { ...item, state: "trashed" as const } : item) };
        write(CATALOG_PATHS.canvases, canvases); touchProject(); break;
      }
      case "folder.restore":
        requireFolder(command.folderId); canvases = { ...canvases, folders: canvases.folders.map((item) => item.id === command.folderId ? { ...item, state: "active" as const } : item) }; write(CATALOG_PATHS.canvases, canvases); touchProject(); break;
      case "canvas.create": {
        if (canvases.canvases.some((item) => item.id === command.canvas.id || item.file === command.canvas.file)) throw new ApiError(409, "toon_duplicate_path", "Canvas ID or path already exists");
        if (command.body.id !== command.canvas.id) throw new ApiError(400, "toon_canvas_id_mismatch", "Canvas ID cannot differ from its body");
        if (command.canvas.folderId) requireFolder(command.canvas.folderId);
        const content = json(command.body);
        canvases = { ...canvases, canvases: [...canvases.canvases, { ...command.canvas, revision: sha256(content) }] };
        write(command.canvas.file, content); write(CATALOG_PATHS.canvases, canvases); touchProject(); break;
      }
      case "canvas.rename":
        requireCanvas(command.canvasId); canvases = { ...canvases, canvases: canvases.canvases.map((item) => item.id === command.canvasId ? { ...item, title: command.title } : item) }; write(CATALOG_PATHS.canvases, canvases); touchProject(); break;
      case "canvas.reorder": {
        if (command.folderId) requireFolder(command.folderId);
        const inFolder = canvases.canvases.filter((item) => (item.folderId ?? null) === (command.folderId ?? null) && item.state === "active");
        const known = new Set(inFolder.map((item) => item.id));
        if (new Set(command.canvasIds).size !== known.size || command.canvasIds.some((id) => !known.has(id))) throw new ApiError(409, "toon_invalid_reorder", "Canvas reorder must contain every active canvas in the folder exactly once");
        const order = new Map(command.canvasIds.map((id, index) => [id, index]));
        canvases = { ...canvases, canvases: canvases.canvases.map((item) => order.has(item.id) ? { ...item, order: order.get(item.id)! } : item) };
        write(CATALOG_PATHS.canvases, canvases); touchProject(); break;
      }
      case "canvas.move":
        requireCanvas(command.canvasId); if (command.folderId) requireFolder(command.folderId);
        canvases = { ...canvases, canvases: canvases.canvases.map((item) => item.id === command.canvasId ? { ...item, ...(command.folderId ? { folderId: command.folderId } : { folderId: undefined }), order: command.order } : item) };
        write(CATALOG_PATHS.canvases, canvases); touchProject(); break;
      case "canvas.duplicate": {
        const source = requireCanvas(command.canvasId);
        if (canvases.canvases.some((item) => item.id === command.newCanvasId)) throw new ApiError(409, "toon_duplicate_id", "Canvas ID already exists");
        const body = bundle.canvasFiles[source.file];
        const usedSpatialIds = new Set(Object.values(bundle.canvasFiles).flatMap((canvas) => [...canvas.nodes.map((node) => node.id), ...(canvas.groups ?? []).map((group) => group.id)]));
        const freshSpatialId = (candidate: string) => {
          let value = candidate.slice(0, 128); let suffix = 1;
          while (usedSpatialIds.has(value)) value = `${candidate.slice(0, Math.max(1, 126 - String(suffix).length))}-${suffix++}`;
          usedSpatialIds.add(value); return value;
        };
        const nodeIds = new Map(body.nodes.map((node, index) => [node.id, freshSpatialId(`${command.newCanvasId}-node-${index + 1}`)]));
        const groupIds = new Map((body.groups ?? []).map((group, index) => [group.id, freshSpatialId(`${command.newCanvasId}-group-${index + 1}`)]));
        const handleIds = new Map<string, string>();
        const nodes = body.nodes.map((node) => ({
          ...node,
          id: nodeIds.get(node.id)!,
          ...(node.parentGroupId ? { parentGroupId: groupIds.get(node.parentGroupId)! } : {}),
          handles: node.handles.map((handle, index) => {
            const id = `${nodeIds.get(node.id)}-handle-${index + 1}`.slice(0, 128);
            handleIds.set(`${node.id}\0${handle.id}`, id);
            return { ...handle, id };
          }),
        }));
        const groups = (body.groups ?? []).map((group) => ({ ...group, id: groupIds.get(group.id)!, ...(group.parentGroupId ? { parentGroupId: groupIds.get(group.parentGroupId)! } : {}) }));
        const edges = body.edges.map((edge, index) => ({
          ...edge, id: `${command.newCanvasId}-edge-${index + 1}`.slice(0, 128),
          sourceNodeId: nodeIds.get(edge.sourceNodeId)!, targetNodeId: nodeIds.get(edge.targetNodeId)!,
          sourceHandleId: handleIds.get(`${edge.sourceNodeId}\0${edge.sourceHandleId}`)!,
          targetHandleId: handleIds.get(`${edge.targetNodeId}\0${edge.targetHandleId}`)!,
        }));
        const duplicate = { ...body, id: command.newCanvasId, nodes, edges, ...(groups.length ? { groups } : { groups: undefined }) };
        const path = `canvases/${command.newCanvasId}.json`;
        const content = json(duplicate);
        canvases = { ...canvases, canvases: [...canvases.canvases, { ...source, id: command.newCanvasId, title: command.title, file: path, revision: sha256(content), order: canvases.canvases.length, state: "active" }] };
        write(path, content); write(CATALOG_PATHS.canvases, canvases); touchProject(); break;
      }
      case "canvas.delete":
      case "canvas.restore": {
        requireCanvas(command.canvasId);
        const state = command.kind === "canvas.delete" ? "trashed" as const : "active" as const;
        canvases = { ...canvases, canvases: canvases.canvases.map((item) => item.id === command.canvasId ? { ...item, state } : item) };
        if (command.kind === "canvas.delete" && project.activeCanvasId === command.canvasId) project = { ...project, activeCanvasId: undefined };
        write(CATALOG_PATHS.canvases, canvases); touchProject(); break;
      }
      case "canvas.write": {
        const descriptor = requireCanvas(command.canvasId);
        if (command.body.id !== command.canvasId) throw new ApiError(400, "toon_canvas_id_mismatch", "Canvas ID cannot differ from its body");
        const previous = bundle.canvasFiles[descriptor.file]!;
        const content = json(command.body);
        canvases = { ...canvases, canvases: canvases.canvases.map((item) => item.id === command.canvasId ? { ...item, revision: sha256(content) } : item) };
        if (canonical(previous) !== canonical(command.body)) markChanged({ kind: "canvas", id: command.canvasId, revision: sha256(content) });
        const priorNodes = new Map(previous.nodes.map((node) => [node.id, node]));
        for (const node of command.body.nodes) {
          if (canonical(priorNodes.get(node.id)) !== canonical(node)) markChanged({ kind: "node", id: node.id, revision: entityRevision(node) });
          priorNodes.delete(node.id);
        }
        for (const nodeId of priorNodes.keys()) markChanged({ kind: "node", id: nodeId, revision: sha256("deleted") });
        const priorAssetNodes = new Set(previous.nodes.filter((node) => node.config.asset).map((node) => node.id));
        const nextAssetNodes = new Map(command.body.nodes.filter((node) => node.config.asset).map((node) => [node.id, node.config.asset!.id]));
        assets = { ...assets, assets: assets.assets.map((asset) => {
          const references = asset.references.filter((ref) => !(ref.kind === "node" && priorAssetNodes.has(ref.id)));
          for (const [nodeId, assetId] of nextAssetNodes) if (assetId === asset.id && !references.some((ref) => ref.kind === "node" && ref.id === nodeId)) references.push({ kind: "node", id: nodeId });
          return references.length === asset.references.length && references.every((ref, index) => ref === asset.references[index]) ? asset : { ...asset, references, updatedAt: now };
        }) };
        write(descriptor.file, content); write(CATALOG_PATHS.canvases, canvases); if (assets.assets.some((asset, index) => asset !== bundle.assets.assets[index])) write(CATALOG_PATHS.assets, assets); touchProject(); break;
      }
      case "document.create": {
        assertDocumentPath(command.document.path);
        if (documents.documents.some((item) => item.id === command.document.id || item.path === command.document.path)) throw new ApiError(409, "toon_duplicate_path", "Document ID or path already exists");
        const revision = sha256(command.content);
        documents = { ...documents, documents: [...documents.documents, { ...command.document, revision, updatedAt: now }] };
        const revisionId = `revision-${command.operationId}`.slice(0, 128);
        const revisionPath = `.toon-history/documents/${command.document.id}/${revisionId}.txt`;
        const history = toonDocumentRevisionSchema.parse({ id: revisionId, documentId: command.document.id, revision, path: revisionPath, origin: command.origin, actor: command.actor, createdAt: now });
        write(command.document.path, command.content); write(revisionPath, command.content); write(`.toon-history/documents/${command.document.id}/index.json`, [history]); write(CATALOG_PATHS.documents, documents); touchProject(); break;
      }
      case "document.write": {
        const descriptor = requireDocument(command.documentId);
        assertDocumentPath(descriptor.path);
        if (!["markdown", "text"].includes(descriptor.kind)) throw new ApiError(415, "toon_document_read_only", "This document format is preview-only");
        const historyPath = `.toon-history/documents/${command.documentId}/index.json`;
        const history = await this.readDocumentRevisions(loaded.root, command.documentId);
        if (history.revision) loaded.revisions[historyPath] = history.revision;
        const revision = sha256(command.content);
        const revisionId = `revision-${command.operationId}`.slice(0, 128);
        const revisionPath = `.toon-history/documents/${command.documentId}/${revisionId}.txt`;
        const savedRevision: ToonDocumentRevision = toonDocumentRevisionSchema.parse({ id: revisionId, documentId: command.documentId, revision, path: revisionPath, origin: command.origin, actor: command.actor, createdAt: now });
        documents = { ...documents, documents: documents.documents.map((item) => item.id === command.documentId ? { ...item, revision, updatedAt: now } : item) };
        markChanged({ kind: "document", id: command.documentId, revision });
        write(descriptor.path, command.content); write(revisionPath, command.content); write(historyPath, [...history.response.items.filter((item) => item.id !== revisionId), savedRevision]); write(CATALOG_PATHS.documents, documents); touchProject(); break;
      }
      case "document.rename": {
        const descriptor = requireDocument(command.documentId);
        const path = command.path ?? descriptor.path;
        assertDocumentPath(path);
        if (documents.documents.some((item) => item.id !== command.documentId && item.path === path)) throw new ApiError(409, "toon_duplicate_path", "Document path already exists");
        if (path !== descriptor.path) {
          const bytes = await readSafeFile(loaded.root, descriptor.path, MAX_TEXT_BYTES);
          if (!bytes) throw new ApiError(404, "toon_document_not_found", "Toon document not found");
          write(path, bytes.toString("utf8"));
          write(descriptor.path, null);
        }
        documents = { ...documents, documents: documents.documents.map((item) => item.id === command.documentId ? { ...item, title: command.title, path, updatedAt: now } : item) };
        write(CATALOG_PATHS.documents, documents); touchProject(); break;
      }
      case "document.copy": {
        const descriptor = requireDocument(command.documentId);
        assertDocumentPath(command.path);
        if (documents.documents.some((item) => item.id === command.newDocumentId || item.path === command.path)) throw new ApiError(409, "toon_duplicate_path", "Document ID or path already exists");
        const bytes = await readSafeFile(loaded.root, descriptor.path, MAX_TEXT_BYTES);
        if (!bytes) throw new ApiError(404, "toon_document_not_found", "Toon document not found");
        documents = { ...documents, documents: [...documents.documents, { ...descriptor, id: command.newDocumentId, title: command.title, path: command.path, updatedAt: now }] };
        write(command.path, bytes); write(CATALOG_PATHS.documents, documents); touchProject(); break;
      }
      case "document.delete":
      case "document.restore": {
        requireDocument(command.documentId); const state = command.kind === "document.delete" ? "trashed" as const : "active" as const;
        documents = { ...documents, documents: documents.documents.map((item) => item.id === command.documentId ? { ...item, state, updatedAt: now } : item) };
        write(CATALOG_PATHS.documents, documents); touchProject(); break;
      }
      case "document.folder.create": {
        assertDocumentPath(`${command.folder.path}/placeholder.txt`);
        if ((documents.folders ?? []).some((item) => item.id === command.folder.id || item.path === command.folder.path)) throw new ApiError(409, "toon_duplicate_path", "Document folder ID or path already exists");
        documents = { ...documents, folders: [...(documents.folders ?? []), command.folder] }; write(CATALOG_PATHS.documents, documents); touchProject(); break;
      }
      case "document.folder.rename": {
        const folder = (documents.folders ?? []).find((item) => item.id === command.folderId);
        if (!folder) throw new ApiError(404, "toon_document_folder_not_found", "Document folder not found");
        assertDocumentPath(`${command.path}/placeholder.txt`);
        if ((documents.folders ?? []).some((item) => item.id !== command.folderId && item.path === command.path)) throw new ApiError(409, "toon_duplicate_path", "Document folder path already exists");
        const children = documents.documents.filter((item) => item.path.startsWith(`${folder.path}/`));
        for (const child of children) {
          const nextPath = `${command.path}${child.path.slice(folder.path.length)}`;
          const bytes = await readSafeFile(loaded.root, child.path, MAX_TEXT_BYTES);
          if (!bytes) throw new ApiError(404, "toon_document_not_found", "A document in this folder is missing");
          write(nextPath, bytes); write(child.path, null);
        }
        documents = { ...documents, folders: (documents.folders ?? []).map((item) => item.id === command.folderId ? { ...item, title: command.title, path: command.path } : item), documents: documents.documents.map((item) => item.path.startsWith(`${folder.path}/`) ? { ...item, path: `${command.path}${item.path.slice(folder.path.length)}`, updatedAt: now } : item) };
        write(CATALOG_PATHS.documents, documents); touchProject(); break;
      }
      case "document.folder.delete": {
        const folder = (documents.folders ?? []).find((item) => item.id === command.folderId);
        if (!folder) throw new ApiError(404, "toon_document_folder_not_found", "Document folder not found");
        const children = documents.documents.filter((item) => item.path.startsWith(`${folder.path}/`) && item.state === "active");
        if (children.length && !command.recursive) throw new ApiError(409, "toon_folder_not_empty", "Document folder contains active documents", { affected: children.map((item) => item.id) });
        documents = { ...documents, folders: (documents.folders ?? []).map((item) => item.id === command.folderId ? { ...item, state: "trashed" as const } : item), documents: documents.documents.map((item) => command.recursive && item.path.startsWith(`${folder.path}/`) ? { ...item, state: "trashed" as const, updatedAt: now } : item) };
        write(CATALOG_PATHS.documents, documents); touchProject(); break;
      }
      case "document.folder.restore": {
        if (!(documents.folders ?? []).some((item) => item.id === command.folderId)) throw new ApiError(404, "toon_document_folder_not_found", "Document folder not found");
        documents = { ...documents, folders: (documents.folders ?? []).map((item) => item.id === command.folderId ? { ...item, state: "active" as const } : item) };
        write(CATALOG_PATHS.documents, documents); touchProject(); break;
      }
      case "asset.register": {
        if (assets.assets.some((item) => item.id === command.asset.id || item.path === command.asset.path)) throw new ApiError(409, "toon_duplicate_path", "Asset ID or path already exists");
        const bytes = Buffer.from(command.contentBase64, "base64");
        if (bytes.toString("base64") !== command.contentBase64.replace(/\s/g, "")) throw new ApiError(400, "toon_asset_content_invalid", "Asset content must be canonical base64");
        const inspected = inspectAssetBytes(bytes, basename(command.asset.path), command.asset.mimeType);
        if (bytes.byteLength !== command.asset.bytes || sha256(bytes) !== command.asset.checksum) throw new ApiError(409, "toon_asset_integrity_mismatch", "Asset size or checksum does not match the catalog request");
        const asset = { ...command.asset, mimeType: inspected.mimeType, ...(inspected.width ? { width: inspected.width } : {}), ...(inspected.height ? { height: inspected.height } : {}), ...(inspected.durationSeconds ? { durationSeconds: inspected.durationSeconds } : {}) };
        assets = { ...assets, assets: [...assets.assets, asset] }; write(asset.path, bytes); write(CATALOG_PATHS.assets, assets); touchProject(); break;
      }
      case "asset.import": {
        const filename = normalizeAssetFilename(command.filename);
        const bytes = Buffer.from(command.contentBase64, "base64");
        if (bytes.toString("base64") !== command.contentBase64.replace(/\s/g, "")) throw new ApiError(400, "toon_asset_content_invalid", "Asset content must be canonical base64");
        const inspected = inspectAssetBytes(bytes, filename, command.declaredMimeType);
        const checksum = assetChecksum(bytes);
        const duplicate = assets.assets.find((item) => item.checksum === checksum && item.bytes === bytes.byteLength && item.state !== "tombstone");
        if (!duplicate && assets.assets.some((item) => item.id === command.assetId)) throw new ApiError(409, "toon_duplicate_id", "Asset ID already exists");
        const stem = filename.slice(0, Math.max(1, filename.length - extname(filename).length)).replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) || "asset";
        const proposedPath = `assets/imported/${stem}-${checksum.slice(0, 12)}${inspected.extension}`;
        if (!duplicate && assets.assets.some((item) => item.path === proposedPath)) throw new ApiError(409, "toon_duplicate_path", "Asset path already exists with different content");
        const asset: ToonAssetDescriptor = duplicate ?? {
          id: command.assetId, title: filename, path: proposedPath, mimeType: inspected.mimeType, bytes: bytes.byteLength, checksum,
          ...(inspected.width ? { width: inspected.width } : {}), ...(inspected.height ? { height: inspected.height } : {}), ...(inspected.durationSeconds ? { durationSeconds: inspected.durationSeconds } : {}),
          origin: command.assetOrigin, state: "active", references: [], createdAt: now, updatedAt: now,
        };
        if (!duplicate) {
          assets = { ...assets, assets: [...assets.assets, asset] }; write(asset.path, bytes);
        } else if (duplicate.state === "trashed") {
          if (!duplicate.trashPath) throw new ApiError(409, "toon_asset_integrity_mismatch", "Trashed duplicate asset content is unavailable");
          const trashed = await readSafeFile(loaded.root, duplicate.trashPath, Number.MAX_SAFE_INTEGER);
          if (!trashed || sha256(trashed) !== duplicate.checksum) throw new ApiError(409, "toon_asset_integrity_mismatch", "Trashed duplicate asset content is unavailable or invalid");
          write(duplicate.path, trashed); write(duplicate.trashPath, null);
          assets = { ...assets, assets: assets.assets.map((item) => item.id === duplicate.id ? { ...item, state: "active" as const, trashPath: undefined, trashedAt: undefined, updatedAt: now } : item) };
        }
        let nodeId: string | undefined;
        if (command.canvas) {
          const descriptor = requireCanvas(command.canvas.id);
          const canvas = bundle.canvasFiles[descriptor.file]!;
          nodeId = `${command.assetId}-node`.slice(0, 128);
          if (canvas.nodes.some((item) => item.id === nodeId)) throw new ApiError(409, "toon_duplicate_id", "Imported asset node ID already exists");
          const node = compatibleAssetNode(asset, nodeId, command.canvas.position);
          const nextCanvas = { ...canvas, nodes: [...canvas.nodes, node] };
          const content = json(nextCanvas);
          canvases = { ...canvases, canvases: canvases.canvases.map((item) => item.id === descriptor.id ? { ...item, revision: sha256(content) } : item) };
          assets = { ...assets, assets: assets.assets.map((item) => item.id === asset.id ? { ...item, state: "active" as const, trashPath: undefined, trashedAt: undefined, references: [...item.references.filter((ref) => !(ref.kind === "node" && ref.id === nodeId)), { kind: "node" as const, id: nodeId! }], updatedAt: now } : item) };
          write(descriptor.file, content); write(CATALOG_PATHS.canvases, canvases);
        }
        write(CATALOG_PATHS.assets, assets); touchProject();
        const result: ToonAssetImportResult = { asset: assets.assets.find((item) => item.id === asset.id)!, reused: Boolean(duplicate), ...(nodeId ? { nodeId } : {}) };
        break;
      }
      case "asset.update": {
        requireAsset(command.assetId);
        assets = { ...assets, assets: assets.assets.map((item) => item.id === command.assetId ? { ...item, ...(command.title ? { title: command.title } : {}), ...(command.references ? { references: command.references } : {}), updatedAt: now } : item) };
        markChanged({ kind: "asset", id: command.assetId, revision: entityRevision(requireAsset(command.assetId)) });
        write(CATALOG_PATHS.assets, assets); touchProject(); break;
      }
      case "asset.delete": {
        const asset = requireAsset(command.assetId);
        const impacts = await this.assetReferenceImpacts(loaded, asset.id);
        if (impacts.length && !command.replacementAssetId && !command.destructive) throw new ApiError(409, "toon_asset_referenced", "Referenced assets require a replacement or explicit destructive confirmation", { affected: impacts });
        if (command.replacementAssetId) {
          const replacement = requireAsset(command.replacementAssetId);
          if (replacement.id === asset.id || replacement.state !== "active" || replacement.mimeType.split("/")[0] !== asset.mimeType.split("/")[0]) throw new ApiError(409, "toon_asset_replacement_incompatible", "Replacement asset must be an active compatible asset");
          if (impacts.some((impact) => impact.source !== "canvas" && !(impact.source === "catalog" && impact.id.startsWith("node:")))) throw new ApiError(409, "toon_asset_replacement_unsupported", "Historical and non-canvas references cannot be rewritten; use explicit destructive confirmation instead", { affected: impacts });
          const replacedNodeIds = new Set<string>();
          for (const descriptor of canvases.canvases) {
            const canvas = bundle.canvasFiles[descriptor.file]!;
            if (!canvas.nodes.some((node) => node.config.asset?.id === asset.id)) continue;
            const next = { ...canvas, nodes: canvas.nodes.map((node) => {
              if (node.config.asset?.id !== asset.id) return node;
              replacedNodeIds.add(node.id);
              return { ...node, config: { ...node.config, asset: { kind: "asset" as const, id: replacement.id, revision: replacement.checksum } } };
            }) };
            const content = json(next); write(descriptor.file, content);
            canvases = { ...canvases, canvases: canvases.canvases.map((item) => item.id === descriptor.id ? { ...item, revision: sha256(content) } : item) };
          }
          assets = { ...assets, assets: assets.assets.map((item) => item.id === asset.id
            ? { ...item, references: item.references.filter((ref) => !(ref.kind === "node" && replacedNodeIds.has(ref.id))), updatedAt: now }
            : item.id === replacement.id
              ? { ...item, references: [...item.references, ...[...replacedNodeIds].filter((nodeId) => !item.references.some((ref) => ref.kind === "node" && ref.id === nodeId)).map((id) => ({ kind: "node" as const, id }))], updatedAt: now }
              : item) };
          write(CATALOG_PATHS.canvases, canvases);
        }
        const source = await readSafeFile(loaded.root, asset.path, Number.MAX_SAFE_INTEGER);
        const trashPath = `.toon-trash/assets/${asset.id}/${basename(asset.path)}`;
        if (source) { write(trashPath, source); write(asset.path, null); }
        assets = { ...assets, assets: assets.assets.map((item) => item.id === command.assetId ? { ...item, state: "trashed" as const, trashPath, trashedAt: now, updatedAt: now } : item) };
        write(CATALOG_PATHS.assets, assets); touchProject(); break;
      }
      case "asset.restore": {
        const asset = requireAsset(command.assetId);
        if (asset.state === "tombstone" || !asset.trashPath) throw new ApiError(409, "toon_asset_not_restorable", "Asset content is no longer recoverable");
        const bytes = await readSafeFile(loaded.root, asset.trashPath, Number.MAX_SAFE_INTEGER);
        if (!bytes || sha256(bytes) !== asset.checksum) throw new ApiError(409, "toon_asset_integrity_mismatch", "Trashed asset content is unavailable or invalid");
        if (await readSafeFile(loaded.root, asset.path, Number.MAX_SAFE_INTEGER)) throw new ApiError(409, "toon_duplicate_path", "The original asset path is occupied");
        write(asset.path, bytes); write(asset.trashPath, null);
        assets = { ...assets, assets: assets.assets.map((item) => item.id === command.assetId ? { ...item, state: "active" as const, trashPath: undefined, trashedAt: undefined, updatedAt: now } : item) };
        write(CATALOG_PATHS.assets, assets); touchProject(); break;
      }
      case "asset.cleanup": {
        let cleaned = 0;
        const next = [] as ToonAssetCatalog["assets"];
        for (const asset of assets.assets) {
          if (cleaned >= command.limit || asset.state !== "trashed" || !asset.trashedAt || asset.trashedAt >= command.before) { next.push(asset); continue; }
          const impacts = await this.assetReferenceImpacts(loaded, asset.id);
          if (impacts.length) { next.push(asset); continue; }
          if (asset.trashPath) write(asset.trashPath, null);
          next.push({ ...asset, state: "tombstone", trashPath: undefined, tombstonedAt: now, updatedAt: now });
          cleaned += 1;
        }
        assets = { ...assets, assets: next }; write(CATALOG_PATHS.assets, assets); touchProject(); break;
      }
      case "content.write":
        write(command.path, command.content); touchProject(); break;
      case "generation.prepare": {
        const existingRequest = project.workflow.generations.find((item) => item.requestId === command.generation.requestId);
        if (existingRequest) {
          if (existingRequest.requestHash !== command.generation.requestHash) throw new ApiError(409, "toon_media_request_id_conflict", "The request ID is already used for a different generation plan");
          break;
        }
        if (project.workflow.generations.some((item) => item.id === command.generation.id)) throw new ApiError(409, "toon_duplicate_id", "Generation ID already exists");
        const episode = project.workflow.episodes.find((item) => item.id === command.generation.episodeId && item.canvasId === command.generation.canvasId);
        const step = episode?.steps?.find((item) => item.id === command.generation.workflowRecordId);
        const descriptor = requireCanvas(command.generation.canvasId);
        const canvas = bundle.canvasFiles[descriptor.file]!;
        const node = canvas.nodes.find((item) => item.id === command.generation.nodeId);
        if (!episode || !step || !node || node.kind !== `${command.generation.plan.kind}-generation`) throw new ApiError(409, "workflow_prerequisite_incomplete", "The generation workflow target is unavailable");
        this.assertWorkflowStepCurrent(loaded.bundle, episode, step);
        const canonicalTarget = command.generation.plan.kind === "image" ? "image-candidates" : "video-clips";
        if (step.id !== canonicalTarget || step.status === "skipped") throw new ApiError(409, "workflow_prerequisite_incomplete", "Generation must target the available canonical media step");
        this.assertDependencyLinks(loaded.bundle, command.dependencyLinks);
        this.assertCompleteDependencyClosure(command.dependencyLinks, this.generationDependencyReferences(loaded.bundle, episode, step, [
          { kind: "canvas", id: command.generation.canvasId }, { kind: "node", id: command.generation.nodeId }, ...command.generation.plan.references,
        ]));
        const generationRevision = command.generation.requestHash;
        const generation: ToonWorkspaceGenerationRecord = {
          ...command.generation,
          status: "awaiting-human-authorization",
          dependencyLinks: command.dependencyLinks,
          revision: generationRevision,
          candidates: [],
          createdAt: now,
          updatedAt: now,
        };
        project = { ...project, workflow: { ...project.workflow, generations: [...project.workflow.generations, generation] } };
        touchProject();
        break;
      }
      case "generation.project": {
        const generation = project.workflow.generations.find((item) => item.id === command.generationId);
        if (!generation) throw new ApiError(404, "toon_generation_not_found", "Toon generation record not found");
        if (["queued", "submitting", "running", "awaiting-review", "adopted", "submission_unknown"].includes(command.status)
          && (!generation.authorization || generation.authorization.scopeHash !== generation.requestHash || generation.authorization.invalidatedAt)) {
          throw new ApiError(409, "toon_compute_authorization_scope_changed", "The exact generation plan is not authorized");
        }
        const projectedCandidates: ToonWorkspaceGenerationRecord["candidates"] = [];
        for (const candidate of command.candidates) {
          let asset = candidate.artifact ? assets.assets.find((item) => item.id === `asset-${candidate.id}`) : undefined;
          if (candidate.artifact && !asset) {
            const sourceRoot = candidate.artifact.scope === "project" ? loaded.root : this.workspaceRoot;
            const bytes = await readSafeFile(sourceRoot, candidate.artifact.path, Number.MAX_SAFE_INTEGER);
            if (!bytes) throw new ApiError(404, "toon_media_artifact_missing", "The generated artifact is unavailable");
            const suffix = extname(basename(candidate.artifact.path)).toLowerCase() || (candidate.artifact.mimeType === "image/png" ? ".png" : candidate.artifact.mimeType === "video/mp4" ? ".mp4" : ".bin");
            const checksum = sha256(bytes);
            asset = assets.assets.find((item) => item.checksum === checksum && item.bytes === bytes.byteLength && item.state !== "tombstone");
            if (asset) {
              asset = { ...asset, references: [...asset.references.filter((ref) => !(ref.kind === "generation" && ref.id === generation.id)), { kind: "generation", id: generation.id, revision: generation.revision }, { kind: "node", id: generation.nodeId }, { kind: "workflow", id: generation.workflowRecordId }], updatedAt: candidate.updatedAt };
              assets = { ...assets, assets: assets.assets.map((item) => item.id === asset!.id ? asset! : item) };
            } else {
              const inspected = inspectAssetBytes(bytes, `${candidate.id}${suffix}`, candidate.artifact.mimeType);
              const path = `assets/generated/${generation.id}/${candidate.id}${suffix}`;
              asset = {
                id: `asset-${candidate.id}`, title: `${generation.plan.object} ${candidate.ordinal}`, path,
                mimeType: inspected.mimeType, bytes: bytes.byteLength, checksum, origin: "generated", state: "active",
                ...(inspected.width ? { width: inspected.width } : {}), ...(inspected.height ? { height: inspected.height } : {}), ...(inspected.durationSeconds ? { durationSeconds: inspected.durationSeconds } : {}),
                references: [{ kind: "generation", id: generation.id, revision: generation.revision }, { kind: "node", id: generation.nodeId }, { kind: "workflow", id: generation.workflowRecordId }],
                createdAt: candidate.createdAt, updatedAt: candidate.updatedAt,
              };
              assets = { ...assets, assets: [...assets.assets, asset] };
              write(path, bytes);
            }
          }
          projectedCandidates.push({
            id: candidate.id, ordinal: candidate.ordinal, status: candidate.status,
            ...(candidate.progress !== undefined ? { progress: candidate.progress } : {}),
            ...(asset ? { assetId: asset.id, mimeType: asset.mimeType, bytes: asset.bytes, checksum: asset.checksum } : {}),
            ...(candidate.error ? { error: candidate.error } : {}), createdAt: candidate.createdAt, updatedAt: candidate.updatedAt,
          });
        }
        const revision = entityRevision({ status: command.status, candidates: projectedCandidates });
        project = { ...project, workflow: { ...project.workflow, generations: project.workflow.generations.map((item) => item.id === generation.id ? { ...item, status: command.status, candidates: projectedCandidates, revision, updatedAt: now } : item) } };
        if (assets !== bundle.assets) write(CATALOG_PATHS.assets, assets);
        markChanged({ kind: "generation", id: generation.id, revision });
        touchProject();
        break;
      }
      case "workflow.approve": {
        this.requireHumanTransition(command);
        this.assertDependencyLinks(loaded.bundle, command.dependencyLinks);
        const found = this.requireWorkflowStep(project, command.episodeId, command.workflowRecordId);
        this.assertWorkflowStepAvailable(found.episode, found.step);
        if (["image-candidates", "video-clips", "adopt-clips", "delivery-manifest"].includes(found.step.id)) throw new ApiError(409, "toon_protected_transition_required", "This workflow step requires its dedicated generation, adoption, or delivery action");
        if (!command.dependencyLinks.some((link) => link.revision === command.outputRevision)) throw new ApiError(409, "workflow_output_evidence_required", "Content approval requires current portable output evidence");
        const hasOutput = command.dependencyLinks.some((link) => {
          if (link.target.kind === "node" || link.target.kind === "document" || link.target.kind === "asset") return true;
          if (link.target.kind !== "canvas") return false;
          const descriptor = bundle.canvases.canvases.find((canvas) => canvas.id === link.target.id);
          return Boolean(descriptor && bundle.canvasFiles[descriptor.file]?.nodes.length);
        });
        if (!hasOutput) throw new ApiError(409, "workflow_output_evidence_required", "Content approval requires a current node, document, or asset output");
        const approval = { id: `approval-${command.operationId}`.slice(0, 128), outputRevision: command.outputRevision, approvedAt: now };
        const nextStep = { ...found.step, status: "approved" as const, outputRevision: command.outputRevision, dependencyLinks: command.dependencyLinks, contentApprovals: [...found.step.contentApprovals, approval], staleReason: undefined, updatedAt: now };
        project = this.replaceWorkflowStep(project, found.episode.id, nextStep); touchProject(); break;
      }
      case "workflow.configure":
        project = { ...project, workflow: { ...project.workflow, episodes: command.episodes } }; touchProject(); break;
      case "workflow.skip": {
        this.requireHumanTransition(command);
        const found = this.requireWorkflowStep(project, command.episodeId, command.workflowRecordId);
        this.assertWorkflowStepAvailable(found.episode, found.step);
        project = this.replaceWorkflowStep(project, found.episode.id, { ...found.step, status: "skipped", skipReason: command.reason, staleReason: undefined, updatedAt: now }); touchProject(); break;
      }
      case "workflow.authorize": {
        this.requireHumanTransition(command);
        const generation = project.workflow.generations.find((item) => item.id === command.generationId);
        if (!generation) throw new ApiError(404, "toon_generation_not_found", "Toon generation record not found");
        if (generation.episodeId !== command.episodeId || generation.workflowRecordId !== command.workflowRecordId) throw new ApiError(409, "toon_workflow_scope_changed", "Generation workflow scope changed before authorization");
        if (command.authorization.scopeHash !== generation.requestHash) throw new ApiError(409, "toon_compute_authorization_scope_changed", "The generation plan changed after compute authorization");
        const current = this.requireWorkflowStep(project, command.episodeId, command.workflowRecordId);
        this.assertWorkflowStepCurrent(loaded.bundle, current.episode, current.step);
        this.assertDependencyLinks(loaded.bundle, generation.dependencyLinks);
        this.assertCompleteDependencyClosure(generation.dependencyLinks, this.generationDependencyReferences(loaded.bundle, current.episode, current.step, [
          { kind: "canvas", id: generation.canvasId }, { kind: "node", id: generation.nodeId }, ...generation.plan.references,
        ]));
        project = { ...project, workflow: { ...project.workflow, generations: project.workflow.generations.map((item) => item.id === generation.id ? { ...item, authorization: command.authorization, updatedAt: now } : item) } };
        const found = this.requireWorkflowStep(project, command.episodeId, command.workflowRecordId);
        const authorization = { id: command.authorization.id, scopeRevision: command.authorization.scopeHash, authorizedAt: command.authorization.authorizedAt };
        project = this.replaceWorkflowStep(project, found.episode.id, { ...found.step, computeAuthorizations: [...found.step.computeAuthorizations.filter((item) => item.id !== authorization.id), authorization], updatedAt: now });
        touchProject(); break;
      }
      case "workflow.adopt": {
        this.requireHumanTransition(command);
        const generation = project.workflow.generations.find((item) => item.id === command.generationId);
        const candidate = generation?.candidates.find((item) => item.id === command.candidateId);
        if (!generation || !candidate?.assetId || !["awaiting-review", "adopted"].includes(candidate.status)) throw new ApiError(409, "toon_media_candidate_not_reviewable", "The media candidate is not ready for adoption");
        if (generation.episodeId !== command.episodeId || generation.workflowRecordId !== command.workflowRecordId) throw new ApiError(409, "toon_workflow_scope_changed", "Generation workflow scope changed before adoption");
        const assetId = candidate.assetId;
        const descriptor = requireCanvas(generation.canvasId);
        const canvas = bundle.canvasFiles[descriptor.file]!;
        if (!canvas.nodes.some((item) => item.id === generation.nodeId)) throw new ApiError(409, "toon_media_job_target_changed", "The generation node is unavailable");
        const revision = entityRevision({ generationId: generation.id, candidateId: candidate.id, assetId, adoptedAt: now });
        const adoption = { id: command.adoptionId, generationId: generation.id, candidateId: candidate.id, assetId, canvasId: generation.canvasId, nodeId: generation.nodeId, episodeId: generation.episodeId, workflowRecordId: generation.workflowRecordId, revision, adoptedAt: now };
        project = {
          ...project,
          workflow: {
            ...project.workflow,
            generations: project.workflow.generations.map((item) => item.id === generation.id ? { ...item, status: "adopted", candidates: item.candidates.map((entry) => entry.id === candidate.id ? { ...entry, status: "adopted", updatedAt: now } : entry.status === "adopted" ? { ...entry, status: "awaiting-review", updatedAt: now } : entry), updatedAt: now } : item),
            adoptions: [...project.workflow.adoptions.map((item) => !item.supersededAt && item.nodeId === generation.nodeId ? { ...item, supersededAt: now } : item), adoption],
          },
        };
        const found = this.requireWorkflowStep(project, command.episodeId, command.workflowRecordId);
        const resultAdoption = { id: adoption.id, resultId: candidate.id, artifactPath: requireAsset(assetId).path, artifactScope: "project" as const, adoptedAt: now };
        project = this.replaceWorkflowStep(project, found.episode.id, { ...found.step, status: "adopted", resultAdoptions: [...found.step.resultAdoptions.map((item) => item.supersededAt ? item : { ...item, supersededAt: now }), resultAdoption], updatedAt: now });
        if (found.step.id === "video-clips") {
          const adoptionStep = project.workflow.episodes.find((episode) => episode.id === found.episode.id)?.steps?.find((step) => step.id === "adopt-clips");
          if (adoptionStep) project = this.replaceWorkflowStep(project, found.episode.id, { ...adoptionStep, status: "adopted", resultAdoptions: [...adoptionStep.resultAdoptions.map((item) => item.supersededAt ? item : { ...item, supersededAt: now }), resultAdoption], updatedAt: now });
        }
        const nextCanvas = { ...canvas, nodes: canvas.nodes.map((item) => item.id === generation.nodeId ? { ...item, config: { ...item.config, generation: { kind: "generation" as const, id: generation.id, revision: generation.revision }, asset: { kind: "asset" as const, id: assetId, revision: requireAsset(assetId).checksum } } } : item) };
        const canvasContent = json(nextCanvas);
        canvases = { ...canvases, canvases: canvases.canvases.map((item) => item.id === descriptor.id ? { ...item, revision: sha256(canvasContent) } : item) };
        assets = { ...assets, assets: assets.assets.map((item) => item.id === assetId ? { ...item, references: [...item.references.filter((ref) => !(ref.kind === "adoption" && ref.id === adoption.id)), { kind: "adoption", id: adoption.id, revision }, { kind: "node", id: generation.nodeId }], updatedAt: now } : item) };
        write(descriptor.file, canvasContent); write(CATALOG_PATHS.canvases, canvases); write(CATALOG_PATHS.assets, assets); markChanged({ kind: "adoption", id: adoption.id, revision }); touchProject(); break;
      }
      case "workflow.delivery": {
        this.requireHumanTransition(command);
        const found = this.requireWorkflowStep(project, command.episodeId, command.workflowRecordId);
        this.assertWorkflowStepAvailable(found.episode, found.step);
        if (found.step.id !== "delivery-manifest") throw new ApiError(409, "workflow_prerequisite_incomplete", "Delivery must target the canonical delivery step");
        const activeAdoptions = project.workflow.adoptions.filter((item) => !item.supersededAt && item.episodeId === command.episodeId && item.workflowRecordId === "video-clips" && item.canvasId === found.episode.canvasId);
        if (!activeAdoptions.length) throw new ApiError(409, "workflow_prerequisite_incomplete", "Delivery requires a current adopted video result");
        project = this.replaceWorkflowStep(project, found.episode.id, { ...found.step, status: "approved", updatedAt: now }); touchProject(); break;
      }
      case "workflow.invalidate":
        project = this.invalidateDependencyClosure(project, command.targets, command.reason, now); touchProject(); break;
    }
    if (changed.size && !command.kind.startsWith("workflow.")) {
      project = this.invalidateDependencyClosure(project, [...changed.values()], "A recorded upstream dependency changed.", now);
      write(PROJECT_FILE, project, true);
    }
    return [...writes.values()];
  }

  private requireHumanTransition(command: ToonWorkspaceCommand): void {
    if (command.origin !== "human-ui" || command.actor.kind !== "human" || !command.actor.id) {
      throw new ApiError(403, "toon_human_action_required", "This protected workflow transition requires an explicit human UI action");
    }
  }

  private assertCommandAuthority(command: ToonWorkspaceCommand, authority: CommandAuthority): void {
    if (PROTECTED_WORKFLOW_COMMANDS.has(command.kind)) {
      if (authority.kind !== "human-interaction" || command.origin !== "human-ui" || command.actor.kind !== "human" || command.actor.id !== authority.principalId) {
        throw new ApiError(403, "toon_human_action_required", "This protected workflow transition requires a dedicated server-authenticated human interaction");
      }
      return;
    }
    if (INTERNAL_WORKSPACE_COMMANDS.has(command.kind)) {
      const allowed = authority.kind === "trusted-internal"
        && command.actor.kind === "system"
        && command.origin === authority.coordinator
        && (authority.coordinator === "recovery" || command.kind === "workflow.configure" || command.kind === "workflow.invalidate");
      if (!allowed) throw new ApiError(403, "toon_internal_command_required", "This command is reserved for a trusted migration or recovery coordinator");
      return;
    }
    if (authority.kind !== "ordinary" || command.origin === "migration" || command.origin === "recovery") {
      throw new ApiError(403, "toon_command_origin_invalid", "This command origin is not permitted for the requested coordinator operation");
    }
    if ((command.origin === "human-ui" || command.origin === "autosave") && command.actor.kind !== "human") {
      throw new ApiError(403, "toon_command_actor_invalid", "Human workspace command origin requires a human actor");
    }
    if (command.origin === "assistant-tool" && (command.actor.kind !== "assistant" || !command.actor.id)) {
      throw new ApiError(403, "toon_command_actor_invalid", "Assistant workspace commands require an authenticated tool-call actor");
    }
  }

  private requireWorkflowStep(project: ToonWorkspaceProject, episodeId: string, workflowRecordId: string) {
    const episode = project.workflow.episodes.find((item) => item.id === episodeId);
    const step = episode?.steps?.find((item) => item.id === workflowRecordId);
    if (episode && step) return { episode, step };
    throw new ApiError(404, "toon_workflow_record_not_found", "Toon workflow record not found");
  }

  private assertWorkflowStepAvailable(
    episode: ToonWorkspaceProject["workflow"]["episodes"][number],
    step: NonNullable<ToonWorkspaceProject["workflow"]["episodes"][number]["steps"]>[number],
  ): void {
    const available = step.status !== "stale" && step.dependencies.every((dependencyId) => {
      const dependency = episode.steps?.find((candidate) => candidate.id === dependencyId);
      return dependency && ["approved", "adopted", "skipped"].includes(dependency.status);
    });
    if (!available) throw new ApiError(409, "workflow_prerequisite_incomplete", "Workflow prerequisites are incomplete");
  }

  private assertWorkflowStepCurrent(
    bundle: ToonPortableProjectBundle,
    episode: ToonWorkspaceProject["workflow"]["episodes"][number],
    step: NonNullable<ToonWorkspaceProject["workflow"]["episodes"][number]["steps"]>[number],
  ): void {
    this.assertWorkflowStepAvailable(episode, step);
    const visited = new Set<string>();
    const visit = (candidate: typeof step) => {
      if (visited.has(candidate.id)) return;
      visited.add(candidate.id);
      if (candidate.status === "stale") throw new ApiError(409, "workflow_prerequisite_incomplete", "Workflow prerequisites are stale");
      this.assertDependencyLinks(bundle, candidate.dependencyLinks);
      for (const dependencyId of candidate.dependencies) {
        const dependency = episode.steps?.find((item) => item.id === dependencyId);
        if (!dependency || !["approved", "adopted", "skipped"].includes(dependency.status)) throw new ApiError(409, "workflow_prerequisite_incomplete", "Workflow prerequisites are incomplete");
        visit(dependency);
      }
    };
    visit(step);
  }

  private replaceWorkflowStep(
    project: ToonWorkspaceProject,
    episodeId: string,
    step: NonNullable<ToonWorkspaceProject["workflow"]["episodes"][number]["steps"]>[number],
  ): ToonWorkspaceProject {
    const episode = project.workflow.episodes.find((item) => item.id === episodeId);
    const steps = episode?.steps ? promoteAvailableWorkflowSteps(episode.steps.map((item) => item.id === step.id ? step : item), step.updatedAt) : undefined;
    return {
      ...project,
      workflow: {
        ...project.workflow,
        episodes: project.workflow.episodes.map((episode) => episode.id !== episodeId ? episode : {
          ...episode,
          steps,
          stages: episode.stages.map((stage) => ({
            ...stage,
            status: workflowStatus(steps, stage.stage),
            ...(stage.stage === step.stage && step.inputRevision ? { inputRevision: step.inputRevision } : {}),
            ...(stage.stage === step.stage && step.outputRevision ? { outputRevision: step.outputRevision } : {}),
            ...(stage.stage === step.stage && step.skipReason ? { skipReason: step.skipReason } : {}),
            updatedAt: step.updatedAt,
          })),
          updatedAt: step.updatedAt,
        }),
      },
    };
  }

  private dependencyRevision(bundle: ToonPortableProjectBundle, reference: ToonPortableReference): string | null {
    if (reference.kind === "canvas") return bundle.canvases.canvases.find((item) => item.id === reference.id)?.revision ?? null;
    if (reference.kind === "node") {
      const node = Object.values(bundle.canvasFiles).flatMap((canvas) => canvas.nodes).find((item) => item.id === reference.id);
      return node ? entityRevision(node) : null;
    }
    if (reference.kind === "document") return bundle.documents.documents.find((item) => item.id === reference.id)?.revision ?? null;
    if (reference.kind === "asset") return bundle.assets.assets.find((item) => item.id === reference.id)?.checksum ?? null;
    if (reference.kind === "workflow") {
      const [episodeId, stepId] = reference.id.split(".", 2);
      const step = bundle.project.workflow.episodes.find((episode) => episode.id === episodeId)?.steps?.find((item) => item.id === stepId);
      return step ? entityRevision(step) : null;
    }
    if (reference.kind === "generation") return bundle.project.workflow.generations.find((item) => item.id === reference.id)?.revision ?? null;
    if (reference.kind === "adoption") return bundle.project.workflow.adoptions.find((item) => item.id === reference.id)?.revision ?? null;
    return null;
  }

  private generationDependencyReferences(
    bundle: ToonPortableProjectBundle,
    episode: ToonWorkspaceProject["workflow"]["episodes"][number],
    step: NonNullable<ToonWorkspaceProject["workflow"]["episodes"][number]["steps"]>[number],
    direct: ToonPortableReference[],
  ): ToonPortableReference[] {
    const references = new Map(direct.map((reference) => [dependencyKey(reference), { kind: reference.kind, id: reference.id } as ToonPortableReference]));
    const visited = new Set<string>();
    const inherit = (candidate: typeof step) => {
      if (visited.has(candidate.id)) return;
      visited.add(candidate.id);
      for (const link of candidate.dependencyLinks) references.set(dependencyKey(link.target), { kind: link.target.kind, id: link.target.id });
      for (const dependencyId of candidate.dependencies) {
        const dependency = episode.steps?.find((item) => item.id === dependencyId);
        if (!dependency) throw new ApiError(409, "workflow_prerequisite_incomplete", "Workflow dependency closure is incomplete");
        const workflow = { kind: "workflow" as const, id: `${episode.id}.${dependency.id}` };
        references.set(dependencyKey(workflow), workflow);
        inherit(dependency);
      }
    };
    inherit(step);
    for (const reference of references.values()) if (!this.dependencyRevision(bundle, reference)) throw new ApiError(409, "toon_reference_integrity", "A generation dependency target is missing", { target: reference });
    return [...references.values()].sort((left, right) => dependencyKey(left).localeCompare(dependencyKey(right)));
  }

  private assertCompleteDependencyClosure(links: ToonWorkflowDependencyLink[], required: ToonPortableReference[]): void {
    const actual = new Set(links.map((link) => dependencyKey(link.target)));
    const expected = new Set(required.map(dependencyKey));
    const missing = required.filter((reference) => !actual.has(dependencyKey(reference)));
    if (missing.length || actual.size !== expected.size) throw new ApiError(409, "toon_generation_dependency_closure_incomplete", "Generation dependency closure is incomplete", { missing });
  }

  private assertDependencyLinks(bundle: ToonPortableProjectBundle, links: ToonWorkflowDependencyLink[]): void {
    const seen = new Set<string>();
    for (const link of links) {
      const key = dependencyKey(link.target);
      if (seen.has(key)) throw new ApiError(409, "toon_duplicate_dependency", "A workflow dependency is listed more than once");
      seen.add(key);
      const revision = this.dependencyRevision(bundle, link.target);
      if (!revision) throw new ApiError(409, "toon_reference_integrity", "A workflow dependency target is missing", { target: link.target });
      if (revision !== link.revision || link.target.revision && link.target.revision !== link.revision) {
        throw new ApiError(409, "toon_factory_revision_conflict", "A workflow dependency changed before the command", { target: link.target, expectedRevision: link.revision, currentRevision: revision });
      }
    }
  }

  private invalidateDependencyClosure(project: ToonWorkspaceProject, targets: ToonPortableReference[], reason: string, now: string): ToonWorkspaceProject {
    const changed = new Set(targets.map(dependencyKey));
    const staleSteps = new Set<string>();
    for (const episode of project.workflow.episodes) {
      for (const step of episode.steps ?? []) {
        if (step.dependencyLinks.some((link) => changed.has(dependencyKey(link.target)))) staleSteps.add(`${episode.id}:${step.id}`);
      }
    }
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const episode of project.workflow.episodes) {
        for (const step of episode.steps ?? []) {
          const scopedId = `${episode.id}:${step.id}`;
          if (!staleSteps.has(scopedId) && step.dependencies.some((dependency) => staleSteps.has(`${episode.id}:${dependency}`))) {
            staleSteps.add(scopedId);
            expanded = true;
          }
        }
      }
    }
    const staleWorkflowDependencies = new Set([...staleSteps].map((value) => {
      const separator = value.indexOf(":");
      return `workflow:${value.slice(0, separator)}.${value.slice(separator + 1)}`;
    }));
    const generations = project.workflow.generations.map((generation) => {
      if (!generation.dependencyLinks.some((link) => changed.has(dependencyKey(link.target)) || staleWorkflowDependencies.has(dependencyKey(link.target)))) return generation;
      const active = ["awaiting-human-authorization", "queued", "submitting", "running"].includes(generation.status);
      return {
        ...generation,
        ...(generation.authorization && !generation.authorization.invalidatedAt ? { authorization: { ...generation.authorization, invalidatedAt: now } } : {}),
        ...(active ? { status: "awaiting-human-authorization" as const } : {}),
        updatedAt: now,
      };
    });
    if (!staleSteps.size && generations.every((item, index) => item === project.workflow.generations[index])) return project;
    const episodes = project.workflow.episodes.map((episode) => {
      const steps = episode.steps?.map((step) => !staleSteps.has(`${episode.id}:${step.id}`) ? step : {
        ...step,
        status: "stale" as const,
        staleReason: reason,
        history: [...step.history, {
          id: `version-${step.id}-${step.history.length + 1}-${Date.parse(now)}`.slice(0, 128),
          status: step.status,
          ...(step.inputRevision ? { inputRevision: step.inputRevision } : {}),
          ...(step.outputRevision ? { outputRevision: step.outputRevision } : {}),
          recordedAt: now,
        }],
        updatedAt: now,
      });
      const staleStages = new Set(steps?.filter((step) => step.status === "stale").map((step) => step.stage));
      return {
        ...episode,
        ...(steps ? { steps } : {}),
        stages: episode.stages.map((stage) => staleStages.has(stage.stage) ? { ...stage, status: "stale" as const, updatedAt: now } : stage),
        ...(steps?.some((step) => staleSteps.has(`${episode.id}:${step.id}`)) ? { updatedAt: now } : {}),
      };
    });
    return { ...project, workflow: { ...project.workflow, episodes, generations } };
  }

  private applyWritesToBundle(bundle: ToonPortableProjectBundle, writes: WorkspaceWrite[]): ToonPortableProjectBundle {
    const next = structuredClone(bundle);
    for (const write of writes) {
      if (write.content === null) continue;
      if (write.content instanceof Uint8Array) continue;
      if (typeof write.content !== "string") continue;
      if (write.path === PROJECT_FILE) next.project = toonWorkspaceProjectSchema.parse(JSON.parse(write.content));
      else if (write.path === CATALOG_PATHS.canvases) next.canvases = toonCanvasCatalogSchema.parse(JSON.parse(write.content));
      else if (write.path === CATALOG_PATHS.documents) next.documents = toonDocumentCatalogSchema.parse(JSON.parse(write.content));
      else if (write.path === CATALOG_PATHS.assets) next.assets = toonAssetCatalogSchema.parse(JSON.parse(write.content));
      else if (write.path.startsWith("canvases/")) next.canvasFiles[write.path] = toonWorkspaceCanvasSchema.parse(JSON.parse(write.content));
    }
    return next;
  }

  private async inspectSafeAssetFile(root: string, relativePath: string, filename: string, declaredMimeType?: string): Promise<InspectedAssetStream> {
    const path = await resolveWithinRoot(root, relativePath);
    const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new ApiError(404, "toon_asset_source_not_found", "Authorized asset source was not found");
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const parent = await safeParentSnapshot(root, path);
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const [opened, canonicalRoot, canonicalPath] = await Promise.all([handle.stat(), realpath(root), realpath(path)]);
      if (!opened.isFile() || canonicalPath !== canonicalRoot && !canonicalPath.startsWith(canonicalRoot + sep)) throw new ApiError(400, "path_escape", "Authorized asset source is unsafe");
      await assertSafeParentSnapshot(root, path, { parentDev: parent.dev, parentIno: parent.ino });
      return { ...await inspectAssetStream(handle.readableWebStream() as unknown as AsyncIterable<Uint8Array>, filename, declaredMimeType), sourceDev: Number(opened.dev), sourceIno: Number(opened.ino), parentDev: parent.dev, parentIno: parent.ino };
    } finally {
      await handle.close();
    }
  }

  private async buildStreamedAssetImport(
    loaded: Awaited<ReturnType<ToonWorkspaceCoordinator["load"]>>,
    input: { operationId: string; assetId: string; sourcePath: string; origin: "imported" | "generated" | "document" | "migration"; actor: { kind: "human" | "assistant" | "system"; id?: string }; canvas?: { id: string; expectedRevision: string; position: { x: number; y: number } } },
    filename: string,
    inspected: InspectedAssetStream,
  ): Promise<{ writes: WorkspaceWrite[]; affected: ToonPortableReference[]; result: ToonAssetImportResult }> {
    const now = new Date().toISOString();
    let assets = loaded.bundle.assets;
    let canvases = loaded.bundle.canvases;
    const writes: WorkspaceWrite[] = [];
    const duplicate = assets.assets.find((item) => item.checksum === inspected.checksum && item.bytes === inspected.bytes && item.state !== "tombstone");
    if (!duplicate && assets.assets.some((item) => item.id === input.assetId)) throw new ApiError(409, "toon_duplicate_id", "Asset ID already exists");
    const stem = filename.slice(0, Math.max(1, filename.length - extname(filename).length)).replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) || "asset";
    const proposedPath = `assets/imported/${stem}-${inspected.checksum.slice(0, 12)}${inspected.extension}`;
    if (!duplicate && assets.assets.some((item) => item.path === proposedPath)) throw new ApiError(409, "toon_duplicate_path", "Asset path already exists with different content");
    const asset: ToonAssetDescriptor = duplicate ?? {
      id: input.assetId, title: filename, path: proposedPath, mimeType: inspected.mimeType, bytes: inspected.bytes, checksum: inspected.checksum,
      ...(inspected.width ? { width: inspected.width } : {}), ...(inspected.height ? { height: inspected.height } : {}), ...(inspected.durationSeconds ? { durationSeconds: inspected.durationSeconds } : {}),
      origin: input.origin, state: "active", references: [], createdAt: now, updatedAt: now,
    };
    if (!duplicate) {
      assets = { ...assets, assets: [...assets.assets, asset] };
      writes.push({ path: asset.path, content: { sourceRoot: this.workspaceRoot, sourcePath: input.sourcePath, revision: inspected.checksum, bytes: inspected.bytes, sourceDev: inspected.sourceDev, sourceIno: inspected.sourceIno, parentDev: inspected.parentDev, parentIno: inspected.parentIno } });
    } else if (duplicate.state === "trashed") {
      if (!duplicate.trashPath) throw new ApiError(409, "toon_asset_integrity_mismatch", "Trashed duplicate asset content is unavailable");
      const trashed = await readSafeFile(loaded.root, duplicate.trashPath, Number.MAX_SAFE_INTEGER);
      if (!trashed || sha256(trashed) !== duplicate.checksum) throw new ApiError(409, "toon_asset_integrity_mismatch", "Trashed duplicate asset content is unavailable or invalid");
      writes.push({ path: duplicate.path, content: trashed }, { path: duplicate.trashPath, content: null });
      assets = { ...assets, assets: assets.assets.map((item) => item.id === duplicate.id ? { ...item, state: "active" as const, trashPath: undefined, trashedAt: undefined, updatedAt: now } : item) };
    }
    let nodeId: string | undefined;
    if (input.canvas) {
      const descriptor = canvases.canvases.find((item) => item.id === input.canvas!.id);
      if (!descriptor) throw new ApiError(404, "toon_canvas_not_found", "Toon canvas not found");
      const canvas = loaded.bundle.canvasFiles[descriptor.file]!;
      nodeId = `${input.assetId}-node`.slice(0, 128);
      if (canvas.nodes.some((item) => item.id === nodeId)) throw new ApiError(409, "toon_duplicate_id", "Imported asset node ID already exists");
      const content = json({ ...canvas, nodes: [...canvas.nodes, compatibleAssetNode(asset, nodeId, input.canvas.position)] });
      canvases = { ...canvases, canvases: canvases.canvases.map((item) => item.id === descriptor.id ? { ...item, revision: sha256(content) } : item) };
      assets = { ...assets, assets: assets.assets.map((item) => item.id === asset.id ? { ...item, state: "active" as const, trashPath: undefined, trashedAt: undefined, references: [...item.references.filter((ref) => !(ref.kind === "node" && ref.id === nodeId)), { kind: "node" as const, id: nodeId! }], updatedAt: now } : item) };
      writes.push({ path: descriptor.file, content }, { path: CATALOG_PATHS.canvases, content: json(canvases) });
    }
    const project = { ...loaded.bundle.project, metadata: { ...loaded.bundle.project.metadata, updatedAt: now }, ...(loaded.bundle.project.migration ? { migration: { ...loaded.bundle.project.migration, v2EditedAt: loaded.bundle.project.migration.v2EditedAt ?? now } } : {}) };
    writes.push({ path: CATALOG_PATHS.assets, content: json(assets) }, { path: PROJECT_FILE, content: json(project), rootLast: true });
    const result = { asset: assets.assets.find((item) => item.id === asset.id)!, reused: Boolean(duplicate), ...(nodeId ? { nodeId } : {}) } satisfies ToonAssetImportResult;
    return { writes, affected: [{ kind: "asset", id: result.asset.id }, ...(nodeId ? [{ kind: "node" as const, id: nodeId }] : [])], result };
  }

  private async publish(projectId: string, operationId: string, payloadHash: string, origin: ToonWorkspaceOperationOutcome["origin"], actor: ToonWorkspaceOperationOutcome["actor"], writes: WorkspaceWrite[], affected: ToonPortableReference[], result: unknown, projectRoot?: string, removeProjectRootOnRollback = false, loadedRevisions?: Record<string, string>, sourceSnapshots?: FileSnapshot[]): Promise<ToonWorkspaceOperationOutcome> {
    const root = projectRoot ?? (await this.findProject(projectId, 2).catch(() => null))?.root;
    if (!root) throw new ApiError(404, "toon_project_not_found", "Toon project not found");
    const journalDirectory = `.toon-journal/${operationId}`;
    await ensureSafeDirectory(root, journalDirectory);
    const entries: JournalEntry[] = [];
    const preparedTemporaries: string[] = [];
    const revisions: Record<string, string> = {};
    const ordered = [...writes].sort((left, right) => Number(Boolean(left.rootLast)) - Number(Boolean(right.rootLast)));
    try {
      for (const [index, write] of ordered.entries()) {
        const target = await resolveWithinRoot(root, write.path);
        await ensureSafeDirectory(root, dirname(write.path));
        const parent = await safeParentSnapshot(root, target);
        const current = await readSafeFile(root, write.path, Number.MAX_SAFE_INTEGER);
        const currentMetadata = current ? await lstat(target) : null;
        const currentRevision = current ? sha256(current) : null;
        const loadedRevision = loadedRevisions ? loadedRevisions[write.path] ?? null : currentRevision;
        if (currentRevision !== loadedRevision) throw new ApiError(409, "toon_factory_revision_conflict", "Project content changed after the mutation snapshot was loaded", { path: write.path, expectedRevision: loadedRevision, currentRevision });
        const suffix = `.jugglework-${operationId}-${index}`;
        const temporaryRelative = portablePath(relative(root, join(dirname(target), `${basename(target)}${suffix}.tmp`)));
        const backupRelative = portablePath(relative(root, join(dirname(target), `${basename(target)}${suffix}.bak`)));
        const temporary = await resolveWithinRoot(root, temporaryRelative);
        preparedTemporaries.push(temporaryRelative);
        if (write.content !== null) {
          if (typeof write.content === "object" && !(write.content instanceof Uint8Array)) {
            const source = await resolveWithinRoot(write.content.sourceRoot, write.content.sourcePath);
            const sourceMetadata = await lstat(source).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
            if (!sourceMetadata?.isFile() || sourceMetadata.isSymbolicLink()) throw new ApiError(404, "toon_asset_source_not_found", "Authorized asset source was not found");
            const sourceHandle = await open(source, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
            const targetHandle = await open(temporary, "wx", 0o600);
            const hash = createHash("sha256");
            let bytes = 0;
            try {
              const [opened, canonicalSourceRoot, canonicalSource] = await Promise.all([sourceHandle.stat(), realpath(write.content.sourceRoot), realpath(source)]);
              if (!opened.isFile() || canonicalSource !== canonicalSourceRoot && !canonicalSource.startsWith(canonicalSourceRoot + sep)) throw new ApiError(400, "path_escape", "Authorized asset source is unsafe");
              if (write.content.sourceDev !== undefined && write.content.sourceIno !== undefined && (Number(opened.dev) !== write.content.sourceDev || Number(opened.ino) !== write.content.sourceIno)) throw new ApiError(409, "toon_asset_source_changed", "Authorized asset source changed during import");
              if (write.content.parentDev !== undefined && write.content.parentIno !== undefined) await assertSafeParentSnapshot(write.content.sourceRoot, source, { parentDev: write.content.parentDev, parentIno: write.content.parentIno });
              for await (const chunk of sourceHandle.createReadStream({ autoClose: false })) {
                bytes += chunk.byteLength;
                if (bytes > write.content.bytes) throw new ApiError(409, "toon_asset_source_changed", "Authorized asset source changed during import");
                hash.update(chunk);
                await targetHandle.write(chunk);
              }
              await targetHandle.sync();
            } finally {
              await Promise.all([sourceHandle.close(), targetHandle.close()]);
            }
            if (bytes !== write.content.bytes || hash.digest("hex") !== write.content.revision) throw new ApiError(409, "toon_asset_source_changed", "Authorized asset source changed during import");
          } else {
            const handle = await open(temporary, "wx", 0o600);
            try { await handle.writeFile(write.content); await handle.sync(); } finally { await handle.close(); }
          }
        }
        const desiredRevision = write.content === null ? null : typeof write.content === "object" && !(write.content instanceof Uint8Array) ? write.content.revision : sha256(write.content);
        entries.push({ target: write.path, temporary: temporaryRelative, backup: backupRelative, desiredRevision, previousRevision: loadedRevision, ...(currentMetadata ? { previousDev: Number(currentMetadata.dev), previousIno: Number(currentMetadata.ino) } : {}), rootLast: Boolean(write.rootLast), parentDev: parent.dev, parentIno: parent.ino });
        if (desiredRevision) revisions[write.path] = desiredRevision;
      }
    } catch (error) {
      for (const temporary of preparedTemporaries) await rm(await resolveWithinRoot(root, temporary), { force: true });
      throw error;
    }
    const outcome = toonWorkspaceOperationOutcomeSchema.parse({ operationId, payloadHash, status: "committed", origin, actor, affected, revisions, result, committedAt: new Date().toISOString() });
    const payload: JournalPayload = { projectRoot: portablePath(relative(await realpath(this.workspaceRoot), await realpath(root))), entries, ...(sourceSnapshots ? { sourceSnapshots: sourceSnapshots.map(({ content: _content, ...snapshot }) => snapshot) } : {}), outcome, ...(removeProjectRootOnRollback ? { removeProjectRootOnRollback: true } : {}) };
    this.runtime.prepareJournal({ workspaceScope: this.workspaceScope, projectId, operationId, payloadHash, state: "prepared", journal: payload as unknown as Record<string, unknown> });
    if (this.hooks.crashAt === "after-prepare") throw new Error("Injected Toon workspace crash after prepare");
    this.runtime.updateJournal(this.workspaceScope, projectId, operationId, "committing");
    await this.hooks.beforePublish?.();
    try {
      await this.resumePublish(payload);
    } catch (error) {
      if (!await this.publicationStarted(payload)) {
        await this.cleanupPrepared(payload);
        this.runtime.updateJournal(this.workspaceScope, projectId, operationId, "terminal", "rolled_back");
      }
      throw error;
    }
    if (this.hooks.crashAt === "after-publish") throw new Error("Injected Toon workspace crash after publish");
    this.runtime.updateJournal(this.workspaceScope, projectId, operationId, "committed");
    if (this.hooks.crashAt === "after-commit") throw new Error("Injected Toon workspace crash after commit");
    this.runtime.saveOutcome(this.workspaceScope, projectId, outcome);
    this.runtime.updateJournal(this.workspaceScope, projectId, operationId, "terminal", "committed");
    await this.cleanupPublished(payload);
    return outcome;
  }

  private async resumePublish(payload: JournalPayload): Promise<void> {
    const root = await resolveWithinRoot(this.workspaceRoot, payload.projectRoot);
    if (!await this.publicationStarted(payload)) {
      await this.assertSourceSnapshots(root, payload.sourceSnapshots ?? []);
      await this.assertDestinationSnapshots(root, payload.entries);
    }
    const ordered = [...payload.entries].sort((left, right) => Number(left.rootLast) - Number(right.rootLast));
    for (const [index, entry] of ordered.entries()) {
      const target = await resolveWithinRoot(root, entry.target);
      const temporary = await resolveWithinRoot(root, entry.temporary);
      const backup = await resolveWithinRoot(root, entry.backup);
      await assertSafeParentSnapshot(root, target, entry);
      const [targetSnapshot, backupSnapshot, temporarySnapshot] = await Promise.all([
        this.snapshotProjectFile(root, entry.target),
        this.snapshotProjectFile(root, entry.backup),
        this.snapshotProjectFile(root, entry.temporary),
      ]);
      const priorBackedUp = entry.previousRevision !== null && backupSnapshot?.revision === entry.previousRevision
        && backupSnapshot.dev === entry.previousDev && backupSnapshot.ino === entry.previousIno;
      const publishedFromTemporary = targetSnapshot && temporarySnapshot
        && targetSnapshot.dev === temporarySnapshot.dev && targetSnapshot.ino === temporarySnapshot.ino;
      if (entry.desiredRevision === null && !targetSnapshot && priorBackedUp) continue;
      if (entry.desiredRevision !== null && targetSnapshot?.revision === entry.desiredRevision && publishedFromTemporary && (priorBackedUp || entry.previousRevision === null)) continue;
      if (temporarySnapshot && entry.desiredRevision !== null && temporarySnapshot.revision !== entry.desiredRevision) throw new ApiError(409, "toon_workspace_recovery_conflict", "Prepared journal content is invalid", { path: entry.target });
      if (entry.desiredRevision !== null && !temporarySnapshot) throw new ApiError(409, "toon_workspace_recovery_conflict", "Prepared journal content is missing", { path: entry.target });
      if (backupSnapshot && !priorBackedUp) throw new ApiError(409, "toon_workspace_recovery_conflict", "Project recovery backup changed during journal publication", { path: entry.target, recoveryBackup: entry.backup });

      let backupCreated = priorBackedUp;
      try {
        if (!priorBackedUp && entry.previousRevision !== null) {
          if (!targetSnapshot || targetSnapshot.revision !== entry.previousRevision || targetSnapshot.dev !== entry.previousDev || targetSnapshot.ino !== entry.previousIno) {
            throw new ApiError(409, "toon_factory_revision_conflict", "Project content changed during journal publication", { path: entry.target });
          }
          await assertSafeParentSnapshot(root, target, entry);
          try {
            await rename(target, backup);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ApiError(409, "toon_factory_revision_conflict", "Project content changed during journal publication", { path: entry.target });
            throw error;
          }
          backupCreated = true;
          const moved = await this.snapshotProjectFile(root, entry.backup);
          if (!moved || moved.revision !== entry.previousRevision || moved.dev !== entry.previousDev || moved.ino !== entry.previousIno) {
            throw new ApiError(409, "toon_factory_revision_conflict", "Project content identity changed during journal publication", { path: entry.target, recoveryBackup: entry.backup });
          }
        } else if (!priorBackedUp && targetSnapshot) {
          throw new ApiError(409, "toon_factory_revision_conflict", "Project destination changed during publication", { path: entry.target });
        }

        await assertSafeParentSnapshot(root, target, entry);
        if (await lstat(target).then(() => true).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error))) {
          throw new ApiError(409, "toon_factory_revision_conflict", "Project destination changed during publication", { path: entry.target, recoveryBackup: backupCreated ? entry.backup : null });
        }
        await this.hooks.afterDestinationCheck?.(entry.target);
        await assertSafeParentSnapshot(root, target, entry);
        if (entry.desiredRevision === null) {
          if (await lstat(target).then(() => true).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error))) {
            throw new ApiError(409, "toon_factory_revision_conflict", "Project destination changed during publication", { path: entry.target, recoveryBackup: backupCreated ? entry.backup : null });
          }
        } else {
          try {
            await link(temporary, target);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ApiError(409, "toon_factory_revision_conflict", "Project destination changed during publication", { path: entry.target, recoveryBackup: backupCreated ? entry.backup : null });
            throw error;
          }
        }
        await syncDirectory(dirname(target));
        if (this.hooks.crashAt === "during-publish" && index === (this.hooks.crashAfterEntry ?? 0)) throw new Error("Injected Toon workspace crash during publish");
      } catch (error) {
        if (backupCreated) await this.restoreJournalBackup(root, entry);
        throw error;
      }
    }
  }

  private async restoreJournalBackup(root: string, entry: JournalEntry): Promise<void> {
    const target = await resolveWithinRoot(root, entry.target);
    const backup = await resolveWithinRoot(root, entry.backup);
    const snapshot = await this.snapshotProjectFile(root, entry.backup);
    if (!snapshot || snapshot.revision !== entry.previousRevision || snapshot.dev !== entry.previousDev || snapshot.ino !== entry.previousIno) return;
    await assertSafeParentSnapshot(root, target, entry);
    try {
      await link(backup, target);
      await syncDirectory(dirname(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  private async publicationStarted(payload: JournalPayload): Promise<boolean> {
    const root = await resolveWithinRoot(this.workspaceRoot, payload.projectRoot);
    for (const entry of payload.entries) {
      const backup = await readSafeFile(root, entry.backup, Number.MAX_SAFE_INTEGER);
      if (backup) return true;
      const target = await readSafeFile(root, entry.target, Number.MAX_SAFE_INTEGER);
      if (entry.desiredRevision === null ? !target && entry.previousRevision !== null : Boolean(target && sha256(target) === entry.desiredRevision && entry.desiredRevision !== entry.previousRevision)) return true;
    }
    return false;
  }

  private async assertSourceSnapshots(root: string, snapshots: FileSnapshot[]): Promise<void> {
    for (const expected of snapshots) {
      const current = await this.snapshotProjectFile(root, expected.path);
      if (!current || current.revision !== expected.revision || current.dev !== expected.dev || current.ino !== expected.ino) {
        throw new ApiError(409, "toon_migration_source_changed", "A migration source changed before publication", { path: expected.path });
      }
    }
  }

  private async assertDestinationSnapshots(root: string, entries: JournalEntry[]): Promise<void> {
    for (const entry of entries) {
      const target = await resolveWithinRoot(root, entry.target);
      await assertSafeParentSnapshot(root, target, entry);
      const bytes = await readSafeFile(root, entry.target, Number.MAX_SAFE_INTEGER);
      const revision = bytes ? sha256(bytes) : null;
      if (revision !== entry.previousRevision) throw new ApiError(409, "toon_factory_revision_conflict", "A project destination changed before publication", { path: entry.target });
      if (bytes) {
        const metadata = await lstat(target);
        if (Number(metadata.dev) !== entry.previousDev || Number(metadata.ino) !== entry.previousIno) throw new ApiError(409, "toon_factory_revision_conflict", "A project destination identity changed before publication", { path: entry.target });
      }
    }
  }

  private async cleanupPrepared(payload: JournalPayload): Promise<void> {
    const root = await resolveWithinRoot(this.workspaceRoot, payload.projectRoot);
    for (const entry of payload.entries) {
      await this.restoreJournalBackup(root, entry);
    }
    for (const entry of payload.entries) {
      await rm(await resolveWithinRoot(root, entry.temporary), { force: true });
      const [target, backup] = await Promise.all([this.snapshotProjectFile(root, entry.target), this.snapshotProjectFile(root, entry.backup)]);
      if (target && backup && target.dev === backup.dev && target.ino === backup.ino) await rm(await resolveWithinRoot(root, entry.backup), { force: true });
    }
    const journalRoot = await resolveWithinRoot(root, `.toon-journal/${payload.outcome.operationId}`);
    await rm(journalRoot, { recursive: true, force: true });
    if (payload.removeProjectRootOnRollback && !await readSafeFile(root, PROJECT_FILE) && (await this.listProjectFiles(root).catch(() => [{ path: "unsafe" } as FileSnapshot])).length === 0) await rm(root, { recursive: true, force: true });
  }

  private async cleanupPublished(payload: JournalPayload): Promise<void> {
    const root = await resolveWithinRoot(this.workspaceRoot, payload.projectRoot);
    for (const entry of payload.entries) {
      await rm(await resolveWithinRoot(root, entry.temporary), { force: true });
      await rm(await resolveWithinRoot(root, entry.backup), { force: true });
    }
    await rm(await resolveWithinRoot(root, `.toon-journal/${payload.outcome.operationId}`), { recursive: true, force: true });
  }

  private convertCanvas(canvas: ToonCanvas, remap: Map<string, string> = new Map()): ToonWorkspaceCanvas {
    const nodeId = (id: string) => remap.get(id) ?? id;
    const handleIds = new Map<string, string>();
    for (const node of canvas.nodes) for (const handle of node.handles) handleIds.set(`${node.id}\0${handle.id}`, `${nodeId(node.id)}-${handle.id}`.slice(0, 128));
    return {
      schemaVersion: 2,
      id: canvas.id,
      nodes: canvas.nodes.map((node) => ({
        id: nodeId(node.id),
        kind: node.kind,
        position: node.position,
        handles: node.handles.map((handle) => ({ ...handle, id: handleIds.get(`${node.id}\0${handle.id}`)! })),
        config: {
          ...(node.data.label ? { label: node.data.label } : {}),
          ...(node.data.contentRef ? { content: { kind: "document" as const, id: nodeId(node.id) } } : {}),
          ...(node.data.assetRef ? { asset: { kind: "asset" as const, id: nodeId(node.id) } } : {}),
          ...(node.data.modelRef ? { model: node.data.modelRef } : {}),
        },
      })),
      edges: canvas.edges.map((edge) => ({
        ...edge,
        sourceNodeId: nodeId(edge.sourceNodeId), targetNodeId: nodeId(edge.targetNodeId),
        sourceHandleId: handleIds.get(`${edge.sourceNodeId}\0${edge.sourceHandleId}`)!,
        targetHandleId: handleIds.get(`${edge.targetNodeId}\0${edge.targetHandleId}`)!,
      })),
      viewport: canvas.viewport,
    };
  }

  private findReferences(bundle: ToonPortableProjectBundle, target: ToonPortableReference): ToonPortableReference[] {
    const results: ToonPortableReference[] = [];
    for (const canvas of Object.values(bundle.canvasFiles)) {
      for (const node of canvas.nodes) {
        const refs = [node.config.content, node.config.asset, node.config.generation, ...(node.config.references ?? [])];
        if (refs.some((ref) => ref?.kind === target.kind && ref.id === target.id)) results.push({ kind: "node", id: node.id });
      }
    }
    for (const asset of bundle.assets.assets) {
      if (asset.references.some((ref) => ref.kind === target.kind && ref.id === target.id)) results.push({ kind: "asset", id: asset.id });
    }
    for (const episode of bundle.project.workflow.episodes) {
      for (const step of episode.steps ?? []) {
        if (step.dependencyLinks.some((link) => link.target.kind === target.kind && link.target.id === target.id)) results.push({ kind: "workflow", id: step.id });
      }
    }
    for (const generation of bundle.project.workflow.generations) {
      if (generation.dependencyLinks.some((link) => link.target.kind === target.kind && link.target.id === target.id)
        || generation.plan.references.some((reference) => reference.kind === target.kind && reference.id === target.id)) results.push({ kind: "generation", id: generation.id, revision: generation.revision });
    }
    for (const adoption of bundle.project.workflow.adoptions) {
      if ([dependencyKey({ kind: "generation", id: adoption.generationId }), dependencyKey({ kind: "asset", id: adoption.assetId }), dependencyKey({ kind: "canvas", id: adoption.canvasId }), dependencyKey({ kind: "node", id: adoption.nodeId }), dependencyKey({ kind: "workflow", id: adoption.workflowRecordId })].includes(dependencyKey(target))) {
        results.push({ kind: "adoption", id: adoption.id, revision: adoption.revision });
      }
    }
    return results;
  }

  private async assetReferenceImpacts(loaded: { root: string; bundle: ToonPortableProjectBundle }, assetId: string): Promise<ToonAssetReferenceImpact[]> {
    const impacts = new Map<string, ToonAssetReferenceImpact>();
    const add = (impact: ToonAssetReferenceImpact) => impacts.set(`${impact.source}:${impact.id}`, impact);
    for (const [path, canvas] of Object.entries(loaded.bundle.canvasFiles)) {
      for (const node of canvas.nodes) {
        if (node.config.asset?.id === assetId || node.config.references?.some((ref) => ref.kind === "asset" && ref.id === assetId)) add({ source: "canvas", id: node.id, label: `${path} / ${node.config.label ?? node.id}`, historical: false });
      }
    }
    for (const document of loaded.bundle.documents.documents) {
      const bytes = await readSafeFile(loaded.root, document.path, MAX_TEXT_BYTES).catch(() => null);
      if (bytes?.toString("utf8").includes(`asset:${assetId}`)) add({ source: "document", id: document.id, label: document.title, historical: false });
    }
    for (const episode of loaded.bundle.project.workflow.episodes) for (const step of episode.steps ?? []) {
      if (step.dependencyLinks.some((link) => link.target.kind === "asset" && link.target.id === assetId)) add({ source: "workflow", id: step.id, label: step.title, historical: true });
    }
    for (const generation of loaded.bundle.project.workflow.generations) {
      if (generation.plan.references.some((ref) => ref.id === assetId) || generation.candidates.some((candidate) => candidate.assetId === assetId) || generation.dependencyLinks.some((link) => link.target.kind === "asset" && link.target.id === assetId)) add({ source: "generation", id: generation.id, label: generation.plan.object, historical: true });
    }
    for (const adoption of loaded.bundle.project.workflow.adoptions) if (adoption.assetId === assetId) add({ source: "adoption", id: adoption.id, label: adoption.id, historical: true });
    const catalogAsset = loaded.bundle.assets.assets.find((item) => item.id === assetId);
    for (const reference of catalogAsset?.references ?? []) add({ source: "catalog", id: `${reference.kind}:${reference.id}`, label: `${reference.kind}:${reference.id}`, historical: ["generation", "adoption", "workflow"].includes(reference.kind) });
    for (const reference of this.runtime.assetAssistantReferences(this.workspaceScope, loaded.bundle.project.metadata.id, assetId)) add({ source: "assistant", id: reference.messageId, label: `Conversation ${reference.conversationId}`, historical: true });
    return [...impacts.values()];
  }

  private async snapshotProjectFile(root: string, relativePath: string, includeContent = false): Promise<FileSnapshot | null> {
    const path = await resolveWithinRoot(root, relativePath);
    const handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!handle) return null;
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new ApiError(400, "path_escape", "Migration source is not a regular file");
      const content = Buffer.from(await handle.readFile());
      const after = await handle.stat();
      const [pathMetadata, canonicalRoot, canonicalPath] = await Promise.all([lstat(path), realpath(root), realpath(path)]);
      if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile() || canonicalPath !== canonicalRoot && !canonicalPath.startsWith(canonicalRoot + sep)
        || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || after.dev !== pathMetadata.dev || after.ino !== pathMetadata.ino) throw new ApiError(409, "toon_migration_source_changed", "A migration source changed while it was captured", { path: relativePath });
      return { path: relativePath, bytes: content.byteLength, revision: sha256(content), dev: Number(after.dev), ino: Number(after.ino), ...(includeContent ? { content } : {}) };
    } finally {
      await handle.close();
    }
  }

  private async listProjectFiles(root: string, includeContent = false): Promise<FileSnapshot[]> {
    const files: FileSnapshot[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new ApiError(400, "path_escape", "Migration does not follow symbolic links");
        if ([".toon-backups", ".toon-journal", ".toon-trash"].includes(entry.name)) continue;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile()) {
          const path = portablePath(relative(root, absolute));
          const snapshot = await this.snapshotProjectFile(root, path, includeContent);
          if (!snapshot) throw new ApiError(409, "toon_workspace_content_not_found", "A migration source file disappeared during preflight");
          files.push(snapshot);
        }
      }
    };
    await visit(root);
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }
}

export function toonWorkspaceFeatureExposure() {
  return {
    advancedWorkspace: process.env.JUGGLEWORK_TOON_ADVANCED_WORKSPACE !== "0",
    v2Read: true as const,
    v2Export: true as const,
    automaticDowngrade: false as const,
    toonflowImport: "disabled" as const,
  };
}
