/** @jsxImportSource react */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Command, FilePlus2, FolderPlus, History, Images, LoaderCircle, Menu, MessageSquare, Plus, Save, X } from "lucide-react";
import type { JuggleWorkServerClient, JuggleWorkServerError } from "@/app/lib/jugglework-server";
import type {
  ToonCanvasDescriptor,
  ToonCanvasFolderDescriptor,
  ToonWorkspaceCanvas,
  ToonWorkspaceCatalogsReadResponse,
  ToonWorkspaceNode,
  ToonWorkspaceOperationOutcome,
  ToonWorkspaceProjectReadResponse,
  ToonWorkspaceClientCommand,
  ToonAssetDescriptor,
  ToonWorkspaceEpisode,
  ToonWorkspaceWorkflowStep,
} from "@jugglework/types/toon-workspace";
import { TOON_CANONICAL_WORKFLOW_STAGES, TOON_CANONICAL_WORKFLOW_STEPS } from "@jugglework/types/toon-workspace";

import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { createToonCanvasHistory, recordToonCanvasHistory, type ToonCanvasHistory, type ToonCanvasSnapshot } from "../canvas/toon-canvas-domain";
import { ToonSpatialCanvas } from "../canvas/toon-spatial-canvas";
import { ToonProjectAssistant } from "./toon-project-assistant";
import { createToonDocumentRetainedState, ToonDocumentWorkspace, type ToonDocumentRetainedState } from "./toon-document-workspace";
import { toonWorkspaceRetentionKey } from "./toon-document-domain";
import { ToonAssetPanel } from "./toon-asset-panel";
import type { ConnectedTextModelOption } from "@/react-app/infra/provider-list-query";
import type { ToonAssistantAttachment, ToonAssistantCanvasProposal } from "@jugglework/types/toon-assistant";
import { clearToonRecoveryDraft, createToonGenerationGuard, readToonRecoveryDraft, registerToonWorkspaceFlusher, writeToonRecoveryDraft } from "../toon-factory-state";

type ToonWorkspaceClient = Pick<JuggleWorkServerClient,
  | "baseUrl"
  | "queryToonWorkspace"
  | "executeToonWorkspaceCommand"
  | "ensureToonWorkspaceWorkflow"
  | "approveToonWorkspaceWorkflowStep"
  | "skipToonWorkspaceWorkflowStep"
  | "deliverToonWorkspaceWorkflowStep"
  | "searchToonDocuments"
  | "listToonDocumentRevisions"
  | "restoreToonDocumentRevision"
  | "uploadToonProjectAsset"
  | "downloadToonProjectAsset"
  | "acquireToonCanvasLease"
  | "releaseToonCanvasLease"
  | "listToonCanvasCheckpoints"
  | "createToonCanvasCheckpoint"
  | "restoreToonCanvasCheckpoint"
  | "createToonAssistantConversation"
  | "listToonAssistantConversations"
  | "getToonAssistantSnapshot"
  | "updateToonAssistantConversation"
  | "deleteToonAssistantConversation"
  | "sendToonAssistantMessage"
  | "stopToonAssistantTurn"
  | "acknowledgeToonAssistantRemoteWarning"
  | "editResendToonAssistantMessage"
  | "listToonAssistantEvents"
  | "listToonAssistantCompletions"
  | "replyToonAssistantInteraction"
  | "executeToonAssistantCanvasProposal"
  | "prepareToonAssistantGeneration"
  | "authorizeToonWorkspaceGeneration"
  | "submitToonWorkspaceGeneration"
  | "getToonWorkspaceGeneration"
  | "adoptToonWorkspaceGenerationCandidate"
>;

type CanvasRuntime = {
  draft: ToonWorkspaceCanvas;
  revision: string;
  saved: string;
  selection: string[];
  history: ToonCanvasHistory;
  operationId: string | null;
  pendingDraft: ToonWorkspaceCanvas | null;
  conflict: boolean;
  compare: ToonWorkspaceCanvas | null;
  inflight: Promise<boolean> | null;
};

type RetainedWorkspace = {
  mode: "canvas" | "document";
  activeCanvasId: string | null;
  assistantOpen: boolean;
  assistantWidth: number;
  runtimes: Map<string, CanvasRuntime>;
  documents: ToonDocumentRetainedState;
};

const retained = new Map<string, RetainedWorkspace>();

function operationId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function blankCanvas(id: string): ToonWorkspaceCanvas {
  return { schemaVersion: 2, id, revisionId: operationId("revision"), nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
}

function retainedWorkspace(endpoint: string, workspaceId: string, projectId: string): RetainedWorkspace {
  const key = toonWorkspaceRetentionKey(endpoint, workspaceId, projectId);
  const current = retained.get(key);
  if (current) return current;
  const created: RetainedWorkspace = { mode: "canvas", activeCanvasId: null, assistantOpen: true, assistantWidth: 360, runtimes: new Map(), documents: createToonDocumentRetainedState() };
  retained.set(key, created);
  return created;
}

function isConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as JuggleWorkServerError).code === "toon_factory_revision_conflict");
}

export function ToonWorkspace(props: { client: ToonWorkspaceClient; workspaceId: string; projectId: string; visible: boolean; readOnly?: boolean; textModels: ConnectedTextModelOption[]; initialAssistantPrompt?: string; onInitialAssistantPromptConsumed?: () => void; onBack: () => void }) {
  const stateRef = useRef(retainedWorkspace(props.client.baseUrl, props.workspaceId, props.projectId));
  const [project, setProject] = useState<ToonWorkspaceProjectReadResponse | null>(null);
  const [catalogs, setCatalogs] = useState<ToonWorkspaceCatalogsReadResponse | null>(null);
  const [activeCanvasId, setActiveCanvasId] = useState<string | null>(stateRef.current.activeCanvasId);
  const [runtime, setRuntime] = useState<CanvasRuntime | null>(null);
  const [mode, setMode] = useState(stateRef.current.mode);
  const [assistantOpen, setAssistantOpen] = useState(stateRef.current.assistantOpen);
  const [assistantWidth, setAssistantWidth] = useState(stateRef.current.assistantWidth);
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches);
  const [saving, setSaving] = useState(false);
  const [leaseReady, setLeaseReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuCanvasId, setMenuCanvasId] = useState<string | null>(null);
  const [menuFolderId, setMenuFolderId] = useState<string | null>(null);
  const [checkpointOpen, setCheckpointOpen] = useState(false);
  const [assetOpen, setAssetOpen] = useState(false);
  const [assistantAttachment, setAssistantAttachment] = useState<ToonAssistantAttachment | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [checkpoints, setCheckpoints] = useState<Awaited<ReturnType<ToonWorkspaceClient["listToonCanvasCheckpoints"]>>["items"]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runtimeRef = useRef<CanvasRuntime | null>(null);
  const projectRef = useRef<ToonWorkspaceProjectReadResponse | null>(project);
  const catalogsRef = useRef<ToonWorkspaceCatalogsReadResponse | null>(catalogs);
  const activeCanvasRef = useRef<string | null>(activeCanvasId);
  const leaseIdRef = useRef(operationId("editor"));
  const leaseGenerationRef = useRef(createToonGenerationGuard());
  const leaseRef = useRef<{ leaseId: string; leaseToken: string; generation: number } | null>(null);
  const liveRef = useRef(true);
  const readOnlyRef = useRef(Boolean(props.readOnly));
  const flushRef = useRef<(canvasId?: string | null) => Promise<boolean>>(async () => true);
  const assistantProposalBeforeRef = useRef(new Map<string, ToonCanvasSnapshot>());
  runtimeRef.current = runtime;
  projectRef.current = project;
  catalogsRef.current = catalogs;
  activeCanvasRef.current = activeCanvasId;
  readOnlyRef.current = Boolean(props.readOnly);

  const refreshCatalogs = async () => {
    const response = await props.client.queryToonWorkspace(props.workspaceId, props.projectId, { kind: "catalogs.read" });
    if (response.kind !== "catalogs.read") throw new Error("Unexpected Toon workspace catalogs response");
    setCatalogs(response);
    catalogsRef.current = response;
    return response;
  };
  const refreshProject = async () => {
    const response = await props.client.queryToonWorkspace(props.workspaceId, props.projectId, { kind: "project.read" });
    if (response.kind !== "project.read") throw new Error("Unexpected Toon workspace project response");
    projectRef.current = response;
    setProject(response);
    return response;
  };
  const loadCanvas = async (canvasId: string, force = false) => {
    const cached = stateRef.current.runtimes.get(canvasId);
    if (cached && !force) { setRuntime(cached); return cached; }
    const response = await props.client.queryToonWorkspace(props.workspaceId, props.projectId, { kind: "canvas.read", canvasId });
    if (response.kind !== "canvas.read") throw new Error("Unexpected Toon workspace canvas response");
    const recovery = readToonRecoveryDraft({ kind: "canvas", workspaceId: props.workspaceId, projectId: props.projectId, entityId: canvasId });
    const recoveredDraft = recovery?.content && typeof recovery.content === "object" ? recovery.content as ToonWorkspaceCanvas : null;
    const revisionMismatch = Boolean(recoveredDraft && recovery?.revision !== response.revision);
    const draft = recoveredDraft ?? response.canvas;
    const history = createToonCanvasHistory(100);
    const next: CanvasRuntime = { draft, revision: response.revision, saved: JSON.stringify(response.canvas), selection: [], history: revisionMismatch ? { ...history, blocked: true } : history, operationId: null, pendingDraft: null, conflict: revisionMismatch, compare: revisionMismatch ? response.canvas : null, inflight: null };
    stateRef.current.runtimes.set(canvasId, next);
    if (activeCanvasRef.current === canvasId) setRuntime(next);
    return next;
  };

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void Promise.all([refreshProject(), refreshCatalogs()]).then(async ([loadedProject, nextCatalogs]) => {
      if (cancelled) return;
      let nextProject = loadedProject;
      const canonicalIds = new Set<string>(TOON_CANONICAL_WORKFLOW_STEPS.map((step) => step.id));
      const hasCanonicalWorkflow = nextProject.project.workflow.episodes.some((episode) => canonicalIds.size === new Set((episode.steps ?? []).filter((step) => canonicalIds.has(step.id)).map((step) => step.id)).size);
      if (!props.readOnly && !hasCanonicalWorkflow) {
        await props.client.ensureToonWorkspaceWorkflow(props.workspaceId, props.projectId, { operationId: `ensure-workflow-${nextProject.revision.slice(0, 24)}`, expectedRevision: nextProject.revision, actor: { kind: "human" }, origin: "human-ui" });
        nextProject = await refreshProject();
      }
      const active = stateRef.current.activeCanvasId && nextCatalogs.canvases.canvases.some((item) => item.id === stateRef.current.activeCanvasId && item.state === "active")
        ? stateRef.current.activeCanvasId
        : nextProject.project.activeCanvasId ?? nextCatalogs.canvases.canvases.find((item) => item.state === "active")?.id ?? null;
      stateRef.current.activeCanvasId = active;
      setActiveCanvasId(active);
      activeCanvasRef.current = active;
      if (active) await loadCanvas(active);
    }).catch((cause) => !cancelled && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => { cancelled = true; };
  }, [props.projectId, props.workspaceId]);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const change = () => setNarrow(query.matches);
    change(); query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!props.visible) return;
    const key = (event: globalThis.KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !target?.closest("input,textarea,select,[contenteditable=true]")) {
        event.preventDefault(); setCommandOpen(true);
      } else if (event.key === "Escape") setCommandOpen(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [props.visible]);

  const execute = async (command: Parameters<ToonWorkspaceClient["executeToonWorkspaceCommand"]>[2]): Promise<ToonWorkspaceOperationOutcome> => {
    if (readOnlyRef.current || !leaseReady) throw new Error(t("toon_factory.lease_read_only"));
    const outcome = await props.client.executeToonWorkspaceCommand(props.workspaceId, props.projectId, command);
    await Promise.all([refreshProject(), refreshCatalogs()]);
    return outcome;
  };
  const flush = async (requestedCanvasId: string | null = activeCanvasRef.current): Promise<boolean> => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const canvasId = requestedCanvasId;
    const current = canvasId ? stateRef.current.runtimes.get(canvasId) ?? (activeCanvasRef.current === canvasId ? runtimeRef.current : null) : null;
    if (!current || !canvasId || current.conflict || JSON.stringify(current.draft) === current.saved) return !current?.conflict;
    if (current.inflight) {
      await current.inflight;
      return flush(canvasId);
    }
    if (readOnlyRef.current || !leaseRef.current || !leaseReady || activeCanvasRef.current !== canvasId) return false;
    if (liveRef.current) setSaving(true);
    const op = current.operationId ?? operationId("autosave");
    current.operationId = op;
    const body = current.pendingDraft ?? structuredClone(current.draft);
    current.pendingDraft = body;
    const descriptor = catalogsRef.current?.canvases.canvases.find((item) => item.id === canvasId);
    if (!descriptor) { if (liveRef.current) setSaving(false); return false; }
    const lease = leaseRef.current;
    const promise = (async () => { try {
      const outcome = await props.client.executeToonWorkspaceCommand(props.workspaceId, props.projectId, {
        operationId: op, expectedRevisions: { [descriptor.file]: current.revision }, kind: "canvas.write", canvasId, body,
        leaseToken: lease.leaseToken, leaseGeneration: lease.generation,
      });
      const latest = stateRef.current.runtimes.get(canvasId) ?? current;
      latest.revision = outcome.revisions[descriptor.file] ?? latest.revision;
      latest.saved = JSON.stringify(body);
      latest.operationId = null;
      latest.pendingDraft = null;
      latest.conflict = false;
      latest.compare = null;
      clearToonRecoveryDraft({ kind: "canvas", workspaceId: props.workspaceId, projectId: props.projectId, entityId: canvasId });
      stateRef.current.runtimes.set(canvasId, latest);
      if (liveRef.current && activeCanvasRef.current === canvasId) setRuntime({ ...latest });
      await Promise.all([refreshProject(), refreshCatalogs()]);
      if (liveRef.current) setError(null);
      if (JSON.stringify(latest.draft) !== latest.saved) scheduleSave();
      return true;
    } catch (cause) {
      writeToonRecoveryDraft({ kind: "canvas", workspaceId: props.workspaceId, projectId: props.projectId, entityId: canvasId, revision: current.revision, content: current.draft, updatedAt: new Date().toISOString() });
      if (isConflict(cause)) {
        const latest = await props.client.queryToonWorkspace(props.workspaceId, props.projectId, { kind: "canvas.read", canvasId }).catch(() => null);
        const retainedRuntime = stateRef.current.runtimes.get(canvasId) ?? current;
        retainedRuntime.conflict = true;
        retainedRuntime.history = { ...retainedRuntime.history, blocked: true };
        retainedRuntime.compare = latest?.kind === "canvas.read" ? latest.canvas : null;
        stateRef.current.runtimes.set(canvasId, retainedRuntime);
        if (liveRef.current && activeCanvasRef.current === canvasId) setRuntime({ ...retainedRuntime });
      }
      if (liveRef.current) setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      current.inflight = null;
      if (liveRef.current) setSaving(false);
    } })();
    current.inflight = promise;
    return promise;
  };
  flushRef.current = flush;
  const flushAll = async (): Promise<boolean> => {
    if (stateRef.current.documents.flushAllDirtyTabs && !await stateRef.current.documents.flushAllDirtyTabs()) return false;
    return flushRef.current();
  };
  const scheduleSave = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flushRef.current(), 650);
  };
  const changeRuntime = (snapshot: ToonCanvasSnapshot, history: ToonCanvasHistory) => {
    const canvasId = activeCanvasRef.current;
    const current = runtimeRef.current;
    if (!canvasId || !current || current.conflict || readOnlyRef.current || !leaseReady) return;
    const next = { ...current, draft: snapshot.canvas, selection: snapshot.selection, history };
    writeToonRecoveryDraft({ kind: "canvas", workspaceId: props.workspaceId, projectId: props.projectId, entityId: canvasId, revision: current.revision, content: snapshot.canvas, updatedAt: new Date().toISOString() });
    stateRef.current.runtimes.set(canvasId, next);
    setRuntime(next);
    scheduleSave();
  };
  const beforeAssistantProposalExecute = async (proposal: ToonAssistantCanvasProposal): Promise<boolean> => {
    if (proposal.command.kind !== "canvas.write") return true;
    if (activeCanvasRef.current === proposal.command.canvasId && !await flush()) return false;
    const response = await props.client.queryToonWorkspace(props.workspaceId, props.projectId, { kind: "canvas.read", canvasId: proposal.command.canvasId });
    if (response.kind !== "canvas.read") return false;
    const current = stateRef.current.runtimes.get(proposal.command.canvasId);
    assistantProposalBeforeRef.current.set(proposal.id, { canvas: response.canvas, selection: current?.selection ?? [] });
    return true;
  };
  const assistantProposalCommitted = async (proposal: ToonAssistantCanvasProposal) => {
    if (proposal.command.kind !== "canvas.write") {
      await Promise.all([refreshProject(), refreshCatalogs()]);
      return;
    }
    const response = await props.client.queryToonWorkspace(props.workspaceId, props.projectId, { kind: "canvas.read", canvasId: proposal.command.canvasId });
    if (response.kind !== "canvas.read") return;
    const previous = assistantProposalBeforeRef.current.get(proposal.id);
    assistantProposalBeforeRef.current.delete(proposal.id);
    const current = stateRef.current.runtimes.get(proposal.command.canvasId);
    const selection = current?.selection ?? previous?.selection ?? [];
    const before = previous ?? { canvas: current?.draft ?? response.canvas, selection };
    const after = { canvas: response.canvas, selection };
    const next: CanvasRuntime = {
      draft: response.canvas,
      revision: response.revision,
      saved: JSON.stringify(response.canvas),
      selection,
      history: recordToonCanvasHistory(current?.history ?? createToonCanvasHistory(100), before, after, { label: `Assistant: ${proposal.summary}` }),
      operationId: null,
      pendingDraft: null,
      conflict: false,
      compare: null,
      inflight: null,
    };
    stateRef.current.runtimes.set(proposal.command.canvasId, next);
    if (activeCanvasRef.current === proposal.command.canvasId) setRuntime({ ...next });
    await Promise.all([refreshProject(), refreshCatalogs()]);
  };
  const selectCanvas = async (canvasId: string) => {
    if (canvasId === activeCanvasRef.current) return;
    if (!(await flushAll())) return;
    activeCanvasRef.current = canvasId;
    stateRef.current.activeCanvasId = canvasId;
    setActiveCanvasId(canvasId);
    setRuntime(stateRef.current.runtimes.get(canvasId) ?? null);
    await loadCanvas(canvasId);
    const currentProject = projectRef.current;
    if (currentProject && leaseReady) {
      const outcome = await props.client.executeToonWorkspaceCommand(props.workspaceId, props.projectId, { operationId: operationId("active-canvas"), expectedRevisions: { "toon-project.json": currentProject.revision }, kind: "project.update", activeCanvasId: canvasId });
      const nextProject = { ...currentProject, project: { ...currentProject.project, activeCanvasId: canvasId }, revision: outcome.revisions["toon-project.json"] ?? currentProject.revision };
      projectRef.current = nextProject;
      setProject(nextProject);
    }
  };

  useEffect(() => {
    if (!props.visible || props.readOnly || !activeCanvasId) return;
    const generation = leaseGenerationRef.current.next();
    leaseIdRef.current = operationId("editor");
    const leaseId = leaseIdRef.current;
    setLeaseReady(false);
    leaseRef.current = null;
    const renew = () => props.client.acquireToonCanvasLease(props.workspaceId, props.projectId, activeCanvasId, { leaseId, holder: "toon-workspace", ttlMs: 45_000 }).then((response) => {
      if (!leaseGenerationRef.current.isCurrent(generation) || activeCanvasRef.current !== activeCanvasId) return;
      leaseRef.current = { leaseId: response.leaseId, leaseToken: response.leaseToken, generation: response.generation };
      setLeaseReady(true);
    }).catch((cause) => { if (leaseGenerationRef.current.isCurrent(generation)) { leaseRef.current = null; setLeaseReady(false); setError(cause instanceof Error ? cause.message : String(cause)); } });
    void renew();
    const timer = setInterval(() => void renew(), 20_000);
    return () => {
      leaseGenerationRef.current.invalidate();
      clearInterval(timer);
      void flushAll().finally(() => {
        leaseRef.current = null;
        if (liveRef.current) setLeaseReady(false);
        return props.client.releaseToonCanvasLease(props.workspaceId, props.projectId, activeCanvasId, leaseId);
      });
    };
  }, [props.visible, props.readOnly, activeCanvasId, props.projectId, props.workspaceId]);

  useEffect(() => {
    if (!props.visible) void flushAll();
  }, [props.visible]);
  useEffect(() => registerToonWorkspaceFlusher(toonWorkspaceRetentionKey(props.client.baseUrl, props.workspaceId, props.projectId), flushAll), [props.client.baseUrl, props.workspaceId, props.projectId]);
  useEffect(() => () => {
    liveRef.current = false;
    const current = runtimeRef.current;
    const canvasId = activeCanvasRef.current;
    if (current && canvasId && JSON.stringify(current.draft) !== current.saved) writeToonRecoveryDraft({ kind: "canvas", workspaceId: props.workspaceId, projectId: props.projectId, entityId: canvasId, revision: current.revision, content: current.draft, updatedAt: new Date().toISOString() });
    void flushAll();
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  const catalogRevision = catalogs?.revisions["catalogs/canvases.json"];
  const commandEnvelope = (): Pick<ToonWorkspaceClientCommand, "operationId" | "expectedRevisions"> => ({ operationId: operationId("workspace"), expectedRevisions: catalogRevision ? { "catalogs/canvases.json": catalogRevision } : {} });
  const createCanvas = async (folderId?: string) => {
    const canvasId = operationId("canvas");
    const title = window.prompt(t("toon_factory.canvas_name"), t("toon_factory.untitled_canvas"));
    if (!title) return;
    await execute({ ...commandEnvelope(), kind: "canvas.create", canvas: { id: canvasId, title, kind: "freeform", ...(folderId ? { folderId } : {}), order: catalogs?.canvases.canvases.length ?? 0, file: `canvases/${canvasId}.json`, state: "active" }, body: blankCanvas(canvasId) });
    await selectCanvas(canvasId);
  };
  const createFolder = async () => {
    const title = window.prompt(t("toon_factory.folder_name"), t("toon_factory.untitled_folder"));
    if (!title) return;
    await execute({ ...commandEnvelope(), kind: "folder.create", folder: { id: operationId("folder"), title, order: catalogs?.canvases.folders.length ?? 0, state: "active" } });
  };
  const canvasAction = async (descriptor: ToonCanvasDescriptor, action: "rename" | "duplicate" | "delete" | "restore" | "move-up" | "move-down") => {
    if (action === "rename") { const title = window.prompt(t("toon_factory.canvas_name"), descriptor.title); if (title) await execute({ ...commandEnvelope(), kind: "canvas.rename", canvasId: descriptor.id, title }); }
    if (action === "duplicate") await execute({ ...commandEnvelope(), kind: "canvas.duplicate", canvasId: descriptor.id, newCanvasId: operationId("canvas"), title: `${descriptor.title} ${t("toon_factory.copy_suffix")}` });
    if (action === "delete") {
      if (!(await flush())) return;
      const fallback = canvases.find((item) => item.id !== descriptor.id && item.state === "active")?.id ?? null;
      await execute({ ...commandEnvelope(), kind: "canvas.delete", canvasId: descriptor.id });
      if (descriptor.id === activeCanvasId) {
        if (fallback) await selectCanvas(fallback);
        else { activeCanvasRef.current = null; stateRef.current.activeCanvasId = null; setActiveCanvasId(null); setRuntime(null); }
      }
    }
    if (action === "restore") await execute({ ...commandEnvelope(), kind: "canvas.restore", canvasId: descriptor.id });
    if (action === "move-up" || action === "move-down") {
      const siblings = (catalogs?.canvases.canvases ?? []).filter((item) => item.state === "active" && (item.folderId ?? null) === (descriptor.folderId ?? null)).sort((a, b) => a.order - b.order);
      const index = siblings.findIndex((item) => item.id === descriptor.id); const target = action === "move-up" ? index - 1 : index + 1;
      if (target >= 0 && target < siblings.length) { [siblings[index], siblings[target]] = [siblings[target]!, siblings[index]!]; await execute({ ...commandEnvelope(), kind: "canvas.reorder", canvasIds: siblings.map((item) => item.id), ...(descriptor.folderId ? { folderId: descriptor.folderId } : {}) }); }
    }
    setMenuCanvasId(null);
  };
  const folderAction = async (folder: ToonCanvasFolderDescriptor, action: "rename" | "delete" | "restore" | "move-up" | "move-down") => {
    if (action === "rename") { const title = window.prompt(t("toon_factory.folder_name"), folder.title); if (title) await execute({ ...commandEnvelope(), kind: "folder.rename", folderId: folder.id, title }); }
    if (action === "delete") {
      const children = canvases.filter((item) => item.folderId === folder.id && item.state === "active");
      const recursive = children.length > 0 && window.confirm(t("toon_factory.delete_folder_with_canvases"));
      if (children.length > 0 && !recursive) return;
      await execute({ ...commandEnvelope(), kind: "folder.delete", folderId: folder.id, recursive });
    }
    if (action === "restore") await execute({ ...commandEnvelope(), kind: "folder.restore", folderId: folder.id });
    if (action === "move-up" || action === "move-down") {
      const ordered = folders.filter((item) => item.state === "active");
      const index = ordered.findIndex((item) => item.id === folder.id); const target = action === "move-up" ? index - 1 : index + 1;
      if (target >= 0 && target < ordered.length) { [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!]; await execute({ ...commandEnvelope(), kind: "folder.reorder", folderIds: ordered.map((item) => item.id) }); }
    }
    setMenuFolderId(null);
  };
  const moveCanvas = async (descriptor: ToonCanvasDescriptor, folderId: string | null) => execute({ ...commandEnvelope(), kind: "canvas.move", canvasId: descriptor.id, folderId, order: 0 });
  const openCheckpoints = async () => {
    if (!activeCanvasId) return;
    if (!(await flush())) return;
    setCheckpoints((await props.client.listToonCanvasCheckpoints(props.workspaceId, props.projectId, activeCanvasId)).items);
    setCheckpointOpen(true);
  };
  const createCheckpoint = async () => {
    if (!activeCanvasId || !runtime || props.readOnly || !leaseReady) return;
    const title = window.prompt(t("toon_factory.checkpoint_name"), new Date().toLocaleString());
    if (!title) return;
    await props.client.createToonCanvasCheckpoint(props.workspaceId, props.projectId, activeCanvasId, { operationId: operationId("checkpoint"), expectedRevision: runtime.revision, title, actor: { kind: "human" }, origin: "human-ui" });
    setCheckpoints((await props.client.listToonCanvasCheckpoints(props.workspaceId, props.projectId, activeCanvasId)).items);
  };
  const reloadConflict = async () => { if (activeCanvasId) { clearToonRecoveryDraft({ kind: "canvas", workspaceId: props.workspaceId, projectId: props.projectId, entityId: activeCanvasId }); await loadCanvas(activeCanvasId, true); } };
  const rebaseConflict = () => {
    if (!activeCanvasId || !runtime?.compare) return;
    const next = { ...runtime, conflict: false, compare: null, history: { ...runtime.history, blocked: false }, operationId: null, pendingDraft: null };
    stateRef.current.runtimes.set(activeCanvasId, next); setRuntime(next); scheduleSave();
  };
  const conflictCopy = async () => {
    if (readOnlyRef.current || !activeCanvasId || !runtime || !catalogs) return;
    const newCanvasId = operationId("canvas");
    const source = catalogs.canvases.canvases.find((item) => item.id === activeCanvasId)!;
    const { revision: _revision, ...sourceWithoutRevision } = source;
    const outcome = await props.client.executeToonWorkspaceCommand(props.workspaceId, props.projectId, { ...commandEnvelope(), kind: "canvas.create", canvas: { ...sourceWithoutRevision, id: newCanvasId, title: `${source.title} ${t("toon_factory.conflict_copy")}`, file: `canvases/${newCanvasId}.json`, state: "active" }, body: { ...runtime.draft, id: newCanvasId, revisionId: operationId("revision") } });
    void outcome;
    await Promise.all([refreshProject(), refreshCatalogs()]);
    await selectCanvas(newCanvasId);
  };
  const importFiles = async (files: File[], position: { x: number; y: number }) => {
    if (readOnlyRef.current || !leaseReady) throw new Error(t("toon_factory.lease_read_only"));
    if (files.length !== 1) throw new Error("Import one file at a time so the asset and node remain atomic.");
    if (!activeCanvasId || !runtime) throw new Error("Open a canvas before importing an asset.");
    if (!(await flush())) throw new Error("Resolve the canvas conflict before importing an asset.");
    const file = files[0]!;
    const outcome = await props.client.uploadToonProjectAsset(props.workspaceId, props.projectId, file, { operationId: operationId("asset-canvas-import"), assetId: operationId("asset"), filename: file.name, ...(file.type ? { declaredMimeType: file.type } : {}), origin: "imported", actor: { kind: "human" }, canvas: { id: activeCanvasId, expectedRevision: runtime.revision, position } });
    const result = outcome.result as { nodeId?: string } | undefined;
    await Promise.all([refreshProject(), refreshCatalogs(), loadCanvas(activeCanvasId, true)]);
    if (result?.nodeId) setRuntime((current) => current ? { ...current, selection: [result.nodeId!] } : current);
  };
  const reuseAsset = (asset: ToonAssetDescriptor) => {
    if (!runtime || readOnlyRef.current || !leaseReady) return;
    const dataType: "image" | "video" | "text" | null = asset.mimeType.startsWith("image/") ? "image" : asset.mimeType.startsWith("video/") ? "video" : asset.mimeType.startsWith("text/") ? "text" : null;
    if (!dataType) return;
    const nodeId = operationId("asset-node");
    const kind: ToonWorkspaceNode["kind"] = dataType === "image" ? "image-asset" : dataType === "video" ? "video-asset" : "text";
    const node: ToonWorkspaceNode = { id: nodeId, kind, position: { x: 100, y: 100 }, handles: [{ id: `${nodeId}-in`, direction: "target", dataType }, { id: `${nodeId}-out`, direction: "source", dataType }], config: { label: asset.title, asset: { kind: "asset", id: asset.id, revision: asset.checksum } } };
    const next: ToonCanvasSnapshot = { canvas: { ...runtime.draft, nodes: [...runtime.draft.nodes, node] }, selection: [nodeId] };
    changeRuntime(next, recordToonCanvasHistory(runtime.history, { canvas: runtime.draft, selection: runtime.selection }, next, { label: "Reuse asset" }));
    setAssetOpen(false);
  };
  const attachAsset = (asset: ToonAssetDescriptor) => {
    setAssistantAttachment({ id: operationId("attachment"), kind: "asset", targetId: asset.id, revision: asset.checksum, label: asset.title, mimeType: asset.mimeType });
    stateRef.current.assistantOpen = true; setAssistantOpen(true); setAssetOpen(false);
  };

  const workflowEpisode = project?.project.workflow.episodes.find((episode) => episode.canvasId === activeCanvasId) ?? project?.project.workflow.episodes[0] ?? null;
  const workflowCanvas = workflowEpisode ? catalogs?.canvases.canvases.find((canvas) => canvas.id === workflowEpisode.canvasId) : null;
  const workflowEvidence = workflowCanvas && runtime?.draft.nodes.length
    ? { target: { kind: "canvas" as const, id: workflowCanvas.id }, revision: workflowCanvas.revision }
    : catalogs?.documents.documents.find((document) => document.state === "active")
      ? (() => { const document = catalogs.documents.documents.find((item) => item.state === "active")!; return { target: { kind: "document" as const, id: document.id }, revision: document.revision }; })()
      : catalogs?.assets.assets.find((asset) => asset.state === "active")
        ? (() => { const asset = catalogs.assets.assets.find((item) => item.state === "active")!; return { target: { kind: "asset" as const, id: asset.id }, revision: asset.checksum }; })()
        : null;

  if (!project || !catalogs) return <div className="flex h-full items-center justify-center gap-2 text-xs text-dls-secondary"><LoaderCircle className="size-4 animate-spin" />{error ?? t("toon_factory.loading_project")}</div>;
  const workspaceReadOnly = Boolean(props.readOnly || !leaseReady);
  const folders = [...catalogs.canvases.folders].sort((a, b) => a.order - b.order);
  const canvases = [...catalogs.canvases.canvases].sort((a, b) => a.order - b.order);
  const renderCanvas = (descriptor: ToonCanvasDescriptor) => <div key={descriptor.id} className="group relative flex items-center gap-1">
    <button type="button" onClick={() => void selectCanvas(descriptor.id)} aria-pressed={descriptor.id === activeCanvasId} className={cn("min-w-0 flex-1 truncate rounded-lg px-2 py-1.5 text-left text-[11px]", descriptor.id === activeCanvasId ? "bg-dls-active font-semibold text-dls-accent" : "text-dls-secondary hover:bg-dls-hover")}>{descriptor.title}</button>
    <button type="button" disabled={!leaseReady} title={!leaseReady ? t("toon_factory.lease_read_only") : undefined} aria-label={t("toon_factory.canvas_actions")} onClick={() => setMenuCanvasId(menuCanvasId === descriptor.id ? null : descriptor.id)} className="rounded p-1 text-dls-secondary opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-30"><Menu className="size-3" /></button>
    {menuCanvasId === descriptor.id ? <div role="menu" className="absolute left-full top-0 z-40 ml-1 w-40 rounded-xl border border-dls-border bg-background p-1 shadow-lg" data-canvas-shortcuts="disabled">
      {(["rename", "duplicate", descriptor.state === "active" ? "delete" : "restore", "move-up", "move-down"] as const).map((action) => <button key={action} role="menuitem" type="button" disabled={!leaseReady} onClick={() => void canvasAction(descriptor, action)} className="block w-full rounded-lg px-2 py-1.5 text-left text-[10px] hover:bg-dls-hover disabled:opacity-40">{t(`toon_factory.canvas_action_${action.replace("-", "_")}`)}</button>)}
      <label className="block border-t border-dls-border px-2 pt-1 text-[9px] text-dls-secondary">{t("toon_factory.move_to_folder")}<select value={descriptor.folderId ?? ""} disabled={!leaseReady} onChange={(event) => void moveCanvas(descriptor, event.target.value || null)} className="mt-1 w-full rounded border border-dls-border bg-background p-1 disabled:opacity-40"><option value="">{t("toon_factory.no_folder")}</option>{folders.filter((folder) => folder.state === "active").map((folder) => <option key={folder.id} value={folder.id}>{folder.title}</option>)}</select></label>
    </div> : null}
  </div>;

  return <div className="relative flex h-full min-h-0 bg-[var(--app-page-bg)]" data-testid="toon-v2-workspace">
    <div className="sr-only" role="status" aria-live="polite">{error ?? (runtime?.conflict ? t("toon_factory.save_conflict") : saving ? t("toon_factory.saving") : `${mode === "canvas" ? t("toon_factory.canvas") : t("toon_factory.document")} · ${t("toon_factory.saved")}`)}</div>
    <aside className="z-20 m-3 mr-0 flex w-52 shrink-0 flex-col rounded-2xl border border-dls-border bg-background/95 p-2 shadow-md backdrop-blur" data-testid="toon-canvas-navigator">
      <div className="flex items-center justify-between gap-2 px-1 py-1"><button type="button" onClick={() => void flushAll().then((ok) => { if (ok) props.onBack(); })} className="min-w-0 truncate text-left text-xs font-semibold text-dls-text">{project.project.metadata.name}</button><div className="flex"><button type="button" disabled={!leaseReady} onClick={() => void createFolder()} title={!leaseReady ? t("toon_factory.lease_read_only") : t("toon_factory.create_folder")} className="rounded p-1.5 text-dls-secondary hover:bg-dls-hover disabled:opacity-30"><FolderPlus className="size-3.5" /></button><button type="button" disabled={!leaseReady} onClick={() => void createCanvas()} title={!leaseReady ? t("toon_factory.lease_read_only") : t("toon_factory.create_canvas")} className="rounded p-1.5 text-dls-secondary hover:bg-dls-hover disabled:opacity-30"><FilePlus2 className="size-3.5" /></button></div></div>
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto" aria-disabled={!leaseReady}>
        <div className="space-y-0.5">{canvases.filter((canvas) => canvas.state === "active" && !canvas.folderId).map(renderCanvas)}</div>
        {folders.map((folder) => <section key={folder.id} className={cn("relative mt-2", folder.state === "trashed" && "border-t border-dls-border pt-2 opacity-70")}><div className="flex items-center justify-between px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-dls-secondary"><span className="truncate">{folder.title}</span><span className="flex"><button type="button" onClick={() => void createCanvas(folder.id)} disabled={!leaseReady || folder.state === "trashed"} title={!leaseReady ? t("toon_factory.lease_read_only") : t("toon_factory.create_canvas")}><Plus className="size-3" /></button><button type="button" disabled={!leaseReady} title={!leaseReady ? t("toon_factory.lease_read_only") : undefined} onClick={() => setMenuFolderId(menuFolderId === folder.id ? null : folder.id)} aria-label={t("toon_factory.folder_actions")}><Menu className="size-3" /></button></span></div>{menuFolderId === folder.id ? <div role="menu" className="absolute left-full top-0 z-40 ml-1 w-36 rounded-xl border border-dls-border bg-background p-1 shadow-lg" data-canvas-shortcuts="disabled">{(["rename", folder.state === "active" ? "delete" : "restore", "move-up", "move-down"] as const).map((action) => <button key={action} role="menuitem" type="button" disabled={!leaseReady} onClick={() => void folderAction(folder, action)} className="block w-full rounded-lg px-2 py-1.5 text-left text-[10px] hover:bg-dls-hover disabled:opacity-40">{t(`toon_factory.canvas_action_${action.replace("-", "_")}`)}</button>)}</div> : null}<div className="space-y-0.5">{canvases.filter((canvas) => canvas.folderId === folder.id && canvas.state === "active").map(renderCanvas)}</div></section>)}
        {canvases.some((canvas) => canvas.state === "trashed") ? <section className="mt-4 border-t border-dls-border pt-2"><div className="px-2 text-[10px] font-semibold text-dls-secondary">{t("toon_factory.trash")}</div>{canvases.filter((canvas) => canvas.state === "trashed").map(renderCanvas)}</section> : null}
        {workflowEpisode ? <WorkflowStatusPanel client={props.client} workspaceId={props.workspaceId} projectId={props.projectId} projectRevision={project.revision} episode={workflowEpisode} evidence={workflowEvidence} readOnly={workspaceReadOnly} onChanged={refreshProject} /> : null}
      </div>
    </aside>
    <main className="relative min-w-0 flex-1">
      <header className="absolute left-3 right-3 top-3 z-30 flex h-11 items-center justify-between rounded-2xl border border-dls-border bg-background/95 px-3 shadow-md backdrop-blur">
        <div className="flex rounded-lg bg-dls-hover p-0.5"><button type="button" aria-pressed={mode === "canvas"} onClick={() => { void stateRef.current.documents.flushAllDirtyTabs?.().then((ok) => { if (ok) { stateRef.current.mode = "canvas"; setMode("canvas"); } }); }} className={cn("rounded-md px-3 py-1 text-[10px]", mode === "canvas" && "bg-background font-semibold text-dls-accent")}>{t("toon_factory.canvas")}</button><button type="button" aria-pressed={mode === "document"} onClick={() => { void flush().then((ok) => { if (ok) { stateRef.current.mode = "document"; setMode("document"); } }); }} className={cn("rounded-md px-3 py-1 text-[10px]", mode === "document" && "bg-background font-semibold text-dls-accent")}>{t("toon_factory.document")}</button></div>
        <div className="flex items-center gap-2"><span role="status" className={cn("flex items-center gap-1 text-[10px]", runtime?.conflict ? "text-destructive" : "text-dls-secondary")}><Save className="size-3" />{runtime?.conflict ? t("toon_factory.save_conflict") : saving ? t("toon_factory.saving") : t("toon_factory.saved")}</span><button type="button" onClick={() => setCommandOpen(true)} aria-label={t("toon_factory.command_menu")} title={`${t("toon_factory.command_menu")} (⌘K)`}><Command className="size-4" /></button><button type="button" onClick={() => setAssetOpen(!assetOpen)} aria-pressed={assetOpen} title={t("toon_factory.project_assets")}><Images className="size-4" /></button><button type="button" onClick={() => void openCheckpoints()} title={t("toon_factory.checkpoints")}><History className="size-4" /></button><button type="button" onClick={() => { stateRef.current.assistantOpen = !assistantOpen; setAssistantOpen(!assistantOpen); }} aria-label={assistantOpen ? t("toon_factory.close_assistant") : t("toon_factory.open_assistant")} aria-pressed={assistantOpen}><MessageSquare className="size-4" /></button></div>
      </header>
      {!leaseReady ? <div className="absolute left-3 right-3 top-16 z-30 rounded-xl border border-amber-500/40 bg-background p-3 text-xs text-amber-700 shadow-md" role="alert">{t("toon_factory.lease_read_only")}{runtime && JSON.stringify(runtime.draft) !== runtime.saved ? <button type="button" onClick={() => void conflictCopy()} className="ml-2 rounded border px-2 py-1">{t("toon_factory.save_conflict_copy")}</button> : null}</div> : null}
      {runtime?.conflict ? <div className="absolute left-3 right-3 top-16 z-30 rounded-xl border border-amber-500/40 bg-background p-3 text-xs text-amber-700 shadow-md" role="alert"><strong>{t("toon_factory.save_conflict")}</strong><span className="ml-2">{t("toon_factory.conflict_description")}</span><div className="mt-2 flex gap-2"><button type="button" onClick={() => void reloadConflict()} className="rounded border px-2 py-1">{t("toon_factory.discard_draft")}</button><button type="button" onClick={() => setCheckpointOpen(true)} className="rounded border px-2 py-1">{t("toon_factory.compare")}</button><button type="button" onClick={() => void conflictCopy()} className="rounded border px-2 py-1">{t("toon_factory.save_conflict_copy")}</button><button type="button" disabled={!leaseReady} onClick={rebaseConflict} className="rounded border px-2 py-1 disabled:opacity-40">{t("toon_factory.rebase_draft")}</button></div></div> : null}
      <div className={cn("grid h-full min-h-0", assistantOpen ? "grid-cols-[minmax(0,1fr)_var(--assistant-width)] max-[900px]:grid-cols-1" : "grid-cols-1")} style={{ "--assistant-width": `${assistantWidth}px` } as CSSProperties}>
        <section className="relative min-h-0 overflow-hidden">
          <div className={cn("h-full", mode !== "canvas" && "hidden")} aria-hidden={mode !== "canvas"}>{runtime ? <ToonSpatialCanvas canvas={runtime.draft} selection={runtime.selection} history={runtime.history} conflict={runtime.conflict} readOnly={workspaceReadOnly} visible={props.visible && mode === "canvas"} assistantWidth={assistantOpen ? assistantWidth : 0} onChange={changeRuntime} onImportFiles={importFiles} /> : null}</div>
          <div className={cn("h-full", mode !== "document" && "hidden")} aria-hidden={mode !== "document"} data-testid="toon-v2-document-retained"><ToonDocumentWorkspace client={props.client} workspaceId={props.workspaceId} projectId={props.projectId} visible={props.visible && mode === "document"} readOnly={workspaceReadOnly} catalogs={catalogs} retained={stateRef.current.documents} onCatalogsChange={refreshCatalogs} /></div>
        </section>
        {assistantOpen ? <aside className="relative m-3 ml-0 mt-[68px] min-h-0 rounded-2xl border border-dls-border bg-background/95 p-3 shadow-lg max-[900px]:absolute max-[900px]:inset-x-3 max-[900px]:bottom-3 max-[900px]:z-30 max-[900px]:m-0 max-[900px]:max-h-[65%]" role="complementary" aria-label={t("toon_factory.assistant_title")} data-testid="toon-v2-assistant"><div onPointerDown={(event) => { if (workspaceReadOnly) return; const start = event.clientX; const width = assistantWidth; const move = (moveEvent: PointerEvent) => { const next = Math.max(280, Math.min(520, width + start - moveEvent.clientX)); stateRef.current.assistantWidth = next; setAssistantWidth(next); }; const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); }; window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); }} className={cn("absolute inset-y-4 -left-1 w-2 max-[900px]:hidden", workspaceReadOnly ? "cursor-not-allowed" : "cursor-col-resize")} /><ToonProjectAssistant client={props.client} workspaceId={props.workspaceId} projectId={props.projectId} visible={props.visible && assistantOpen} readOnly={workspaceReadOnly} canvasLease={leaseRef.current ? { token: leaseRef.current.leaseToken, generation: leaseRef.current.generation } : null} narrow={narrow} textModels={props.textModels} defaultModel={project.project.modelDefaults?.text} initialPrompt={props.initialAssistantPrompt} onInitialPromptConsumed={props.onInitialAssistantPromptConsumed} pendingAttachment={assistantAttachment} onPendingAttachmentConsumed={() => setAssistantAttachment(null)} beforeCanvasProposalExecute={beforeAssistantProposalExecute} onCanvasProposalCommitted={assistantProposalCommitted} onClose={() => { stateRef.current.assistantOpen = false; setAssistantOpen(false); }} /></aside> : null}
      </div>
    </main>
    {assetOpen ? <ToonAssetPanel client={props.client} workspaceId={props.workspaceId} projectId={props.projectId} readOnly={workspaceReadOnly} assets={catalogs.assets.assets} catalogRevision={catalogs.revisions["catalogs/assets.json"]} onClose={() => setAssetOpen(false)} onChanged={async () => { await refreshCatalogs(); }} onReuse={reuseAsset} onAttach={attachAsset} /> : null}
    {commandOpen ? <div className="absolute inset-0 z-[60] flex items-start justify-center bg-black/20 p-6 pt-24 motion-reduce:transition-none" role="dialog" aria-modal="true" aria-label={t("toon_factory.command_menu")} data-canvas-shortcuts="disabled"><div className="w-full max-w-md rounded-2xl border border-dls-border bg-background p-2 shadow-xl"><div className="flex items-center justify-between px-2 py-2"><strong className="text-xs">{t("toon_factory.command_menu")}</strong><button type="button" aria-label={t("toon_factory.close_command_menu")} onClick={() => setCommandOpen(false)}><X className="size-4" /></button></div>{[
      { label: t("toon_factory.canvas"), run: () => { void stateRef.current.documents.flushAllDirtyTabs?.().then((ok) => { if (ok) { stateRef.current.mode = "canvas"; setMode("canvas"); } }); } },
      { label: t("toon_factory.document"), run: () => { void flush().then((ok) => { if (ok) { stateRef.current.mode = "document"; setMode("document"); } }); } },
      { label: t("toon_factory.project_assets"), run: () => setAssetOpen(true) },
      { label: t("toon_factory.checkpoints"), run: () => void openCheckpoints() },
      { label: assistantOpen ? t("toon_factory.close_assistant") : t("toon_factory.open_assistant"), run: () => { stateRef.current.assistantOpen = !assistantOpen; setAssistantOpen(!assistantOpen); } },
    ].map((item, index) => <button key={item.label} type="button" autoFocus={index === 0} onClick={() => { item.run(); setCommandOpen(false); }} className="block w-full rounded-xl px-3 py-2 text-left text-xs text-dls-text hover:bg-dls-hover focus:bg-dls-active focus:outline-none">{item.label}</button>)}</div></div> : null}
    {checkpointOpen ? <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/20 p-6" role="dialog" aria-modal="true" data-canvas-shortcuts="disabled"><div className="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-2xl border border-dls-border bg-background p-5 shadow-xl"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold">{runtime?.conflict ? t("toon_factory.compare") : t("toon_factory.checkpoints")}</h2><button type="button" onClick={() => setCheckpointOpen(false)}><X className="size-4" /></button></div>{runtime?.conflict && runtime.compare ? <div className="mt-4 grid grid-cols-2 gap-3"><pre className="max-h-80 overflow-auto rounded-xl bg-[var(--app-list-bg)] p-3 text-[9px]">{JSON.stringify(runtime.draft, null, 2)}</pre><pre className="max-h-80 overflow-auto rounded-xl bg-[var(--app-list-bg)] p-3 text-[9px]">{JSON.stringify(runtime.compare, null, 2)}</pre></div> : <><button type="button" disabled={!leaseReady} title={!leaseReady ? t("toon_factory.lease_read_only") : undefined} onClick={() => void createCheckpoint()} className="mt-4 rounded-lg bg-dls-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">{t("toon_factory.create_checkpoint")}</button><div className="mt-3 space-y-2">{checkpoints.map((checkpoint) => <div key={checkpoint.id} className="flex items-center justify-between rounded-xl border border-dls-border p-3 text-xs"><span><strong className="block">{checkpoint.title}</strong><span className="text-[10px] text-dls-secondary">{new Date(checkpoint.createdAt).toLocaleString()} · {checkpoint.origin}</span></span><button type="button" disabled={!leaseReady} title={!leaseReady ? t("toon_factory.lease_read_only") : undefined} onClick={() => { if (!activeCanvasId || !runtime) return; void props.client.restoreToonCanvasCheckpoint(props.workspaceId, props.projectId, activeCanvasId, checkpoint.id, { operationId: operationId("restore"), expectedRevision: runtime.revision, actor: { kind: "human" }, origin: "human-ui" }).then(() => loadCanvas(activeCanvasId, true)).then(() => setCheckpointOpen(false)); }} className="rounded-lg border border-dls-border px-2 py-1 disabled:opacity-40">{t("toon_factory.restore")}</button></div>)}</div></>}</div></div> : null}
  </div>;
}

const WORKFLOW_STAGE_LABELS = {
  "content-script": "toon_factory.stage_script",
  assets: "toon_factory.stage_assets",
  "directing-storyboard": "toon_factory.stage_storyboard",
  images: "toon_factory.stage_images",
  videos: "toon_factory.stage_videos",
  "adoption-delivery": "toon_factory.stage_delivery",
} as const;

function workflowStepAvailable(episode: ToonWorkspaceEpisode, step: ToonWorkspaceWorkflowStep): boolean {
  return step.dependencies.every((dependencyId) => {
    const dependency = episode.steps?.find((candidate) => candidate.id === dependencyId);
    return Boolean(dependency && ["approved", "adopted", "skipped"].includes(dependency.status));
  });
}

function WorkflowStatusPanel(props: { client: ToonWorkspaceClient; workspaceId: string; projectId: string; projectRevision: string; episode: ToonWorkspaceEpisode; evidence: { target: { kind: "canvas" | "document" | "asset"; id: string }; revision: string } | null; readOnly: boolean; onChanged: () => Promise<unknown> }) {
  const [skipStep, setSkipStep] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await action(); await props.onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const steps = props.episode.steps ?? [];
  const approve = (step: ToonWorkspaceWorkflowStep) => {
    const evidence = props.evidence;
    if (!evidence) return;
    void run(() => props.client.approveToonWorkspaceWorkflowStep(props.workspaceId, props.projectId, step.id, {
      operationId: operationId("workflow-approve"), episodeId: props.episode.id, workflowRecordId: step.id, expectedRevision: props.projectRevision, outputRevision: evidence.revision,
      dependencyLinks: [evidence],
    }));
  };
  const skip = (step: ToonWorkspaceWorkflowStep) => {
    const reason = window.prompt(t("toon_factory.skip_reason_placeholder"))?.trim();
    if (!reason) return;
    void run(() => props.client.skipToonWorkspaceWorkflowStep(props.workspaceId, props.projectId, step.id, { operationId: operationId("workflow-skip"), episodeId: props.episode.id, workflowRecordId: step.id, expectedRevision: props.projectRevision, reason }));
    setSkipStep(null);
  };
  const deliver = (step: ToonWorkspaceWorkflowStep) => void run(() => props.client.deliverToonWorkspaceWorkflowStep(props.workspaceId, props.projectId, step.id, { operationId: operationId("workflow-delivery"), episodeId: props.episode.id, workflowRecordId: step.id, expectedRevision: props.projectRevision }));
  return <section className="mt-4 border-t border-dls-border pt-3" data-testid="toon-v2-workflow-status">
    <h2 className="px-2 text-[10px] font-semibold uppercase tracking-wide text-dls-secondary">{t("toon_factory.workflow")}</h2>
    <div className="mt-2 space-y-1">{TOON_CANONICAL_WORKFLOW_STAGES.map((stage) => {
      const record = props.episode.stages.find((item) => item.stage === stage);
      const stageSteps = steps.filter((step) => step.stage === stage);
      return <details key={stage} className="rounded-lg border border-dls-border px-2 py-1.5" open={stage === "content-script"}>
        <summary className="cursor-pointer text-[10px] font-medium"><span>{t(WORKFLOW_STAGE_LABELS[stage])}</span><span className="float-right text-dls-secondary">{record?.status ?? "draft"}</span></summary>
        <div className="mt-2 space-y-2">{stageSteps.map((step) => {
          const available = workflowStepAvailable(props.episode, step);
          const terminal = ["approved", "adopted", "skipped"].includes(step.status);
          const contentApprovable = !["image-candidates", "video-clips", "adopt-clips", "delivery-manifest"].includes(step.id) && Boolean(props.evidence);
          return <div key={step.id} className="rounded-md bg-[var(--app-list-bg)] p-2 text-[9px]" data-testid={`toon-v2-workflow-step-${step.id}`}>
            <div className="flex justify-between gap-2"><span>{step.title}</span><span className="text-dls-secondary">{step.status}</span></div>
            {!terminal && available ? <div className="mt-1 flex flex-wrap gap-1">
              {contentApprovable ? <button type="button" disabled={props.readOnly || busy} onClick={() => approve(step)} className="rounded bg-dls-accent px-1.5 py-1 text-white disabled:opacity-40">{t("toon_factory.approve_content")}</button> : null}
              {step.id === "delivery-manifest" ? <button type="button" disabled={props.readOnly || busy} onClick={() => deliver(step)} className="rounded bg-dls-accent px-1.5 py-1 text-white disabled:opacity-40">{t("toon_factory.deliver")}</button> : null}
              <button type="button" disabled={props.readOnly || busy} onClick={() => { setSkipStep(step.id); skip(step); }} className="rounded border border-dls-border px-1.5 py-1 disabled:opacity-40">{t("toon_factory.skip")}</button>
            </div> : null}
            {skipStep === step.id ? <span className="sr-only">{t("toon_factory.skip_reason")}</span> : null}
          </div>;
        })}</div>
      </details>;
    })}</div>
    {error ? <p role="alert" className="mt-2 text-[9px] text-destructive">{error}</p> : null}
  </section>;
}
