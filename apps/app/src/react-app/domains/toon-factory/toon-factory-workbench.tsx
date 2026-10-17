/** @jsxImportSource react */
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ToonCanvas,
  ToonEpisode,
  ToonImageModelDescriptor,
  ToonNode,
  ToonNodeKind,
  ToonImageGenerationMode,
  ToonMediaGenerationPlan,
  ToonMediaJob,
  ToonModelReference,
  ToonProject,
  ToonProjectSummary,
  ToonProjectResponse,
  ToonReferenceScope,
  ToonVideoGenerationMode,
  ToonVideoModelDescriptor,
  ToonWorkflowStage,
  ToonWorkflowStep,
} from "@jugglework/types/toon-factory";
import type { ToonAssistantAttachment } from "@jugglework/types/toon-assistant";
import {
  TOON_TEXT_OUTPUT_SCHEMAS,
  type ToonTextGenerationAction,
  type ToonTextJob,
  type ToonTextJobCreateRequest,
} from "@jugglework/types/toon-factory";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Download,
  FileText,
  Folder,
  Grid2X2,
  Image,
  LayoutList,
  LoaderCircle,
  MessageSquare,
  Paperclip,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Sparkles,
  Unplug,
  Video,
  X,
} from "lucide-react";

import { JuggleWorkServerError, type JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { ConnectedTextModelOption } from "@/react-app/infra/provider-list-query";
import { mediaModelQueryScope, toonMediaModelQueryKey } from "@/react-app/domains/connections/media-model-queries";
import {
  TOON_NODE_DEFINITIONS,
  applyUpstreamRevision,
  approveWorkflowStep,
  createEpisodeWorkflowSteps,
  createNode,
  deliveryManifestIsCurrent,
  episodeDeliveryDescription,
  episodeProgress,
  skipWorkflowStep,
  synchronizeEpisodeStages,
  updateWorkflowStep,
  validateToonConnection,
  workflowStepAvailable,
  workflowApprovalRevision,
} from "./toon-factory-workflow";
import { revalidateToonProjectModels, type ToonModelBlockingReason } from "./toon-factory-models";
import { ToonWorkspace } from "./workspace/toon-workspace";
import { ToonLegacyCanvas } from "./canvas/toon-legacy-canvas";
export { fitToonCanvasViewport } from "./canvas/toon-legacy-canvas";
import {
  clearToonTextDraft,
  clearToonProjectIntentDraft,
  flushToonTextDrafts,
  readToonProjectIntentDraft,
  readToonTextDraft,
  registerToonTextDraftFlusher,
  toonCanvasKey,
  toonDeliveryKey,
  toonMediaJobsKey,
  toonProjectKey,
  toonProjectsKey,
  toonQueryScope,
  toonTextDraftKey,
  toonTextJobKey,
  toonTextKey,
  toonTextRequestFingerprint,
  type ToonProjectIntentDraft,
  type ToonProjectIntentOperation,
  type ToonQueryScope,
  writeToonProjectIntentDraft,
  writeToonTextDraft,
} from "./toon-factory-state";

type ToonFactoryClient = Pick<JuggleWorkServerClient,
  | "baseUrl"
  | "listToonProjects"
  | "createToonProject"
  | "getToonProject"
  | "updateToonProject"
  | "readToonCanvas"
  | "writeToonCanvas"
  | "readToonText"
  | "writeToonText"
  | "getToonModelCatalog"
  | "createToonTextJob"
  | "getToonTextJob"
  | "cancelToonTextJob"
  | "authorizeToonMediaJob"
  | "createToonMediaJob"
  | "listToonMediaJobs"
  | "getToonMediaJob"
  | "cancelToonMediaJob"
  | "reviewToonMediaJob"
  | "retryToonMediaJob"
  | "getToonDeliveryManifest"
  | "createToonDeliveryManifest"
  | "downloadToonDeliveryManifest"
  | "downloadToonDeliveryArtifact"
  | "downloadWorkspaceFile"
  | "listToonWorkspaceProjects"
  | "openToonWorkspaceProject"
  | "getToonWorkspaceFeatures"
  | "initializeToonWorkspaceProject"
  | "ensureToonWorkspaceWorkflow"
  | "approveToonWorkspaceWorkflowStep"
  | "skipToonWorkspaceWorkflowStep"
  | "deliverToonWorkspaceWorkflowStep"
  | "queryToonWorkspace"
  | "executeToonWorkspaceCommand"
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

type WorkbenchProps = {
  client: ToonFactoryClient;
  workspaceId: string;
  workspaceRoot: string;
  projectId: string | null;
  visible: boolean;
  readOnly?: boolean;
  sidebarOpen: boolean;
  textModels: ConnectedTextModelOption[];
  textModelsPending: boolean;
  onRefreshTextModels: () => Promise<unknown>;
  onOpenProviderSettings: () => void;
  onSelectProject: (projectId: string | null) => void;
};

type TextDocument = { content: string; revision?: string };

const STAGES: ToonWorkflowStage[] = ["content-script", "assets", "directing-storyboard", "images", "videos", "adoption-delivery"];
const STAGE_LABELS: Record<ToonWorkflowStage, string> = {
  "content-script": "toon_factory.stage_script",
  assets: "toon_factory.stage_assets",
  "directing-storyboard": "toon_factory.stage_storyboard",
  images: "toon_factory.stage_images",
  videos: "toon_factory.stage_videos",
  "adoption-delivery": "toon_factory.stage_delivery",
};

function describeError(error: unknown): string {
  if (error instanceof JuggleWorkServerError) {
    if (error.code === "toon_factory_revision_conflict") return t("toon_factory.conflict_description");
    if (error.code === "toon_factory_unsupported_version") return t("toon_factory.unsupported_version");
    if (error.code === "selected_model_unavailable") return t("toon_factory.selected_model_unavailable_hint");
    if (error.code === "toon_media_reconciliation_required") return t("toon_factory.submission_unknown_no_resubmit");
    if (error.code === "workflow_prerequisite_incomplete") return t("toon_factory.workflow_prerequisite_incomplete");
    return t("toon_factory.server_error");
  }
  return error instanceof Error ? error.message : String(error);
}

function describeGenerationError(code: string): string {
  if (code === "selected_model_unavailable") return t("toon_factory.selected_model_unavailable_hint");
  if (code === "toon_text_job_target_changed" || code === "toon_media_job_target_changed") return t("toon_factory.generation_target_changed");
  return t("toon_factory.generation_failed");
}

function makeIdentifier(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function blankCanvas(id: string, name: string): ToonCanvas {
  return { schemaVersion: 1, id, name, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
}

type HomeIntentState = ToonProjectIntentDraft & { scopeKey: string; scope: ToonQueryScope };
type HomeIntentAction = { type: "scope"; scope: ToonQueryScope }
  | { type: "patch"; patch: Partial<ToonProjectIntentDraft> }
  | { type: "completed"; projectId: string }
  | { type: "reset" }
  | { type: "clear-completed" };

function intentScopeKey(scope: ToonQueryScope): string {
  return `${scope.endpoint}\u0000${scope.workspaceId}`;
}

function homeIntentState(scope: ToonQueryScope): HomeIntentState {
  return { scopeKey: intentScopeKey(scope), scope, name: "", directory: "", prompt: "", ...(readToonProjectIntentDraft(scope) ?? {}) };
}

function homeIntentReducer(state: HomeIntentState, action: HomeIntentAction): HomeIntentState {
  if (action.type === "scope") return homeIntentState(action.scope);
  if (action.type === "completed") return { ...state, name: "", directory: "", prompt: "", textModel: undefined, operation: undefined, completedProjectId: action.projectId };
  if (action.type === "reset") return { ...state, name: "", directory: "", prompt: "", textModel: undefined, operation: undefined, completedProjectId: undefined };
  if (action.type === "clear-completed") return { ...state, completedProjectId: undefined };
  return { ...state, ...action.patch, completedProjectId: action.patch.completedProjectId ?? (Object.hasOwn(action.patch, "completedProjectId") ? undefined : state.completedProjectId) };
}

function useHomeIntent(scope: ToonQueryScope, enabled: boolean) {
  const [state, dispatch] = useReducer(homeIntentReducer, scope, homeIntentState);
  const scopeKey = intentScopeKey(scope);
  useEffect(() => {
    if (state.scopeKey !== scopeKey) dispatch({ type: "scope", scope });
  }, [scope.endpoint, scope.workspaceId, scopeKey, state.scopeKey]);
  useEffect(() => {
    if (!enabled || state.scopeKey !== scopeKey) return;
    writeToonProjectIntentDraft(state.scope, {
      name: state.name,
      directory: state.directory,
      prompt: state.prompt,
      ...(state.textModel ? { textModel: state.textModel } : {}),
      ...(state.operation ? { operation: state.operation } : {}),
      ...(state.completedProjectId ? { completedProjectId: state.completedProjectId } : {}),
    });
  }, [enabled, scopeKey, state]);
  return [state.scopeKey === scopeKey ? state : homeIntentState(scope), dispatch] as const;
}

function isNotFound(error: unknown): boolean {
  return error instanceof JuggleWorkServerError && error.status === 404;
}

export function ToonFactoryWorkbench(props: WorkbenchProps) {
  const queryClient = useQueryClient();
  const queryScope = toonQueryScope(props.client.baseUrl, props.workspaceId);
  const [homeIntent, dispatchHomeIntent] = useHomeIntent(queryScope, !props.projectId);
  const projectName = homeIntent.name;
  const projectDirectory = homeIntent.directory;
  const projectIntent = homeIntent.prompt;
  const homeTextModel = homeIntent.textModel ? modelValue(homeIntent.textModel) : "";
  const [projectView, setProjectView] = useState<"grid" | "list">("grid");
  const [projectSort, setProjectSort] = useState<"updated" | "name">("updated");
  const [projectFolder, setProjectFolder] = useState("all");
  const [homeAttachments, setHomeAttachments] = useState<File[]>([]);
  const [openProjectError, setOpenProjectError] = useState<string | null>(null);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null);
  const [selectedStage, setSelectedStage] = useState<ToonWorkflowStage>("content-script");
  const [imageMode, setImageMode] = useState<ToonImageGenerationMode>("text-to-image");
  const [videoMode, setVideoMode] = useState<ToonVideoGenerationMode>("text-to-video");
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [modelSaveError, setModelSaveError] = useState<string | null>(null);
  const [pendingEpisode, setPendingEpisode] = useState<ToonEpisode | null>(null);
  const [initialAssistantPrompt, setInitialAssistantPrompt] = useState<{ projectId: string; text: string } | null>(null);
  const projectOperationRef = useRef<Promise<unknown>>(Promise.resolve());
  const currentContextRef = useRef({ scopeKey: intentScopeKey(queryScope), visible: props.visible, projectId: props.projectId });
  currentContextRef.current = { scopeKey: intentScopeKey(queryScope), visible: props.visible, projectId: props.projectId };

  const serializeProjectOperation = <T,>(operation: () => Promise<T>): Promise<T> => {
    const result = projectOperationRef.current.then(operation, operation);
    projectOperationRef.current = result.catch(() => undefined);
    return result;
  };

  const projectsQuery = useQuery({
    queryKey: toonProjectsKey(queryScope),
    queryFn: () => props.client.listToonProjects(props.workspaceId),
    enabled: props.visible,
    retry: false,
  });
  const workspaceProjectsQuery = useQuery({
    queryKey: [...toonProjectsKey(queryScope), "v2"],
    queryFn: () => typeof props.client.listToonWorkspaceProjects === "function"
      ? props.client.listToonWorkspaceProjects(props.workspaceId)
      : Promise.resolve({ schemaVersion: 2 as const, items: [] }),
    enabled: props.visible,
    retry: false,
  });
  const isWorkspaceProject = Boolean(props.projectId && workspaceProjectsQuery.data?.items.some((item) => item.projectId === props.projectId));
  const projectQuery = useQuery({
    queryKey: toonProjectKey(queryScope, props.projectId ?? "none"),
    queryFn: () => props.client.getToonProject(props.workspaceId, props.projectId!),
    enabled: props.visible && Boolean(props.projectId) && !isWorkspaceProject,
    retry: false,
  });
  const mediaScope = mediaModelQueryScope({ endpoint: props.client.baseUrl, workspaceId: props.workspaceId, workspaceRoot: props.workspaceRoot });
  const modelCatalogQuery = useQuery({
    queryKey: toonMediaModelQueryKey(mediaScope, imageMode, videoMode),
    queryFn: () => props.client.getToonModelCatalog(props.workspaceId, { imageMode, videoMode }),
    enabled: props.visible && Boolean(props.projectId),
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (!props.projectId) {
      setSelectedEpisodeId(null);
      return;
    }
    const episodes = projectQuery.data?.project.episodes;
    if (!episodes) return;
    if (!episodes.some((episode) => episode.id === selectedEpisodeId)) setSelectedEpisodeId(episodes[0]?.id ?? null);
  }, [projectQuery.data, props.projectId, selectedEpisodeId]);

  const createProject = useMutation({
    mutationFn: async () => {
      const prompt = projectIntent.trim();
      const name = projectName.trim() || prompt.split(/\r?\n/)[0]?.trim().slice(0, 80) || t("toon_factory.untitled_project");
      const directory = projectDirectory.trim();
      const [providerID, modelID] = homeTextModel.split("\u0000");
      const textModel = providerID && modelID ? { kind: "text" as const, providerID, modelID } : undefined;
      const scope = queryScope;
      const scopeKey = intentScopeKey(scope);
      const baseDraft: ToonProjectIntentDraft = { name: projectName, directory: projectDirectory, prompt: projectIntent, ...(textModel ? { textModel } : {}) };
      let operation: ToonProjectIntentOperation = homeIntent.operation ?? {
        version: 1,
        episodeId: makeIdentifier("episode"),
        canvasId: "main",
        sourceNodeId: makeIdentifier("source"),
        phase: "project",
      };
      const persistOperation = (patch: Partial<ToonProjectIntentOperation>) => {
        operation = { ...operation, ...patch };
        writeToonProjectIntentDraft(scope, { ...baseDraft, operation });
        if (currentContextRef.current.scopeKey === scopeKey) dispatchHomeIntent({ type: "patch", patch: { operation } });
      };
      if (!homeIntent.operation) persistOperation({});

      const features = typeof props.client.getToonWorkspaceFeatures === "function"
        ? await props.client.getToonWorkspaceFeatures(props.workspaceId).catch(() => null)
        : null;
      if (features?.advancedWorkspace) {
        const initOperationId = `home-${operation.sourceNodeId}`;
        const initialized = await props.client.initializeToonWorkspaceProject(props.workspaceId, { operationId: initOperationId, name, directory, episodeId: operation.episodeId, actor: { kind: "human" }, origin: "human-ui" });
        const workspaceProjectId = initialized.affected.find((item) => item.kind === "project")?.id;
        if (!workspaceProjectId) throw new Error("Initialized Toon workspace did not return a project ID");
        if (textModel) {
          await props.client.executeToonWorkspaceCommand(props.workspaceId, workspaceProjectId, { operationId: `${initOperationId}-model`, expectedRevisions: {}, kind: "project.update", modelDefaults: { text: textModel } });
        }
        const attachments: ToonAssistantAttachment[] = [];
        for (const [index, file] of homeAttachments.entries()) {
          const assetId = `${operation.sourceNodeId}-asset-${index + 1}`.slice(0, 128);
          const uploaded = await props.client.uploadToonProjectAsset(props.workspaceId, workspaceProjectId, file, { operationId: `${initOperationId}-asset-${index + 1}`, assetId, filename: file.name, ...(file.type ? { declaredMimeType: file.type } : {}), origin: "imported", actor: { kind: "human" } });
          const asset = (uploaded.result as { asset?: { id: string; title: string; checksum: string; mimeType: string } } | undefined)?.asset;
          if (!asset) throw new Error(t("toon_factory.attachment_upload_failed"));
          attachments.push({ id: `${operation.sourceNodeId}-attachment-${index + 1}`.slice(0, 128), kind: "asset", targetId: asset.id, revision: asset.checksum, label: asset.title, mimeType: asset.mimeType });
        }
        persistOperation({ projectId: workspaceProjectId, phase: "complete" });
        if (prompt || attachments.length) {
          if (!textModel) throw new Error(t("toon_factory.attachment_model_required"));
          const conversation = await props.client.createToonAssistantConversation(props.workspaceId, workspaceProjectId, { model: textModel, title: name });
          await props.client.sendToonAssistantMessage(props.workspaceId, workspaceProjectId, conversation.id, { turnId: `${operation.sourceNodeId}-turn`, messageId: `${operation.sourceNodeId}-message`, text: prompt || t("toon_factory.attachment_initial_message"), model: textModel, attachments, mentions: [] });
        }
        return { workspaceProjectId, initialAssistantPrompt: "", scope, draft: baseDraft };
      }
      if (homeAttachments.length) throw new Error(t("toon_factory.attachments_require_v2"));

      let created: ToonProjectResponse;
      if (operation.projectId) {
        created = await props.client.getToonProject(props.workspaceId, operation.projectId);
      } else {
        try {
          created = await props.client.createToonProject(props.workspaceId, { name, directory });
        } catch (error) {
          const recovered = (await props.client.listToonProjects(props.workspaceId)).items.find((item) => item.directory === directory && item.name === name);
          if (!recovered) throw error;
          created = await props.client.getToonProject(props.workspaceId, recovered.id);
        }
        persistOperation({ projectId: created.project.id, phase: "canvas" });
      }
      if (!prompt && !textModel) {
        persistOperation({ phase: "complete" });
        return { response: created, scope, draft: baseDraft };
      }
      const now = new Date().toISOString();
      if (!prompt) {
        const current = await props.client.getToonProject(props.workspaceId, created.project.id);
        if (current.project.selectedModels?.text?.providerID === providerID && current.project.selectedModels.text.modelID === modelID) {
          persistOperation({ phase: "complete" });
          return { response: current, scope, draft: baseDraft };
        }
        const project = { ...current.project, selectedModels: { ...current.project.selectedModels, text: textModel! }, updatedAt: now };
        try {
          const response = await props.client.updateToonProject(props.workspaceId, current.project.id, { project, expectedRevision: current.revision });
          persistOperation({ phase: "complete" });
          return { response, scope, draft: baseDraft };
        } catch (error) {
          const recovered = await props.client.getToonProject(props.workspaceId, current.project.id);
          if (recovered.project.selectedModels?.text?.providerID !== providerID || recovered.project.selectedModels.text.modelID !== modelID) throw error;
          persistOperation({ phase: "complete" });
          return { response: recovered, scope, draft: baseDraft };
        }
      }
      const baseSourceNode = createNode("text", operation.sourceNodeId, 0);
      const sourceNode = { ...baseSourceNode, data: { ...baseSourceNode.data, label: t("toon_factory.initial_intent") } };
      const episode: ToonEpisode = {
        id: operation.episodeId,
        title: t("toon_factory.episode_title", { ordinal: 1 }),
        ordinal: 1,
        canvasId: operation.canvasId,
        stages: STAGES.map((stage) => ({ stage, status: "draft", updatedAt: now })),
        steps: createEpisodeWorkflowSteps(now, t),
        createdAt: now,
        updatedAt: now,
      };
      let existingCanvas: { canvas: ToonCanvas; revision: string } | null = null;
      try {
        existingCanvas = await props.client.readToonCanvas(props.workspaceId, created.project.id, operation.canvasId);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      if (!existingCanvas?.canvas.nodes.some((node) => node.id === operation.sourceNodeId)) {
        const canvas = existingCanvas
          ? { ...existingCanvas.canvas, nodes: [...existingCanvas.canvas.nodes, sourceNode], selectedNodeId: operation.sourceNodeId }
          : { ...blankCanvas(operation.canvasId, episode.title), nodes: [sourceNode], selectedNodeId: operation.sourceNodeId };
        try {
          await props.client.writeToonCanvas(props.workspaceId, created.project.id, operation.canvasId, {
            canvas,
            ...(existingCanvas ? { expectedRevision: existingCanvas.revision } : {}),
          });
        } catch (error) {
          const recovered = await props.client.readToonCanvas(props.workspaceId, created.project.id, operation.canvasId).catch(() => null);
          if (!recovered?.canvas.nodes.some((node) => node.id === operation.sourceNodeId)) throw error;
        }
      }
      persistOperation({ phase: "text" });
      let textRevision: string;
      try {
        const existing = await props.client.readToonText(props.workspaceId, created.project.id, operation.sourceNodeId);
        if (existing.content !== prompt) throw new Error(t("toon_factory.initialization_text_conflict"));
        textRevision = existing.revision;
      } catch (error) {
        if (!isNotFound(error)) throw error;
        try {
          textRevision = (await props.client.writeToonText(props.workspaceId, created.project.id, operation.sourceNodeId, { content: prompt, expectedRevision: null })).revision;
        } catch (writeError) {
          const recovered = await props.client.readToonText(props.workspaceId, created.project.id, operation.sourceNodeId).catch(() => null);
          if (!recovered || recovered.content !== prompt) throw writeError;
          textRevision = recovered.revision;
        }
      }
      persistOperation({ phase: "project-update" });
      const initializedEpisode = applyUpstreamRevision(episode, "source-material", textRevision, now);
      const current = await props.client.getToonProject(props.workspaceId, created.project.id);
      const existingEpisode = current.project.episodes.find((item) => item.id === operation.episodeId);
      if (existingEpisode) {
        persistOperation({ phase: "complete" });
        return { response: current, scope, draft: baseDraft };
      }
      const project = {
        ...current.project,
        episodes: [...current.project.episodes, initializedEpisode],
        ...(textModel ? { selectedModels: { ...current.project.selectedModels, text: textModel } } : {}),
        updatedAt: now,
      };
      try {
        const response = await props.client.updateToonProject(props.workspaceId, created.project.id, { project, expectedRevision: current.revision });
        persistOperation({ phase: "complete" });
        return { response, scope, draft: baseDraft };
      } catch (error) {
        const recovered = await props.client.getToonProject(props.workspaceId, created.project.id);
        if (!recovered.project.episodes.some((item) => item.id === operation.episodeId)) throw error;
        persistOperation({ phase: "complete" });
        return { response: recovered, scope, draft: baseDraft };
      }
    },
    onSuccess: (result) => {
      const { scope, draft } = result;
      if ("workspaceProjectId" in result) {
        const workspaceProjectId = result.workspaceProjectId;
        if (!workspaceProjectId) throw new Error("Initialized Toon workspace did not return a project ID");
        void queryClient.invalidateQueries({ queryKey: [...toonProjectsKey(scope), "v2"] });
        if (result.initialAssistantPrompt) setInitialAssistantPrompt({ projectId: workspaceProjectId, text: result.initialAssistantPrompt });
        setHomeAttachments([]);
        const sameContext = currentContextRef.current.scopeKey === intentScopeKey(scope);
        const navigate = sameContext && currentContextRef.current.visible && !currentContextRef.current.projectId;
        if (navigate) { clearToonProjectIntentDraft(scope); dispatchHomeIntent({ type: "reset" }); props.onSelectProject(workspaceProjectId); }
        else { writeToonProjectIntentDraft(scope, { ...draft, completedProjectId: workspaceProjectId }); dispatchHomeIntent({ type: "completed", projectId: workspaceProjectId }); }
        return;
      }
      const created = result.response;
      queryClient.setQueryData(toonProjectKey(scope, created.project.id), created);
      void queryClient.invalidateQueries({ queryKey: toonProjectsKey(scope), exact: true });
      const sameContext = currentContextRef.current.scopeKey === intentScopeKey(scope);
      const navigate = sameContext && currentContextRef.current.visible && !currentContextRef.current.projectId;
      if (navigate) {
        clearToonProjectIntentDraft(scope);
        dispatchHomeIntent({ type: "reset" });
      } else {
        writeToonProjectIntentDraft(scope, { ...draft, completedProjectId: created.project.id });
      }
      if (sameContext && !navigate) {
        dispatchHomeIntent({ type: "completed", projectId: created.project.id });
      }
      if (navigate) props.onSelectProject(created.project.id);
    },
  });

  const updateProject = async (current: ToonProjectResponse, project: ToonProject): Promise<ToonProjectResponse> => {
    const response = await props.client.updateToonProject(props.workspaceId, project.id, { project, expectedRevision: current.revision });
    queryClient.setQueryData(toonProjectKey(queryScope, project.id), response);
    void queryClient.invalidateQueries({ queryKey: toonProjectsKey(queryScope), exact: true });
    return response;
  };

  const addEpisode = useMutation({
    mutationFn: async () => {
      const current = projectQuery.data;
      if (!current) throw new Error(t("toon_factory.project_not_loaded"));
       const ordinal = current.project.episodes.length + 1;
       const episodeId = makeIdentifier("episode");
       const canvasId = makeIdentifier("canvas");
       const now = new Date().toISOString();
       const episode: ToonEpisode = pendingEpisode ?? {
        id: episodeId,
        title: t("toon_factory.episode_title", { ordinal }),
        ordinal,
        canvasId,
        stages: STAGES.map((stage) => ({ stage, status: "draft", updatedAt: now })),
        steps: createEpisodeWorkflowSteps(now, t),
        createdAt: now,
        updatedAt: now,
      };
       if (!pendingEpisode) {
         const canvasResponse = await props.client.writeToonCanvas(props.workspaceId, current.project.id, canvasId, { canvas: blankCanvas(canvasId, episode.title) });
         queryClient.setQueryData(toonCanvasKey(queryScope, current.project.id, canvasId), canvasResponse);
       }
       try {
         await serializeProjectOperation(() => updateProject(current, { ...current.project, episodes: [...current.project.episodes, episode], updatedAt: now }));
       } catch (error) {
         setPendingEpisode(episode);
         throw error;
       }
       setPendingEpisode(null);
       return episode;
    },
    onSuccess: (episode) => setSelectedEpisodeId(episode.id),
  });

  const selectedEpisode = projectQuery.data?.project.episodes.find((episode) => episode.id === selectedEpisodeId) ?? null;
  const allProjects = [
    ...(projectsQuery.data?.items ?? []),
    ...(workspaceProjectsQuery.data?.items ?? []).map((item) => ({ id: item.projectId, name: item.name, directory: item.directory, updatedAt: item.updatedAt, episodeCount: 0, revision: item.revision })),
  ].filter((item, index, items) => items.findIndex((candidate) => candidate.id === item.id) === index);
  const sortedProjects = allProjects.sort((left, right) => projectSort === "name"
    ? left.name.localeCompare(right.name)
    : Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const projectFolders = [...new Set(allProjects.map((project) => project.directory.split("/").slice(0, -1).join("/") || "."))].sort();
  const visibleProjects = projectFolder === "all" ? sortedProjects : sortedProjects.filter((project) => (project.directory.split("/").slice(0, -1).join("/") || ".") === projectFolder);
  const openProjectDirectory = async (directory: string) => {
    setOpenProjectError(null);
    try {
      const opened = await props.client.openToonWorkspaceProject(props.workspaceId, { directory });
      await workspaceProjectsQuery.refetch();
      props.onSelectProject(opened.project.projectId);
    } catch (cause) { setOpenProjectError(describeError(cause)); }
  };
  const imageModels = modelCatalogQuery.data?.image.models ?? [];
  const videoModels = modelCatalogQuery.data?.video.models ?? [];
  const modelChecksPending = props.textModelsPending || modelCatalogQuery.isPending || modelCatalogQuery.isFetching;
  const validatedModelAvailability = revalidateToonProjectModels({
    selectedModels: projectQuery.data?.project.selectedModels,
    textModels: props.textModels,
    imageModels,
    videoModels,
    imageMode,
    videoMode,
    videoSubmissionEnabled: modelCatalogQuery.data?.video.submissionEnabled ?? false,
    videoBlockingReason: modelCatalogQuery.data?.video.blockingReason ?? null,
  });
  const modelAvailability = modelChecksPending
    ? {
        text: { available: false, reason: null },
        image: { available: false, reason: null },
        video: { available: false, reason: null },
      } as const
    : validatedModelAvailability;

  const selectModel = async (kind: "text" | "image" | "video", providerID: string, modelID: string) => {
    const current = projectQuery.data;
    if (!current || !providerID || !modelID) return;
    const selectedModels = {
      ...current.project.selectedModels,
      [kind]: { kind, providerID, modelID },
    };
    setModelSaveError(null);
    try {
      await updateProject(current, {
        ...current.project,
        selectedModels,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      setModelSaveError(describeError(error));
    }
  };

  const modelSettings = projectQuery.data ? (
    <ProjectModelSettings
      project={projectQuery.data.project}
      textModels={props.textModels}
      imageModels={imageModels}
      videoModels={videoModels}
      imageMode={imageMode}
      videoMode={videoMode}
      availability={modelAvailability}
      loading={modelChecksPending}
      error={modelSaveError ?? (modelCatalogQuery.error ? describeError(modelCatalogQuery.error) : null)}
      open={modelSettingsOpen}
      onOpenChange={setModelSettingsOpen}
      onImageModeChange={setImageMode}
      onVideoModeChange={setVideoMode}
      onSelectModel={(kind, providerID, modelID) => void selectModel(kind, providerID, modelID)}
      onOpenProviderSettings={props.onOpenProviderSettings}
      onRefresh={() => { void Promise.all([props.onRefreshTextModels(), modelCatalogQuery.refetch()]); }}
    />
  ) : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="toon-factory-workbench">
      {props.projectId && isWorkspaceProject ? <ToonWorkspace key={`${props.workspaceId}:${props.projectId}`} client={props.client} workspaceId={props.workspaceId} projectId={props.projectId} visible={props.visible} readOnly={props.readOnly} textModels={props.textModels} initialAssistantPrompt={initialAssistantPrompt?.projectId === props.projectId ? initialAssistantPrompt.text : undefined} onInitialAssistantPromptConsumed={() => setInitialAssistantPrompt(null)} onBack={() => props.onSelectProject(null)} /> : null}
      {!isWorkspaceProject ? (
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--app-page-bg)]">
         {!props.projectId ? <ToonFactoryHome projectName={projectName} projectDirectory={projectDirectory} projectIntent={projectIntent} homeTextModel={homeTextModel} completedProjectId={homeIntent.completedProjectId ?? null} textModels={props.textModels} projectView={projectView} projectSort={projectSort} projectFolder={projectFolder} projectFolders={projectFolders} attachments={homeAttachments} projects={visibleProjects} loading={projectsQuery.isLoading || workspaceProjectsQuery.isLoading} empty={allProjects.length === 0} error={projectsQuery.error ? describeError(projectsQuery.error) : openProjectError} createError={createProject.error ? describeError(createProject.error) : null} creating={createProject.isPending} onProjectNameChange={(name) => dispatchHomeIntent({ type: "patch", patch: { name } })} onDirectoryChange={(directory) => dispatchHomeIntent({ type: "patch", patch: { directory } })} onIntentChange={(prompt) => dispatchHomeIntent({ type: "patch", patch: { prompt } })} onTextModelChange={(value) => { const [providerID, modelID] = value.split("\u0000"); dispatchHomeIntent({ type: "patch", patch: { textModel: providerID && modelID ? { kind: "text", providerID, modelID } : undefined } }); }} onAttachmentsChange={setHomeAttachments} onProjectViewChange={setProjectView} onProjectSortChange={setProjectSort} onProjectFolderChange={setProjectFolder} onOpenProject={(directory) => void openProjectDirectory(directory)} onCreate={() => createProject.mutate()} onRetry={() => void Promise.all([projectsQuery.refetch(), workspaceProjectsQuery.refetch()])} onSelectProject={props.onSelectProject} onOpenCompletedProject={() => { if (homeIntent.completedProjectId) { clearToonProjectIntentDraft(queryScope); dispatchHomeIntent({ type: "clear-completed" }); props.onSelectProject(homeIntent.completedProjectId); } }} /> : null}
        {props.projectId && projectQuery.isLoading ? <MainState label={t("toon_factory.loading_project")} /> : null}
        {props.projectId && projectQuery.error ? <MainError message={describeError(projectQuery.error)} onRetry={() => void projectQuery.refetch()} onBack={() => props.onSelectProject(null)} /> : null}
        {projectQuery.data && !selectedEpisode ? <>{modelSettings}<EmptyWorkspace title={projectQuery.data.project.name} description={t("toon_factory.no_episodes_hint")} action={<div className="mt-4 flex flex-wrap justify-center gap-2"><button type="button" className="rounded-xl border border-dls-border px-4 py-2 text-xs font-semibold text-dls-text" onClick={() => props.onSelectProject(null)} data-testid="toon-zero-episode-back">{t("toon_factory.back_to_projects")}</button><button type="button" className="rounded-xl bg-dls-accent px-4 py-2 text-xs font-semibold text-white" onClick={() => addEpisode.mutate()}>{t("toon_factory.add_first_episode")}</button></div>} /></> : null}
        {projectQuery.data && selectedEpisode ? (
          <EpisodeWorkbench
            key={`${projectQuery.data.project.id}:${selectedEpisode.id}`}
            client={props.client}
            workspaceId={props.workspaceId}
            projectResponse={projectQuery.data}
            episode={selectedEpisode}
            selectedStage={selectedStage}
            visible={props.visible}
            modelSettings={modelSettings}
             modelBlockingReason={selectedStage === "images" ? modelAvailability.image.reason : selectedStage === "videos" ? modelAvailability.video.reason : modelAvailability.text.reason}
             imageGenerationAvailable={modelAvailability.image.available}
             videoGenerationAvailable={modelAvailability.video.available}
             imageMode={imageMode}
             videoMode={videoMode}
             episodes={projectQuery.data.project.episodes}
             onSelectEpisode={(episodeId) => { void flushToonTextDrafts().then(() => setSelectedEpisodeId(episodeId)).catch(() => undefined); }}
             onAddEpisode={() => addEpisode.mutate()}
             addingEpisode={addEpisode.isPending}
              onBack={() => { void flushToonTextDrafts().then(() => props.onSelectProject(null)).catch(() => undefined); }}
             onSelectStage={setSelectedStage}
             onProjectChange={(response) => queryClient.setQueryData(toonProjectKey(queryScope, response.project.id), response)}
          />
        ) : null}
      </section>) : null}
    </div>
  );
}

function ToonFactoryHome(props: {
  projectName: string;
  projectDirectory: string;
  projectIntent: string;
  homeTextModel: string;
  completedProjectId: string | null;
  textModels: ConnectedTextModelOption[];
  projectView: "grid" | "list";
  projectSort: "updated" | "name";
  projectFolder: string;
  projectFolders: string[];
  attachments: File[];
  projects: ToonProjectSummary[];
  loading: boolean;
  empty: boolean;
  error: string | null;
  createError: string | null;
  creating: boolean;
  onProjectNameChange: (value: string) => void;
  onDirectoryChange: (value: string) => void;
  onIntentChange: (value: string) => void;
  onTextModelChange: (value: string) => void;
  onAttachmentsChange: (value: File[]) => void;
  onProjectViewChange: (value: "grid" | "list") => void;
  onProjectSortChange: (value: "updated" | "name") => void;
  onProjectFolderChange: (value: string) => void;
  onOpenProject: (directory: string) => void;
  onCreate: () => void;
  onRetry: () => void;
  onSelectProject: (projectId: string) => void;
  onOpenCompletedProject: () => void;
}) {
  const createDisabled = props.creating || !props.projectDirectory.trim() || (!props.projectName.trim() && !props.projectIntent.trim());
  const attachmentInput = useRef<HTMLInputElement>(null);
  return <main className="relative min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(circle_at_1px_1px,var(--dls-border)_1px,transparent_0)] [background-size:24px_24px]" data-testid="toon-factory-home">
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div className="absolute left-[8%] top-28 h-44 w-44 rounded-full bg-dls-accent/5 blur-3xl" />
      <div className="absolute right-[10%] top-[28%] h-56 w-56 rounded-full bg-violet-500/5 blur-3xl" />
      <div className="absolute left-[-8%] top-48 h-24 w-[34%] rounded-[50%] border border-dls-accent/10 motion-reduce:hidden" />
      <div className="absolute right-[-10%] top-20 h-56 w-[32%] rounded-[50%] border border-dls-accent/10 motion-reduce:hidden" />
    </div>
    <div className="relative mx-auto w-full max-w-6xl px-5 pb-12 pt-20 sm:px-8 sm:pt-24">
      <header className="text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl border border-dls-accent/20 bg-dls-accent/10 text-dls-accent shadow-sm"><Sparkles className="size-5" /></div>
        <h1 className="mt-4 text-2xl font-semibold tracking-[-0.03em] text-dls-text sm:text-3xl">{t("toon_factory.title")}</h1>
        <p className="mx-auto mt-2 max-w-xl text-xs leading-5 text-dls-secondary sm:text-sm">{t("toon_factory.home_description")}</p>
      </header>
      <form className="mx-auto mt-8 max-w-4xl overflow-hidden rounded-[24px] border border-dls-border bg-background/95 shadow-[var(--dls-card-shadow)] backdrop-blur-xl" onSubmit={(event) => { event.preventDefault(); props.onCreate(); }} data-testid="toon-factory-create-form">
        <div className="border-b border-dls-border p-4 sm:p-5" data-testid="toon-inspiration-composer">
          <input className="h-8 w-full bg-transparent text-sm font-semibold text-dls-text outline-none placeholder:font-normal placeholder:text-dls-secondary" value={props.projectName} onChange={(event) => props.onProjectNameChange(event.target.value)} placeholder={t("toon_factory.project_name_optional")} aria-label={t("toon_factory.project_name")} />
          <textarea className="mt-2 min-h-32 w-full resize-y bg-transparent text-sm leading-6 text-dls-text outline-none placeholder:text-dls-secondary sm:min-h-40" value={props.projectIntent} onChange={(event) => props.onIntentChange(event.target.value)} placeholder={t("toon_factory.inspiration_placeholder")} aria-label={t("toon_factory.inspiration_label")} data-testid="toon-inspiration-input" />
        </div>
        <div className="flex flex-wrap items-center gap-2 bg-[var(--app-list-bg)] p-3 sm:px-4">
          <label className="flex min-w-[220px] flex-1 items-center gap-2 rounded-xl border border-transparent px-2 py-1.5 text-xs text-dls-secondary focus-within:border-dls-border focus-within:bg-background">
            <Folder className="size-4 shrink-0" />
            <input className="min-w-0 flex-1 bg-transparent text-dls-text outline-none" value={props.projectDirectory} onChange={(event) => props.onDirectoryChange(event.target.value)} placeholder={t("toon_factory.project_directory")} aria-label={t("toon_factory.project_directory_label")} />
          </label>
          <button type="button" onClick={() => attachmentInput.current?.click()} title={t("toon_factory.attachments_hint")} className="flex size-9 items-center justify-center rounded-full text-dls-secondary hover:bg-dls-hover" aria-label={t("toon_factory.attachments")}><Paperclip className="size-4" /></button><input ref={attachmentInput} hidden multiple type="file" accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm,audio/wav,audio/mpeg,audio/ogg,text/plain,.md" onChange={(event) => { props.onAttachmentsChange([...(event.target.files ?? [])]); event.currentTarget.value = ""; }} />
          <label className="flex max-w-[240px] items-center gap-1 text-xs font-medium text-dls-secondary">
            <span className="hidden sm:inline">{t("toon_factory.text_model")}</span>
            <select value={props.homeTextModel} onChange={(event) => props.onTextModelChange(event.target.value)} className="h-9 max-w-[170px] rounded-xl border border-dls-border bg-background px-2 text-xs text-dls-text">
              <option value="">{t("toon_factory.no_text_selection")}</option>
              {props.textModels.map((model) => <option key={modelValue(model)} value={modelValue(model)}>{model.modelName}</option>)}
            </select>
          </label>
          <button type="submit" disabled={createDisabled} className="ml-auto flex size-10 items-center justify-center rounded-full bg-dls-accent text-white shadow-sm transition-transform hover:scale-105 disabled:opacity-40 motion-reduce:transition-none" aria-label={t("toon_factory.create_project")} data-testid="toon-factory-new-project">{props.creating ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}</button>
        </div>
        {props.attachments.length ? <div className="flex flex-wrap gap-1 border-t border-dls-border bg-[var(--app-list-bg)] px-4 py-2" aria-label={t("toon_factory.attachments")}>{props.attachments.map((file, index) => <button key={`${file.name}:${file.size}:${index}`} type="button" onClick={() => props.onAttachmentsChange(props.attachments.filter((_, candidate) => candidate !== index))} className="rounded-full border border-dls-border bg-background px-2 py-1 text-[10px] text-dls-secondary" title={t("toon_factory.remove_attachment")}>{file.name} ×</button>)}</div> : null}
      </form>
      {props.completedProjectId ? <div className="mx-auto mt-3 flex max-w-4xl items-center justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700" role="status" data-testid="toon-project-created"><span>{t("toon_factory.project_created")}</span><button type="button" className="shrink-0 rounded-lg border border-emerald-500/30 px-3 py-1.5 font-semibold" onClick={props.onOpenCompletedProject}>{t("toon_factory.continue_open_project")}</button></div> : null}
      {props.createError ? <p className="mx-auto mt-3 max-w-4xl rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">{props.createError}</p> : null}
      <section className="mt-14" aria-labelledby="toon-projects-heading" data-testid="toon-factory-project-list">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-dls-border pb-3">
          <div><h2 id="toon-projects-heading" className="text-base font-semibold text-dls-text">{t("toon_factory.projects")}</h2><p className="mt-0.5 text-[11px] text-dls-secondary">{t("toon_factory.project_list_description")}</p></div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => { const directory = window.prompt(t("toon_factory.open_project_prompt")); if (directory?.trim()) props.onOpenProject(directory.trim()); }} title={t("toon_factory.open_project_hint")} className="h-9 rounded-xl border border-dls-border bg-background px-3 text-xs text-dls-secondary">{t("toon_factory.open_project")}</button>
            <button type="button" disabled aria-disabled="true" title={t("toon_factory.toonflow_import_disabled_hint")} className="h-9 rounded-xl border border-dls-border bg-background px-3 text-xs text-dls-secondary opacity-50">{t("toon_factory.import_toonflow")}</button>
            <select value={props.projectFolder} onChange={(event) => props.onProjectFolderChange(event.target.value)} className="h-9 max-w-44 rounded-xl border border-dls-border bg-background px-2 text-xs text-dls-text" aria-label={t("toon_factory.project_folder_filter")}><option value="all">{t("toon_factory.all_folders")}</option>{props.projectFolders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}</select>
            <select value={props.projectSort} onChange={(event) => props.onProjectSortChange(event.target.value as "updated" | "name")} className="h-9 rounded-xl border border-dls-border bg-background px-2 text-xs text-dls-text" aria-label={t("toon_factory.sort_projects")}><option value="updated">{t("toon_factory.sort_updated")}</option><option value="name">{t("toon_factory.sort_name")}</option></select>
            <div className="flex rounded-xl border border-dls-border bg-background p-0.5">
              <button type="button" onClick={() => props.onProjectViewChange("grid")} aria-pressed={props.projectView === "grid"} aria-label={t("toon_factory.grid_view")} className={cn("rounded-lg p-2", props.projectView === "grid" ? "bg-dls-accent text-white" : "text-dls-secondary")}><Grid2X2 className="size-3.5" /></button>
              <button type="button" onClick={() => props.onProjectViewChange("list")} aria-pressed={props.projectView === "list"} aria-label={t("toon_factory.list_view")} className={cn("rounded-lg p-2", props.projectView === "list" ? "bg-dls-accent text-white" : "text-dls-secondary")}><LayoutList className="size-3.5" /></button>
            </div>
          </div>
        </div>
        <div className={cn("mt-5", props.projectView === "grid" ? "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" : "space-y-2")} data-testid="toon-project-grid" data-view={props.projectView}>
          {props.loading ? <SidebarState icon={LoaderCircle} label={t("toon_factory.loading_projects")} spin /> : null}
          {props.error ? <SidebarError message={props.error} onRetry={props.onRetry} /> : null}
          {props.empty ? <div className="col-span-full rounded-2xl border border-dashed border-dls-border bg-background/70"><SidebarState icon={CircleDashed} label={t("toon_factory.no_projects")} detail={t("toon_factory.no_projects_hint")} /></div> : null}
          {props.projects.map((project) => <button key={project.id} type="button" onClick={() => props.onSelectProject(project.id)} className={cn("group border border-dls-border bg-background/90 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-dls-accent/40 hover:shadow-md motion-reduce:transition-none", props.projectView === "grid" ? "min-h-40 rounded-2xl p-4" : "flex items-center gap-4 rounded-xl px-4 py-3")} data-testid={`toon-project-${project.id}`}>
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-dls-accent/10 text-dls-accent"><Folder className="size-5" /></span>
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-dls-text">{project.name}</span><span className="mt-1 block truncate text-[11px] text-dls-secondary">{project.directory}</span><span className="mt-5 flex items-center justify-between gap-3 text-[10px] text-dls-secondary"><span>{t("toon_factory.episode_count", { count: project.episodeCount })}</span><span>{new Date(project.updatedAt).toLocaleString()}</span></span></span>
            <ChevronRight className="size-4 shrink-0 text-dls-secondary transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
          </button>)}
        </div>
      </section>
    </div>
  </main>;
}

function EpisodeWorkbench(props: {
  client: ToonFactoryClient;
  workspaceId: string;
  projectResponse: ToonProjectResponse;
  episode: ToonEpisode;
  selectedStage: ToonWorkflowStage;
  visible: boolean;
  modelSettings: ReactNode;
  modelBlockingReason: ToonModelBlockingReason | null;
  imageGenerationAvailable: boolean;
  videoGenerationAvailable: boolean;
  imageMode: ToonImageGenerationMode;
  videoMode: ToonVideoGenerationMode;
  episodes: ToonEpisode[];
  onSelectEpisode: (episodeId: string) => void;
  onAddEpisode: () => void;
  addingEpisode: boolean;
  onBack: () => void;
  onSelectStage: (stage: ToonWorkflowStage) => void;
  onProjectChange: (response: ToonProjectResponse) => void;
}) {
  const queryClient = useQueryClient();
  const queryScope = toonQueryScope(props.client.baseUrl, props.workspaceId);
  const [canvasDraft, setCanvasDraft] = useState<ToonCanvas | null>(null);
  const [canvasRevision, setCanvasRevision] = useState<string | null>(null);
  const [canvasConflict, setCanvasConflict] = useState(false);
  const [canvasSaveError, setCanvasSaveError] = useState<string | null>(null);
  const [canvasSaving, setCanvasSaving] = useState(false);
  const [skipReasons, setSkipReasons] = useState<Record<string, string>>({});
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [workspaceMode, setWorkspaceMode] = useState<"canvas" | "document">("canvas");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canvasRef = useRef<ToonCanvas | null>(null);
  const revisionRef = useRef<string | null>(null);
  const savedRef = useRef<string>("");
  const conflictRef = useRef(false);
  const savePromiseRef = useRef<Promise<void> | null>(null);

  const canvasKey = toonCanvasKey(queryScope, props.projectResponse.project.id, props.episode.canvasId);
  const canvasQuery = useQuery({
    queryKey: canvasKey,
    queryFn: () => props.client.readToonCanvas(props.workspaceId, props.projectResponse.project.id, props.episode.canvasId),
    enabled: props.visible,
    retry: false,
  });
  const deliveryQuery = useQuery({
    queryKey: toonDeliveryKey(queryScope, props.projectResponse.project.id, props.episode.id),
    queryFn: () => props.client.getToonDeliveryManifest(props.workspaceId, props.projectResponse.project.id, props.episode.id),
    enabled: props.visible && props.selectedStage === "adoption-delivery",
    retry: false,
  });

  useEffect(() => {
    setCanvasDraft(null);
    canvasRef.current = null;
    setCanvasRevision(null);
    revisionRef.current = null;
    savedRef.current = "";
    setCanvasConflict(false);
    conflictRef.current = false;
    setCanvasSaveError(null);
  }, [props.episode.canvasId, props.projectResponse.project.id]);

  useEffect(() => {
    if (!canvasQuery.data) return;
    setCanvasDraft(canvasQuery.data.canvas);
    canvasRef.current = canvasQuery.data.canvas;
    setCanvasRevision(canvasQuery.data.revision);
    revisionRef.current = canvasQuery.data.revision;
    savedRef.current = JSON.stringify(canvasQuery.data.canvas);
    setCanvasConflict(false);
    conflictRef.current = false;
    setCanvasSaveError(null);
  }, [canvasQuery.data]);

  const flushCanvas = async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    if (savePromiseRef.current) await savePromiseRef.current;
    const canvas = canvasRef.current;
    if (!canvas || conflictRef.current || JSON.stringify(canvas) === savedRef.current) return;
    setCanvasSaving(true);
    const save = props.client.writeToonCanvas(props.workspaceId, props.projectResponse.project.id, props.episode.canvasId, {
      canvas,
      ...(revisionRef.current ? { expectedRevision: revisionRef.current } : {}),
    }).then((response) => {
      revisionRef.current = response.revision;
      setCanvasRevision(response.revision);
      savedRef.current = JSON.stringify(response.canvas);
      setCanvasSaveError(null);
    }).catch((error) => {
      if (error instanceof JuggleWorkServerError && error.code === "toon_factory_revision_conflict") {
        conflictRef.current = true;
        setCanvasConflict(true);
      }
      setCanvasSaveError(describeError(error));
    }).finally(() => {
      savePromiseRef.current = null;
      setCanvasSaving(false);
    });
    savePromiseRef.current = save;
    await save;
  };

  const applyCanvasChange = (next: ToonCanvas) => {
    setCanvasDraft(next);
    canvasRef.current = next;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => void flushCanvas(), 650);
  };
  const changeCanvas = (next: ToonCanvas) => {
    const switchingNode = canvasRef.current?.selectedNodeId
      && canvasRef.current.selectedNodeId !== next.selectedNodeId;
    if (switchingNode) {
      void flushToonTextDrafts().then(() => applyCanvasChange(next)).catch(() => undefined);
      return;
    }
    applyCanvasChange(next);
  };

  useEffect(() => {
    if (!props.visible) void flushCanvas();
  }, [props.visible]);

  useEffect(() => {
    const flush = () => { void flushCanvas(); };
    const flushWhenHidden = () => { if (document.visibilityState === "hidden") flush(); };
    if (typeof window === "undefined" || typeof document === "undefined") return () => { void flushCanvas(); };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      void flushCanvas();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", flushWhenHidden);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [props.episode.canvasId, props.projectResponse.project.id]);

  const updateEpisode = async (nextEpisode: ToonEpisode) => {
    const response = await props.client.updateToonProject(props.workspaceId, props.projectResponse.project.id, {
      project: {
        ...props.projectResponse.project,
        episodes: props.projectResponse.project.episodes.map((episode) => episode.id === nextEpisode.id ? nextEpisode : episode),
        updatedAt: new Date().toISOString(),
      },
      expectedRevision: props.projectResponse.revision,
    });
    props.onProjectChange(response);
  };

  const mutateStep = async (stepId: string, update: (step: ToonWorkflowStep, now: string) => ToonWorkflowStep) => {
    const now = new Date().toISOString();
    const steps = updateWorkflowStep(props.episode.steps ?? createEpisodeWorkflowSteps(now, t), stepId, (step) => update(step, now));
    setWorkflowError(null);
    try {
      await updateEpisode(synchronizeEpisodeStages({ ...props.episode, steps, updatedAt: now }, now));
    } catch (error) {
      setWorkflowError(describeError(error));
    }
  };

  const steps = props.episode.steps ?? [];
  const stageSteps = steps.filter((step) => step.stage === props.selectedStage);
  const progress = episodeProgress(props.episode);
  const delivery = episodeDeliveryDescription(props.episode);
  const selectedNode = canvasDraft?.nodes.find((node) => node.id === canvasDraft.selectedNodeId) ?? null;
  const addCanvasNode = (kind: ToonNodeKind) => {
    if (!canvasDraft) return;
    const id = makeIdentifier(kind);
    changeCanvas({ ...canvasDraft, nodes: [...canvasDraft.nodes, createNode(kind, id, canvasDraft.nodes.length)], selectedNodeId: id });
  };
  const runAssistantAction = (action: "canvas" | "storyboard" | "image") => {
    setAssistantOpen(true);
    setMobileInspectorOpen(true);
    if (action === "canvas") {
      props.onSelectStage("content-script");
      if (!canvasDraft?.nodes.some((node) => node.kind === "text")) addCanvasNode("text");
      return;
    }
    if (action === "storyboard") {
      props.onSelectStage("directing-storyboard");
      addCanvasNode("storyboard");
      return;
    }
    props.onSelectStage("images");
    addCanvasNode("image-generation");
  };

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--app-page-bg)]" data-testid="toon-project-workspace">
      <header className="absolute left-3 right-3 top-3 z-50 flex min-h-11 items-center justify-between gap-2 rounded-2xl border border-dls-border bg-background/92 px-2.5 py-1.5 shadow-md backdrop-blur-xl mac:titlebar-no-drag" data-testid="toon-workspace-toolbar">
        <div className="flex min-w-0 items-center gap-1.5">
          <button type="button" onClick={props.onBack} className="rounded-xl p-2 text-dls-secondary hover:bg-dls-hover hover:text-dls-text" aria-label={t("toon_factory.back_to_projects")}><ArrowLeft className="size-4" /></button>
          <span className="hidden max-w-44 truncate text-xs font-semibold text-dls-text sm:block">{props.projectResponse.project.name}</span>
          <label className="flex items-center rounded-xl border border-dls-border bg-[var(--app-list-bg)] px-2 text-xs text-dls-text">
            <select value={props.episode.id} onChange={(event) => props.onSelectEpisode(event.target.value)} className="h-8 max-w-36 bg-transparent outline-none" aria-label={t("toon_factory.select_episode")}>{props.episodes.map((episode) => <option key={episode.id} value={episode.id}>{episode.title}</option>)}</select><ChevronDown className="pointer-events-none size-3 text-dls-secondary" />
          </label>
          <button type="button" onClick={props.onAddEpisode} disabled={props.addingEpisode} className="rounded-xl p-2 text-dls-secondary hover:bg-dls-hover hover:text-dls-text disabled:opacity-40" aria-label={t("toon_factory.add_episode")} data-testid="toon-factory-add-episode"><Plus className="size-4" /></button>
        </div>
        <div className="absolute left-1/2 top-[52px] flex -translate-x-1/2 rounded-xl border border-dls-border bg-background/95 p-0.5 shadow-sm backdrop-blur md:top-auto md:border-0 md:bg-dls-hover md:shadow-none">
          <button type="button" onClick={() => setWorkspaceMode("canvas")} aria-pressed={workspaceMode === "canvas"} className={cn("rounded-lg px-3 py-1.5 text-[11px]", workspaceMode === "canvas" ? "bg-background font-semibold text-dls-accent shadow-sm" : "text-dls-secondary")}>{t("toon_factory.canvas")}</button>
          <button type="button" onClick={() => setWorkspaceMode("document")} aria-pressed={workspaceMode === "document"} className={cn("rounded-lg px-3 py-1.5 text-[11px]", workspaceMode === "document" ? "bg-background font-semibold text-dls-accent shadow-sm" : "text-dls-secondary")}>{t("toon_factory.document")}</button>
        </div>
        <div className="flex items-center gap-2">
          {props.modelSettings}
          <span role="status" aria-live="polite" className={cn("hidden items-center gap-1 text-[10px] sm:flex", canvasConflict || canvasSaveError ? "text-destructive" : "text-dls-secondary")} data-testid="toon-canvas-save-status">{canvasSaving ? <LoaderCircle className="size-3 animate-spin" /> : <Save className="size-3" />}{canvasConflict ? t("toon_factory.save_conflict") : canvasSaveError ?? (canvasSaving ? t("toon_factory.saving") : t("toon_factory.saved"))}</span>
          <button type="button" onClick={() => setAssistantOpen((open) => !open)} aria-pressed={assistantOpen} className={cn("rounded-xl p-2", assistantOpen ? "bg-dls-active text-dls-accent" : "text-dls-secondary hover:bg-dls-hover")} aria-label={assistantOpen ? t("toon_factory.close_assistant") : t("toon_factory.open_assistant")} data-testid="toon-assistant-toggle"><MessageSquare className="size-4" /></button>
        </div>
      </header>
      {canvasConflict ? <div className="absolute left-3 right-3 top-16 z-40"><ConflictBanner message={t("toon_factory.conflict_description")} onReload={() => { conflictRef.current = false; setCanvasConflict(false); void canvasQuery.refetch(); }} compact /></div> : null}
      <div className={cn("relative grid h-full min-h-0 overflow-hidden", assistantOpen ? "grid-cols-[minmax(0,1fr)_360px] max-[900px]:grid-cols-1" : "grid-cols-1")}>
        <div className="relative min-h-0 overflow-hidden">
          {canvasQuery.isLoading ? <MainState label={t("toon_factory.loading_canvas")} /> : null}
          {canvasQuery.error ? <MainError message={describeError(canvasQuery.error)} onRetry={() => void canvasQuery.refetch()} /> : null}
          {canvasDraft && props.visible && workspaceMode === "canvas" ? <ToonLegacyCanvas canvas={canvasDraft} onChange={changeCanvas} imageGenerationAvailable={props.imageGenerationAvailable} videoGenerationAvailable={props.videoGenerationAvailable} /> : null}
          {canvasDraft && props.visible && workspaceMode === "document" ? <div className="h-full overflow-y-auto px-5 pb-10 pt-20 sm:px-10"><div className="mx-auto max-w-3xl rounded-2xl border border-dls-border bg-background p-5 shadow-sm" data-testid="toon-document-workspace"><h2 className="text-sm font-semibold text-dls-text">{t("toon_factory.document_workspace")}</h2><p className="mt-1 text-xs text-dls-secondary">{t("toon_factory.document_workspace_hint")}</p>{selectedNode ? <TextInspector key={`document:${props.projectResponse.project.id}:${props.episode.id}:${selectedNode.id}`} client={props.client} workspaceId={props.workspaceId} project={props.projectResponse} episode={props.episode} node={selectedNode} visible={props.visible} onProjectChange={props.onProjectChange} /> : <p className="mt-8 rounded-xl bg-[var(--app-list-bg)] p-5 text-center text-xs text-dls-secondary">{t("toon_factory.select_node_hint")}</p>}</div></div> : null}
          {canvasDraft && !props.visible ? <div data-testid="toon-canvas-suspended" /> : null}
        </div>
        {assistantOpen ? <button type="button" className="absolute bottom-4 right-4 z-40 hidden rounded-full bg-dls-accent px-3 py-2 text-[10px] font-semibold text-white shadow-lg max-[900px]:block" aria-expanded={mobileInspectorOpen} onClick={() => setMobileInspectorOpen((open) => !open)} data-testid="toon-factory-inspector-tab">{mobileInspectorOpen ? t("toon_factory.close_assistant") : t("toon_factory.open_assistant")}</button> : null}
        {assistantOpen ? <aside className={cn("m-3 ml-0 mt-[68px] min-h-0 overflow-y-auto rounded-2xl border border-dls-border bg-background/95 p-3 shadow-lg backdrop-blur-xl max-[900px]:absolute max-[900px]:inset-x-3 max-[900px]:bottom-3 max-[900px]:z-30 max-[900px]:m-0 max-[900px]:max-h-[72%] max-[900px]:rounded-2xl", !mobileInspectorOpen && "max-[900px]:hidden")} data-testid="toon-assistant-panel">
          <div data-testid="toon-factory-inspector">
          <div className="flex items-center justify-between border-b border-dls-border pb-3"><div className="flex items-center gap-2"><span className="flex size-8 items-center justify-center rounded-xl bg-dls-accent/10 text-dls-accent"><Bot className="size-4" /></span><div><h2 className="text-xs font-semibold text-dls-text">{t("toon_factory.assistant_title")}</h2><p className="text-[9px] text-dls-secondary">{t("toon_factory.assistant_context")}</p></div></div><button type="button" onClick={() => setAssistantOpen(false)} className="rounded-lg p-1.5 text-dls-secondary hover:bg-dls-hover" aria-label={t("toon_factory.close_assistant")}><X className="size-4" /></button></div>
          <section className="py-4"><p className="text-[10px] text-dls-secondary">{t("toon_factory.assistant_welcome")}</p><h3 className="mt-1 text-base font-semibold text-dls-text">{t("toon_factory.assistant_start")}</h3><p className="mt-1 text-[11px] leading-5 text-dls-secondary">{t("toon_factory.assistant_description")}</p><div className="mt-3 space-y-2">
            <AssistantAction testId="toon-assistant-build-canvas" icon={Sparkles} title={t("toon_factory.action_build_canvas")} description={t("toon_factory.action_build_canvas_hint")} onClick={() => runAssistantAction("canvas")} />
            <AssistantAction testId="toon-assistant-add-storyboard" icon={FileText} title={t("toon_factory.assistant_action_storyboard")} description={t("toon_factory.action_storyboard_hint")} onClick={() => runAssistantAction("storyboard")} />
            <AssistantAction testId="toon-assistant-add-image" icon={Image} title={t("toon_factory.action_image_material")} description={t("toon_factory.action_image_material_hint")} onClick={() => runAssistantAction("image")} disabled={!props.imageGenerationAvailable} disabledHint={t("toon_factory.image_model_required")} />
          </div></section>
          <nav className="flex gap-1 overflow-x-auto border-y border-dls-border py-2" aria-label={t("toon_factory.stages")}>{STAGES.map((stage, index) => {
            const stageRecords = steps.filter((step) => step.stage === stage);
            const done = stageRecords.length > 0 && stageRecords.every((step) => ["approved", "adopted", "skipped"].includes(step.status));
            const status = done ? t("toon_factory.stage_status_complete") : t("toon_factory.stage_status_in_progress");
            return <button key={stage} type="button" onClick={() => props.onSelectStage(stage)} aria-pressed={props.selectedStage === stage} aria-label={`${t(STAGE_LABELS[stage])}: ${status}`} title={t(STAGE_LABELS[stage])} className={cn("flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-[10px]", props.selectedStage === stage ? "bg-dls-active font-semibold text-dls-text" : "text-dls-secondary hover:bg-dls-hover")} data-testid={`toon-factory-stage-${stage}`}><span className={cn("flex size-4 items-center justify-center rounded-full text-[8px]", done ? "bg-emerald-500 text-white" : "bg-dls-hover")}>{done ? <Check className="size-2.5" /> : index + 1}</span></button>;
          })}</nav>
          {props.selectedStage === "adoption-delivery" ? <DeliveryPanel client={props.client} workspaceId={props.workspaceId} projectId={props.projectResponse.project.id} episode={props.episode} delivery={delivery} visible={props.visible} /> : null}
          <section>
            <h3 className="mt-3 text-xs font-semibold text-dls-text">{t("toon_factory.stage_steps")}</h3>
            {props.modelBlockingReason ? <ModelBlockingState reason={props.modelBlockingReason} /> : null}
             {workflowError ? <div className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-[10px] text-destructive" role="alert">{workflowError}<button type="button" className="ml-2 underline" onClick={() => { setWorkflowError(null); void queryClient.invalidateQueries({ queryKey: toonProjectKey(queryScope, props.projectResponse.project.id), exact: true }); }}>{t("toon_factory.reload")}</button></div> : null}
            <div className="mt-2 space-y-2">
              {stageSteps.length === 0 ? <p className="text-xs text-dls-secondary">{t("toon_factory.workflow_not_initialized")}</p> : stageSteps.map((step) => {
                const approvalRevision = workflowApprovalRevision(step, {
                  deliveryManifestRevision: deliveryManifestIsCurrent(props.episode, deliveryQuery.data?.manifest) ? deliveryQuery.data?.revision : null,
                });
                const approvalUnavailable = !approvalRevision;
                return (
                 <div key={step.id} className="rounded-xl border border-dls-border p-3" data-testid={`toon-step-${step.id}`}>
                  <div className="flex items-start justify-between gap-2"><span className="text-xs font-medium text-dls-text">{step.title}</span><StatusBadge status={step.status} /></div>
                  <DecisionSummary step={step} />
                  {step.skipReason ? <p className="mt-2 text-[10px] text-dls-secondary">{t("toon_factory.skip_reason")}: {step.skipReason}</p> : null}
                   {step.staleReason ? <p className="mt-2 text-[10px] text-amber-600">{t("toon_factory.stale_reason")}: {step.staleReason.startsWith("upstream:") ? t("toon_factory.stale_upstream_changed") : t("toon_factory.stale_unknown")}</p> : null}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button type="button" className="rounded-md bg-dls-active px-2 py-1 text-[10px] text-dls-text disabled:opacity-40" disabled={approvalUnavailable || step.status === "approved" || !workflowStepAvailable(steps, step)} onClick={() => approvalRevision && void mutateStep(step.id, (current, now) => approveWorkflowStep(current, approvalRevision, now))}>{t("toon_factory.approve_content")}</button>
                  </div>
                  {approvalUnavailable ? <p className="mt-1 text-[9px] text-dls-secondary" data-testid={`toon-step-approval-requirement-${step.id}`}>{step.id === "delivery-manifest" ? t("toon_factory.approval_requires_manifest") : step.id === "image-candidates" || step.id === "video-clips" || step.id === "adopt-clips" ? t("toon_factory.approval_requires_adoption") : t("toon_factory.approval_requires_output_revision")}</p> : null}
                  <div className="mt-2 flex gap-1.5"><input className="min-w-0 flex-1 rounded-md border border-dls-border bg-background px-2 py-1 text-[10px] text-dls-text" value={skipReasons[step.id] ?? ""} onChange={(event) => setSkipReasons((current) => ({ ...current, [step.id]: event.target.value }))} placeholder={t("toon_factory.skip_reason_placeholder")} /><button type="button" disabled={!(skipReasons[step.id] ?? "").trim()} className="rounded-md border border-dls-border px-2 py-1 text-[10px] disabled:opacity-40" onClick={() => void mutateStep(step.id, (current, now) => skipWorkflowStep(current, skipReasons[step.id] ?? "", now))}>{t("toon_factory.skip")}</button></div>
                </div>
                );
              })}
            </div>
          </section>
          {selectedNode && ["content-script", "assets", "directing-storyboard"].includes(props.selectedStage) ? (
            <TextGenerationPanel
              client={props.client}
              workspaceId={props.workspaceId}
              project={props.projectResponse}
              episode={props.episode}
              node={selectedNode}
              selectedStage={props.selectedStage}
              visible={props.visible}
              modelBlockingReason={props.modelBlockingReason}
              onProjectChange={props.onProjectChange}
            />
          ) : null}
          {selectedNode && (props.selectedStage === "images" || props.selectedStage === "videos") ? <MediaGenerationPanel client={props.client} workspaceId={props.workspaceId} project={props.projectResponse} episode={props.episode} node={selectedNode} kind={props.selectedStage === "images" ? "image" : "video"} imageMode={props.imageMode} videoMode={props.videoMode} modelBlockingReason={props.modelBlockingReason} visible={props.visible} /> : null}
          {workspaceMode === "canvas" && selectedNode && !["images", "videos"].includes(props.selectedStage) ? <TextInspector key={`${props.projectResponse.project.id}:${props.episode.id}:${selectedNode.id}`} client={props.client} workspaceId={props.workspaceId} project={props.projectResponse} episode={props.episode} node={selectedNode} visible={props.visible} onProjectChange={props.onProjectChange} /> : !selectedNode ? <p className="mt-4 text-center text-xs text-dls-secondary">{t("toon_factory.select_node_hint")}</p> : null}
          </div>
        </aside> : null}
      </div>
    </div>
  );
}

function AssistantAction(props: { testId: string; icon: typeof Sparkles; title: string; description: string; onClick: () => void; disabled?: boolean; disabledHint?: string }) {
  const Icon = props.icon;
  return <button type="button" onClick={props.onClick} disabled={props.disabled} title={props.disabled ? props.disabledHint : undefined} className="flex w-full items-center gap-3 rounded-xl bg-[var(--app-list-bg)] p-3 text-left hover:bg-dls-hover disabled:cursor-not-allowed disabled:opacity-45" data-testid={props.testId}><Icon className="size-4 shrink-0 text-dls-secondary" /><span className="min-w-0 flex-1"><strong className="block text-[11px] text-dls-text">{props.title}</strong><span className="mt-0.5 block text-[10px] text-dls-secondary">{props.disabled ? props.disabledHint : props.description}</span></span><ChevronRight className="size-3.5 text-dls-secondary" /></button>;
}

function saveDownload(download: { data: ArrayBuffer; contentType: string | null; filename: string | null }, fallbackName: string): void {
  const url = URL.createObjectURL(new Blob([download.data], { type: download.contentType ?? "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = download.filename ?? fallbackName;
  try {
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function DeliveryPanel(props: { client: ToonFactoryClient; workspaceId: string; projectId: string; episode: ToonEpisode; delivery: ReturnType<typeof episodeDeliveryDescription>; visible?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const queryScope = toonQueryScope(props.client.baseUrl, props.workspaceId);
  const manifestQuery = useQuery({
    queryKey: toonDeliveryKey(queryScope, props.projectId, props.episode.id),
    queryFn: () => props.client.getToonDeliveryManifest(props.workspaceId, props.projectId, props.episode.id),
    enabled: props.visible ?? true,
    retry: false,
  });
  const create = useMutation({
    mutationFn: () => props.client.createToonDeliveryManifest(props.workspaceId, props.projectId, props.episode.id, { expectedRevision: manifestQuery.data?.revision ?? null }),
    onSuccess: (response) => { manifestQuery.refetch(); setError(null); return response; },
    onError: (cause) => setError(describeError(cause)),
  });
  const download = async (operation: () => Promise<{ data: ArrayBuffer; contentType: string | null; filename: string | null }>, fallbackName: string) => {
    setError(null);
    try { saveDownload(await operation(), fallbackName); } catch (cause) { setError(describeError(cause)); }
  };
  const manifest = manifestQuery.data?.manifest;
  const stale = Boolean(manifest && !deliveryManifestIsCurrent(props.episode, manifest));
  return <section className="mt-3 rounded-xl border border-dls-border bg-[var(--app-list-bg)] p-3" data-testid="toon-truthful-delivery">
    <h3 className="text-xs font-semibold text-dls-text">{t("toon_factory.delivery_title")}</h3>
    <p className="mt-1 text-[11px] leading-5 text-dls-secondary">{props.delivery === "adopted-clips-manifest" ? t("toon_factory.delivery_adopted_clips_manifest") : t("toon_factory.delivery_no_adopted_clips")}</p>
    <p className="mt-1 text-[10px] font-medium text-amber-600" data-testid="toon-delivery-out-of-scope">{t("toon_factory.delivery_not_film")}</p>
    <p className="mt-1 text-[9px] text-dls-secondary">{t("toon_factory.delivery_out_of_scope")}</p>
    <div className="mt-3 flex flex-wrap gap-1.5">
      <button data-testid="toon-create-manifest" type="button" className="rounded-md bg-dls-accent px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40" disabled={create.isPending} onClick={() => create.mutate()}>{create.isPending ? t("toon_factory.creating_manifest") : t("toon_factory.create_manifest")}</button>
      {manifest ? <button data-testid="toon-download-manifest" type="button" disabled={stale} className="flex items-center gap-1 rounded-md border border-dls-border px-2 py-1 text-[10px] text-dls-text disabled:opacity-40" onClick={() => void download(() => props.client.downloadToonDeliveryManifest(props.workspaceId, props.projectId, props.episode.id), `${props.episode.id}-delivery-manifest.json`)}><Download className="size-3" />{t("toon_factory.download_manifest")}</button> : null}
    </div>
    {manifestQuery.isLoading ? <p className="mt-2 text-[10px] text-dls-secondary">{t("toon_factory.loading_manifest")}</p> : null}
    {error || manifestQuery.error ? <p className="mt-2 text-[10px] text-destructive">{error ?? describeError(manifestQuery.error)}</p> : null}
    {stale ? <p className="mt-2 text-[10px] text-amber-700" role="status" data-testid="toon-delivery-stale">{t("toon_factory.delivery_stale")}</p> : manifest ? <p className="mt-2 text-[10px] text-emerald-700" role="status" data-testid="toon-delivery-current">{t("toon_factory.delivery_current")}</p> : null}
    {manifest ? <>
      <div className="mt-3" data-testid="toon-delivery-artifacts"><p className="text-[10px] font-semibold text-dls-text">{t("toon_factory.adopted_outputs")}</p>{manifest.artifacts.length ? manifest.artifacts.map((artifact) => <div key={artifact.id} className="mt-1 flex items-center justify-between gap-2 rounded-lg border border-dls-border bg-background p-2"><span className="min-w-0"><span className="block text-[10px] font-medium text-dls-text">{artifact.kind === "video" ? t("toon_factory.adopted_clip") : t("toon_factory.adopted_image")}</span><span className="block truncate text-[9px] text-dls-secondary">{artifact.path}</span></span><button type="button" disabled={stale} className="shrink-0 rounded-md border border-dls-border p-1.5 text-dls-secondary disabled:opacity-40" aria-label={t("toon_factory.download_artifact")} onClick={() => void download(() => props.client.downloadToonDeliveryArtifact(props.workspaceId, props.projectId, props.episode.id, artifact.id), artifact.path.split("/").pop() ?? "artifact")}><Download className="size-3" /></button></div>) : <p className="mt-1 text-[9px] text-dls-secondary">{t("toon_factory.no_valid_adopted_outputs")}</p>}</div>
      <div className="mt-3" data-testid="toon-delivery-omissions"><p className="text-[10px] font-semibold text-dls-text">{t("toon_factory.missing_outputs")}</p>{manifest.omissions.length ? manifest.omissions.map((omission, index) => <p key={`${omission.code}:${index}`} className="mt-1 text-[9px] leading-4 text-amber-700">{t(`toon_factory.media_kind_${omission.kind}`)}: {t(`toon_factory.omission_${omission.code}`)}</p>) : <p className="mt-1 text-[9px] text-dls-secondary">{t("toon_factory.no_reported_omissions")}</p>}</div>
    </> : null}
  </section>;
}

const ACTION_STAGE: Record<ToonTextGenerationAction, ToonWorkflowStage> = {
  script: "content-script",
  "asset-plan": "assets",
  storyboard: "directing-storyboard",
};

const ACTION_STEP: Record<ToonTextGenerationAction, string> = {
  script: "episode-script",
  "asset-plan": "asset-plan",
  storyboard: "storyboard",
};

function actionForStage(stage: ToonWorkflowStage): ToonTextGenerationAction {
  if (stage === "assets") return "asset-plan";
  if (stage === "directing-storyboard") return "storyboard";
  return "script";
}

function TextGenerationPanel(props: {
  client: ToonFactoryClient;
  workspaceId: string;
  project: ToonProjectResponse;
  episode: ToonEpisode;
  node: ToonNode;
  selectedStage: ToonWorkflowStage;
  visible: boolean;
  modelBlockingReason: ToonModelBlockingReason | null;
  onProjectChange: (response: ToonProjectResponse) => void;
}) {
  const queryClient = useQueryClient();
  const [action, setAction] = useState<ToonTextGenerationAction>(() => actionForStage(props.selectedStage));
  const [prompt, setPrompt] = useState("");
  const [approvedFingerprint, setApprovedFingerprint] = useState<string | null>(null);
  const queryScope = toonQueryScope(props.client.baseUrl, props.workspaceId);
  const targetStep = (props.episode.steps ?? []).find((step) => step.id === ACTION_STEP[action]);
  const targetAvailable = props.selectedStage === ACTION_STAGE[action]
    && Boolean(targetStep && workflowStepAvailable(props.episode.steps ?? [], targetStep));
  const [jobId, setJobId] = useState<string | null>(targetStep?.generationJobId ?? null);
  const selectedModel = props.project.project.selectedModels?.text;
  const request: ToonTextJobCreateRequest | null = selectedModel ? {
    action,
    prompt: prompt.trim(),
    episodeId: props.episode.id,
    canvasId: props.episode.canvasId,
    nodeId: props.node.id,
    stage: ACTION_STAGE[action],
    selectedModel,
    outputSchema: TOON_TEXT_OUTPUT_SCHEMAS[action],
    contentApproved: true,
  } : null;
  const requestFingerprint = selectedModel ? toonTextRequestFingerprint({
    workspaceId: props.workspaceId,
    projectId: props.project.project.id,
    episodeId: props.episode.id,
    canvasId: props.episode.canvasId,
    nodeId: props.node.id,
    selectedModel,
    action,
    prompt: prompt.trim(),
    outputSchema: TOON_TEXT_OUTPUT_SCHEMAS[action],
  }) : null;
  const approved = Boolean(requestFingerprint && approvedFingerprint === requestFingerprint);

  useEffect(() => {
    const nextAction = actionForStage(props.selectedStage);
    setAction(nextAction);
    setJobId((props.episode.steps ?? []).find((step) => step.id === ACTION_STEP[nextAction])?.generationJobId ?? null);
    setApprovedFingerprint(null);
  }, [props.episode.id, props.selectedStage]);

  const jobQuery = useQuery({
    queryKey: toonTextJobKey(queryScope, props.project.project.id, jobId ?? "none"),
    queryFn: () => props.client.getToonTextJob(props.workspaceId, props.project.project.id, jobId!),
    enabled: props.visible && Boolean(jobId),
    retry: false,
    refetchInterval: (query) => {
      const status = query.state.data?.job.status;
      if (!props.visible) return false;
      if (query.state.data?.job.projectionPending) return 750;
      return status && ["completed", "failed", "cancelled"].includes(status) ? false : 750;
    },
  });
  const createJob = useMutation({
    mutationFn: () => {
      if (!request || !request.prompt) throw new Error(t("toon_factory.text_prompt_required"));
      return props.client.createToonTextJob(props.workspaceId, props.project.project.id, request);
    },
    onSuccess: ({ job }) => {
      setJobId(job.id);
      queryClient.setQueryData(toonTextJobKey(queryScope, props.project.project.id, job.id), { job });
      void queryClient.invalidateQueries({ queryKey: toonProjectKey(queryScope, props.project.project.id), exact: true });
    },
  });
  const cancelJob = useMutation({
    mutationFn: () => props.client.cancelToonTextJob(props.workspaceId, props.project.project.id, jobId!),
    onSuccess: (response) => queryClient.setQueryData(toonTextJobKey(queryScope, props.project.project.id, response.job.id), response),
  });
  useEffect(() => {
    if (jobQuery.data?.job.status === "completed") {
      void queryClient.invalidateQueries({ queryKey: toonProjectKey(queryScope, props.project.project.id), exact: true });
    }
  }, [jobQuery.data?.job.status, props.project.project.id, props.workspaceId, queryClient]);

  const job: ToonTextJob | undefined = jobQuery.data?.job;
  const running = createJob.isPending || job?.status === "queued" || job?.status === "running" || job?.status === "cancel_requested";
  return <section className="mt-4 rounded-xl border border-dls-border p-3" data-testid="toon-text-generation">
    <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-semibold text-dls-text">{t("toon_factory.text_generation")}</h3>{job ? <StatusBadge status={job.status === "completed" ? "awaiting-review" : job.status === "cancel_requested" ? "running" : job.status} /> : null}</div>
    <label className="mt-2 block text-[10px] text-dls-secondary">{t("toon_factory.generation_action")}<select data-testid="toon-text-action" className="mt-1 h-8 w-full rounded-md border border-dls-border bg-background px-2 text-[10px] text-dls-text" value={action} disabled={running} onChange={(event) => { const next = event.target.value as ToonTextGenerationAction; setAction(next); setJobId((props.episode.steps ?? []).find((step) => step.id === ACTION_STEP[next])?.generationJobId ?? null); setApprovedFingerprint(null); }}><option value="script">{t("toon_factory.action_script")}</option><option value="asset-plan">{t("toon_factory.action_asset_plan")}</option><option value="storyboard">{t("toon_factory.action_storyboard")}</option></select></label>
    <textarea data-testid="toon-text-prompt" className="mt-2 min-h-24 w-full resize-y rounded-lg border border-dls-border bg-[var(--app-list-bg)] p-2 text-[10px] leading-4 text-dls-text" value={prompt} disabled={running} onChange={(event) => { setPrompt(event.target.value); }} placeholder={t("toon_factory.text_generation_prompt")} />
    <div className="mt-2 rounded-lg bg-[var(--app-list-bg)] p-2"><p className="text-[9px] font-semibold uppercase tracking-wide text-dls-secondary">{t("toon_factory.exact_request_preview")}</p><pre data-testid="toon-text-request-preview" className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[9px] leading-4 text-dls-secondary">{request ? JSON.stringify(request, null, 2) : t("toon_factory.select_text_model_first")}</pre></div>
    <label className="mt-2 flex items-start gap-2 text-[10px] leading-4 text-dls-secondary"><input data-testid="toon-text-content-approval" type="checkbox" checked={approved} disabled={running || !prompt.trim() || !requestFingerprint || !targetAvailable} onChange={(event) => setApprovedFingerprint(event.target.checked ? requestFingerprint : null)} /><span>{t("toon_factory.confirm_text_request")}</span></label>
    {!targetAvailable ? <p className="mt-2 text-[9px] text-amber-600">{t("toon_factory.workflow_prerequisite_incomplete")}</p> : null}
    {props.modelBlockingReason ? <ModelBlockingState reason={props.modelBlockingReason} compact /> : null}
    {createJob.error || jobQuery.error || cancelJob.error ? <p className="mt-2 text-[10px] text-destructive">{describeError(createJob.error ?? jobQuery.error ?? cancelJob.error)}</p> : null}
    {job?.error ? <p className="mt-2 text-[10px] text-destructive" data-testid="toon-text-job-error" role="alert">{describeGenerationError(job.error.code)}</p> : null}
    {job?.result ? <div className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2 text-[10px] text-dls-text" data-testid="toon-text-job-result"><strong>{t("toon_factory.awaiting_review")}</strong><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[9px] text-dls-secondary">{JSON.stringify(job.result.output, null, 2)}</pre><p className="mt-1 text-[9px] text-dls-secondary">{job.result.contentRef}</p></div> : null}
    <div className="mt-2 flex gap-2"><button data-testid="toon-text-run" type="button" className="rounded-md bg-dls-accent px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40" disabled={!approved || !prompt.trim() || !request || Boolean(props.modelBlockingReason) || running || !targetAvailable} onClick={() => createJob.mutate()}>{running ? t("toon_factory.text_job_running") : t("toon_factory.run_text_generation")}</button>{job && ["queued", "running"].includes(job.status) ? <button data-testid="toon-text-cancel" type="button" className="rounded-md border border-dls-border px-2 py-1 text-[10px] text-dls-secondary" disabled={cancelJob.isPending} onClick={() => cancelJob.mutate()}>{t("toon_factory.cancel_generation")}</button> : null}</div>
  </section>;
}

const MEDIA_TERMINAL = new Set(["awaiting-review", "adopted", "failed", "cancelled", "submission_unknown"]);

function MediaGenerationPanel(props: {
  client: ToonFactoryClient;
  workspaceId: string;
  project: ToonProjectResponse;
  episode: ToonEpisode;
  node: ToonNode;
  kind: "image" | "video";
  imageMode: ToonImageGenerationMode;
  videoMode: ToonVideoGenerationMode;
  modelBlockingReason: ToonModelBlockingReason | null;
  visible: boolean;
}) {
  const queryClient = useQueryClient();
  const queryScope = toonQueryScope(props.client.baseUrl, props.workspaceId);
  const selectedModel = props.project.project.selectedModels?.[props.kind];
  const [objectName, setObjectName] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [prompt, setPrompt] = useState("");
  const [references, setReferences] = useState("");
  const [referenceScope, setReferenceScope] = useState<ToonReferenceScope>("workspace");
  const [size, setSize] = useState("1024x1024");
  const [durationSeconds, setDurationSeconds] = useState(5);
  const [resolution, setResolution] = useState("720p");
  const [authorization, setAuthorization] = useState<{ id: string; requestId: string; planFingerprint: string; localFingerprint: string; planSummary: ToonMediaGenerationPlan } | null>(null);
  const [retryOf, setRetryOf] = useState<string | undefined>();
  const requestIdRef = useRef(makeIdentifier("media-request"));
  const referencePaths = references.split("\n").map((path) => path.trim()).filter(Boolean);
  const stepId = props.kind === "image" ? "image-candidates" : "video-clips";
  const plan: ToonMediaGenerationPlan | null = selectedModel ? props.kind === "image" ? {
    kind: "image",
    model: selectedModel,
    object: objectName.trim() || props.node.data.label || props.node.id,
    quantity,
    prompt: prompt.trim(),
    referencePaths,
    referenceScope,
    mode: props.imageMode,
    size: size || undefined,
    executionCount: quantity,
    knownCost: null,
  } : {
    kind: "video",
    model: selectedModel,
    object: objectName.trim() || props.node.data.label || props.node.id,
    quantity,
    prompt: prompt.trim(),
    referencePaths,
    referenceScope,
    mode: props.videoMode,
    durationSeconds,
    resolution,
    executionCount: quantity,
    knownCost: null,
  } : null;
  const authorizationRequest = plan ? {
    requestId: requestIdRef.current,
    episodeId: props.episode.id,
    canvasId: props.episode.canvasId,
    nodeId: props.node.id,
    stepId,
    plan,
    ...(retryOf ? { retryOf } : {}),
  } : null;
  const planFingerprint = JSON.stringify(authorizationRequest);
  const planFingerprintRef = useRef(planFingerprint);
  planFingerprintRef.current = planFingerprint;

  useEffect(() => { setAuthorization(null); }, [planFingerprint]);
  useEffect(() => {
    requestIdRef.current = makeIdentifier("media-request");
    setAuthorization(null);
    setRetryOf(undefined);
  }, [props.node.id, props.kind]);

  const jobsQuery = useQuery({
    queryKey: toonMediaJobsKey(queryScope, props.project.project.id),
    queryFn: () => props.client.listToonMediaJobs(props.workspaceId, props.project.project.id),
    enabled: props.visible,
    retry: false,
    refetchInterval: (query) => props.visible && query.state.data?.items.some((job) => !MEDIA_TERMINAL.has(job.status) || job.projectionPending) ? 1_000 : false,
  });
  const authorize = useMutation({
    mutationFn: (request: NonNullable<typeof authorizationRequest>) => {
      if (!request.plan.prompt) throw new Error(t("toon_factory.media_prompt_required"));
      return props.client.authorizeToonMediaJob(props.workspaceId, props.project.project.id, request);
    },
    onSuccess: (response, request) => {
      const localFingerprint = JSON.stringify(request);
      if (localFingerprint !== planFingerprintRef.current || response.requestSnapshot.requestId !== request.requestId || JSON.stringify(response.planSummary) !== JSON.stringify(request.plan)) return;
      setAuthorization({ id: response.authorizationId, requestId: response.requestSnapshot.requestId, planFingerprint: response.planFingerprint, localFingerprint, planSummary: response.planSummary });
    },
  });
  const create = useMutation({
    mutationFn: () => {
      if (!authorizationRequest || !authorization || authorization.localFingerprint !== planFingerprint || authorization.requestId !== authorizationRequest.requestId) throw new Error(t("toon_factory.media_authorization_required"));
      const input = { authorizationId: authorization.id, expectedPlanFingerprint: authorization.planFingerprint };
      return retryOf
        ? props.client.retryToonMediaJob(props.workspaceId, props.project.project.id, retryOf, input)
        : props.client.createToonMediaJob(props.workspaceId, props.project.project.id, input);
    },
    onSuccess: ({ job }) => {
      queryClient.setQueryData(toonMediaJobsKey(queryScope, props.project.project.id), (current: { items: ToonMediaJob[] } | undefined) => ({ items: [job, ...(current?.items.filter((item) => item.id !== job.id) ?? [])] }));
      requestIdRef.current = makeIdentifier("media-request");
      setAuthorization(null);
      setRetryOf(undefined);
      void queryClient.invalidateQueries({ queryKey: toonProjectKey(queryScope, props.project.project.id), exact: true });
    },
  });
  const cancel = useMutation({
    mutationFn: (jobId: string) => props.client.cancelToonMediaJob(props.workspaceId, props.project.project.id, jobId),
    onSuccess: () => void jobsQuery.refetch(),
  });
  const review = useMutation({
    mutationFn: ({ jobId, candidateId, decision }: { jobId: string; candidateId: string; decision: "adopt" | "reject" }) => props.client.reviewToonMediaJob(props.workspaceId, props.project.project.id, jobId, candidateId, decision),
    onSuccess: () => {
      void jobsQuery.refetch();
      void queryClient.invalidateQueries({ queryKey: toonProjectKey(queryScope, props.project.project.id), exact: true });
      void queryClient.invalidateQueries({ queryKey: toonDeliveryKey(queryScope, props.project.project.id, props.episode.id), exact: true });
    },
  });
  const retry = (job: ToonMediaJob) => {
    const prior = job.requestSnapshot.plan;
    setObjectName(prior.object);
    setQuantity(prior.quantity);
    setPrompt(prior.prompt);
    setReferences(prior.referencePaths.join("\n"));
    setReferenceScope(prior.referenceScope);
    setQuantity(prior.executionCount);
    if (prior.kind === "image") setSize(prior.size ?? "");
    else { setDurationSeconds(prior.durationSeconds); setResolution(prior.resolution); }
    requestIdRef.current = makeIdentifier("media-retry");
    setRetryOf(job.id);
    setAuthorization(null);
  };
  const validReferences = props.kind === "image"
    ? props.imageMode === "text-to-image" ? referencePaths.length === 0 : props.imageMode === "image-to-image" ? referencePaths.length === 1 : referencePaths.length >= 2
    : props.videoMode === "text-to-video" ? referencePaths.length === 0 : referencePaths.length === 1;
  const valid = Boolean(plan?.prompt && objectName.trim() && validReferences && !props.modelBlockingReason);
  const targetStep = (props.episode.steps ?? []).find((step) => step.id === stepId);
  const targetAvailable = Boolean(targetStep && workflowStepAvailable(props.episode.steps ?? [], targetStep));
  const adoptedImage = jobsQuery.data?.items.flatMap((job) => job.kind === "image" && job.episodeId === props.episode.id
    ? job.candidates.filter((candidate) => candidate.status === "adopted" && candidate.artifact).map((candidate) => candidate.artifact!)
    : []).at(0);
  const scopedJobs = jobsQuery.data?.items.filter((job) => job.episodeId === props.episode.id && job.nodeId === props.node.id && job.kind === props.kind) ?? [];
  const error = authorize.error ?? create.error ?? cancel.error ?? review.error ?? jobsQuery.error;

  return <section className="mt-4 rounded-xl border border-dls-border p-3" data-testid="toon-media-generation">
    <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-semibold text-dls-text">{props.kind === "image" ? t("toon_factory.image_generation") : t("toon_factory.video_generation")}</h3>{authorization?.localFingerprint === planFingerprint && authorization.requestId === authorizationRequest?.requestId ? <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[9px] text-blue-600">{t("toon_factory.authorized_exact_plan")}</span> : null}</div>
    <div className="mt-2 grid grid-cols-2 gap-2">
      <label className="text-[9px] text-dls-secondary">{t("toon_factory.media_object")}<input data-testid="toon-media-object" className="mt-1 h-8 w-full rounded-md border border-dls-border bg-background px-2 text-[10px] text-dls-text" value={objectName} onChange={(event) => setObjectName(event.target.value)} /></label>
      <label className="text-[9px] text-dls-secondary">{t("toon_factory.media_quantity")}<input className="mt-1 h-8 w-full rounded-md border border-dls-border bg-background px-2 text-[10px] text-dls-text" type="number" min={1} max={1000} value={quantity} onChange={(event) => setQuantity(Math.max(1, Number(event.target.value) || 1))} /></label>
    </div>
    <textarea data-testid="toon-media-prompt" className="mt-2 min-h-24 w-full resize-y rounded-lg border border-dls-border bg-[var(--app-list-bg)] p-2 text-[10px] leading-4 text-dls-text" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t("toon_factory.media_prompt")} />
    <label className="mt-2 block text-[9px] text-dls-secondary">{t("toon_factory.media_references")}<textarea data-testid="toon-media-references" className="mt-1 min-h-14 w-full resize-y rounded-md border border-dls-border bg-background p-2 text-[10px] text-dls-text" value={references} onChange={(event) => setReferences(event.target.value)} placeholder={t("toon_factory.media_references_hint")} /></label>
    <label className="mt-2 block text-[9px] text-dls-secondary">{t("toon_factory.reference_scope")}<select data-testid="toon-media-reference-scope" className="mt-1 h-8 w-full rounded-md border border-dls-border bg-background px-2 text-[10px]" value={referenceScope} onChange={(event) => setReferenceScope(event.target.value as ToonReferenceScope)}><option value="workspace">{t("toon_factory.reference_scope_workspace")}</option><option value="project">{t("toon_factory.reference_scope_project")}</option></select></label>
    {props.kind === "video" && props.videoMode === "image-to-video" && adoptedImage ? <button type="button" className="mt-2 rounded-md border border-dls-border px-2 py-1 text-[9px]" onClick={() => { setReferences(adoptedImage.path); setReferenceScope(adoptedImage.scope); }}>{t("toon_factory.use_adopted_image_reference")}</button> : null}
    <div className="mt-2 grid grid-cols-2 gap-2">{props.kind === "image" ? <label className="text-[9px] text-dls-secondary">{t("toon_factory.media_size")}<input className="mt-1 h-8 w-full rounded-md border border-dls-border bg-background px-2 text-[10px]" value={size} onChange={(event) => setSize(event.target.value)} /></label> : <><label className="text-[9px] text-dls-secondary">{t("toon_factory.media_duration")}<input className="mt-1 h-8 w-full rounded-md border border-dls-border bg-background px-2 text-[10px]" type="number" min={1} max={20} value={durationSeconds} onChange={(event) => setDurationSeconds(Math.max(1, Math.min(20, Number(event.target.value) || 1)))} /></label><label className="text-[9px] text-dls-secondary">{t("toon_factory.media_resolution")}<select className="mt-1 h-8 w-full rounded-md border border-dls-border bg-background px-2 text-[10px]" value={resolution} onChange={(event) => setResolution(event.target.value)}><option value="480p">480p</option><option value="720p">720p</option><option value="1080p">1080p</option><option value="4k">4k</option></select></label></>}</div>
    <label className="mt-2 block text-[9px] text-dls-secondary">{t("toon_factory.execution_count")}<input data-testid="toon-media-execution-count" className="mt-1 h-8 w-full rounded-md border border-dls-border bg-background px-2 text-[10px]" type="number" min={1} max={16} value={quantity} onChange={(event) => setQuantity(Math.max(1, Math.min(16, Number(event.target.value) || 1)))} /></label>
    <div className="mt-2 rounded-lg bg-[var(--app-list-bg)] p-2"><p className="text-[9px] font-semibold uppercase tracking-wide text-dls-secondary">{t("toon_factory.exact_plan_preview")}</p><pre data-testid="toon-media-plan-preview" className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[9px] leading-4 text-dls-secondary">{plan ? JSON.stringify({ ...plan, cost: plan.knownCost ?? t("toon_factory.compute_unknown") }, null, 2) : t("toon_factory.select_media_model_first")}</pre></div>
    {authorization?.localFingerprint === planFingerprint ? <pre data-testid="toon-media-authorized-plan-summary" className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-blue-500/20 p-2 text-[9px] text-dls-secondary">{JSON.stringify(authorization.planSummary, null, 2)}</pre> : null}
    {!validReferences ? <p className="mt-2 text-[9px] text-amber-600">{t("toon_factory.references_invalid_for_mode")}</p> : null}
    {!targetAvailable ? <p className="mt-2 text-[9px] text-amber-600">{t("toon_factory.workflow_prerequisite_incomplete")}</p> : null}
    {props.modelBlockingReason ? <ModelBlockingState reason={props.modelBlockingReason} compact /> : null}
    {error ? <p className="mt-2 text-[10px] text-destructive">{describeError(error)}</p> : null}
    <div className="mt-2 flex gap-2"><button data-testid="toon-media-authorize" type="button" className="rounded-md border border-dls-border px-2 py-1 text-[10px] text-dls-text disabled:opacity-40" disabled={!valid || authorize.isPending || !targetAvailable || !authorizationRequest} onClick={() => authorizationRequest && authorize.mutate(authorizationRequest)}>{t("toon_factory.authorize_compute")}</button><button data-testid="toon-media-submit" type="button" className="rounded-md bg-dls-accent px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40" disabled={!valid || !authorization || authorization.localFingerprint !== planFingerprint || authorization.requestId !== authorizationRequest?.requestId || create.isPending || !targetAvailable} onClick={() => create.mutate()}>{retryOf ? t("toon_factory.submit_retry") : t("toon_factory.submit_generation")}</button></div>
    <div className="mt-4 space-y-3" data-testid="toon-media-history">{scopedJobs.map((job) => <MediaJobCard key={job.id} client={props.client} workspaceId={props.workspaceId} job={job} visible={props.visible} onCancel={() => cancel.mutate(job.id)} onReview={(candidateId, decision) => review.mutate({ jobId: job.id, candidateId, decision })} onRetry={() => retry(job)} />)}{!scopedJobs.length ? <p className="text-[10px] text-dls-secondary">{t("toon_factory.no_media_history")}</p> : null}</div>
  </section>;
}

function MediaJobCard(props: { client: ToonFactoryClient; workspaceId: string; job: ToonMediaJob; visible: boolean; onCancel: () => void; onReview: (candidateId: string, decision: "adopt" | "reject") => void; onRetry: () => void }) {
  return <article className="rounded-xl border border-dls-border bg-[var(--app-list-bg)] p-2" data-testid={`toon-media-job-${props.job.id}`}><div className="flex items-center justify-between gap-2"><span className="truncate text-[10px] font-medium text-dls-text">{props.job.requestSnapshot.plan.object} · {props.job.requestSnapshot.plan.model.providerID}/{props.job.requestSnapshot.plan.model.modelID}</span><StatusBadge status={props.job.status === "submission_unknown" || props.job.status === "submitting" || props.job.status === "cancel_requested" ? "running" : props.job.status} /></div>{props.job.projectionPending ? <p className="mt-1 text-[9px] text-amber-600">{t("toon_factory.projection_pending")}</p> : null}<p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[9px] text-dls-secondary">{props.job.requestSnapshot.plan.prompt}</p>{props.job.status === "submission_unknown" ? <p className="mt-1 text-[9px] text-destructive">{t("toon_factory.submission_unknown_no_resubmit")}</p> : null}{props.job.cancellation?.remoteMayContinue ? <p className="mt-1 text-[9px] text-amber-600">{t("toon_factory.remote_may_continue")}</p> : null}<div className="mt-2 grid grid-cols-2 gap-2">{props.job.candidates.map((candidate) => <MediaCandidate key={candidate.id} client={props.client} workspaceId={props.workspaceId} job={props.job} candidate={candidate} visible={props.visible} onReview={props.onReview} />)}</div><div className="mt-2 flex gap-1.5">{props.job.kind === "video" && !MEDIA_TERMINAL.has(props.job.status) ? <button type="button" className="rounded-md border border-dls-border px-2 py-1 text-[9px]" onClick={props.onCancel}>{t("toon_factory.cancel_generation")}</button> : null}{props.job.status !== "submission_unknown" ? <button type="button" className="rounded-md border border-dls-border px-2 py-1 text-[9px]" onClick={props.onRetry}>{t("toon_factory.retry_with_plan")}</button> : null}</div></article>;
}

function MediaCandidate(props: { client: ToonFactoryClient; workspaceId: string; job: ToonMediaJob; candidate: ToonMediaJob["candidates"][number]; visible: boolean; onReview: (candidateId: string, decision: "adopt" | "reject") => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [inViewport, setInViewport] = useState(() => typeof IntersectionObserver === "undefined");
  const previewRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!props.visible) { setInViewport(false); return; }
    if (typeof IntersectionObserver === "undefined") { setInViewport(true); return; }
    const element = previewRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setInViewport(Boolean(entry?.isIntersecting)), { rootMargin: "120px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.visible]);
  useEffect(() => {
    if (!props.visible || !inViewport || !props.candidate.artifact) { setUrl(null); return; }
    let active = true; let objectUrl: string | null = null;
    void props.client.downloadWorkspaceFile(props.workspaceId, props.candidate.artifact.path).then((download) => { if (!active) return; objectUrl = URL.createObjectURL(new Blob([download.data], { type: download.contentType ?? props.candidate.artifact?.mimeType })); setUrl(objectUrl); }).catch(() => undefined);
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [props.candidate.artifact?.path, props.client, props.visible, props.workspaceId, inViewport]);
  const reviewable = Boolean(props.candidate.artifact) && ["awaiting-review", "adopted", "rejected"].includes(props.candidate.status);
  return <div ref={previewRef} className="overflow-hidden rounded-lg border border-dls-border bg-background" data-testid={`toon-media-candidate-${props.candidate.id}`}>{url ? props.job.kind === "image" ? <img src={url} alt={props.job.requestSnapshot.plan.object} loading="lazy" className="h-24 w-full object-cover" /> : <video src={url} controls preload="none" className="h-24 w-full bg-black object-contain" /> : <div className="flex h-24 items-center justify-center text-[9px] text-dls-secondary">{typeof props.candidate.progress === "number" ? `${Math.round(props.candidate.progress)}%` : t(`toon_factory.status_${props.candidate.status.replaceAll("-", "_")}`)}</div>}<div className="p-2"><p className="truncate text-[9px] text-dls-secondary">#{props.candidate.ordinal} {props.candidate.artifact?.path}</p>{props.candidate.error ? <p className="mt-1 text-[9px] text-destructive" role="alert">{describeGenerationError(props.candidate.error.code)}</p> : null}{reviewable ? <div className="mt-1 flex gap-1"><button type="button" className="rounded bg-emerald-500/15 px-1.5 py-1 text-[9px] text-emerald-700 disabled:opacity-40" disabled={props.candidate.status === "adopted"} onClick={() => props.onReview(props.candidate.id, "adopt")}>{t("toon_factory.adopt_candidate")}</button><button type="button" className="rounded bg-dls-hover px-1.5 py-1 text-[9px] text-dls-secondary disabled:opacity-40" disabled={props.candidate.status === "rejected"} onClick={() => props.onReview(props.candidate.id, "reject")}>{t("toon_factory.reject_candidate")}</button></div> : null}</div></div>;
}

function modelValue(model: { providerID: string; modelID: string }): string {
  return `${model.providerID}\u0000${model.modelID}`;
}

function selectedValue(reference: ToonModelReference | undefined): string {
  return reference ? modelValue(reference) : "";
}

function ProjectModelSettings(props: {
  project: ToonProject;
  textModels: ConnectedTextModelOption[];
  imageModels: ToonImageModelDescriptor[];
  videoModels: ToonVideoModelDescriptor[];
  imageMode: ToonImageGenerationMode;
  videoMode: ToonVideoGenerationMode;
  availability: ReturnType<typeof revalidateToonProjectModels>;
  loading: boolean;
  error: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImageModeChange: (mode: ToonImageGenerationMode) => void;
  onVideoModeChange: (mode: ToonVideoGenerationMode) => void;
  onSelectModel: (kind: "text" | "image" | "video", providerID: string, modelID: string) => void;
  onOpenProviderSettings: () => void;
  onRefresh: () => void;
}) {
  const selected = props.project.selectedModels;
  const select = (kind: "text" | "image" | "video", value: string) => {
    const [providerID, modelID] = value.split("\u0000");
    if (providerID && modelID) props.onSelectModel(kind, providerID, modelID);
  };
  const label = (kind: "text" | "image" | "video") => selected?.[kind]
    ? `${selected[kind]!.providerID}/${selected[kind]!.modelID}`
    : t(`toon_factory.no_${kind}_selection`);

  return (
    <div className="relative mac:titlebar-no-drag" data-testid="toon-model-settings">
      <button type="button" className="flex max-w-[360px] items-center gap-2 rounded-lg border border-dls-border bg-[var(--app-list-bg)] px-2.5 py-1.5 text-[10px] text-dls-secondary hover:bg-dls-hover hover:text-dls-text" onClick={() => props.onOpenChange(!props.open)} aria-expanded={props.open}>
        <Settings2 className="size-3.5 shrink-0" />
        <span className="truncate">{t("toon_factory.models_summary", { text: label("text"), image: label("image"), video: label("video") })}</span>
      </button>
      {props.open ? (
        <div className="absolute right-0 top-full z-50 mt-2 w-[360px] max-w-[calc(100vw-2rem)] rounded-xl border border-dls-border bg-background p-3 shadow-xl" data-testid="toon-model-settings-panel">
          <div className="flex items-center justify-between"><h3 className="text-xs font-semibold text-dls-text">{t("toon_factory.model_settings")}</h3><button type="button" className="text-[10px] text-dls-secondary underline" onClick={props.onRefresh}>{t("toon_factory.refresh_models")}</button></div>
          {props.loading ? <p className="mt-2 text-[10px] text-dls-secondary">{t("toon_factory.loading_models")}</p> : null}
          {props.error ? <p className="mt-2 text-[10px] text-destructive">{props.error}</p> : null}
          <ModelField label={t("toon_factory.text_model")} selected={selected?.text} value={selectedValue(selected?.text)} options={props.textModels.map((model) => ({ value: modelValue(model), label: `${model.modelName} - ${model.providerName}` }))} unavailable={props.availability.text.reason === "selected_model_unavailable"} onChange={(value) => select("text", value)} />
          <div className="mt-3 grid grid-cols-2 gap-2"><label className="text-[10px] text-dls-secondary">{t("toon_factory.image_mode")}<select className="mt-1 h-8 w-full rounded-md border border-dls-border bg-background px-2 text-[10px] text-dls-text" value={props.imageMode} onChange={(event) => props.onImageModeChange(event.target.value as ToonImageGenerationMode)}><option value="text-to-image">{t("toon_factory.mode_text_to_image")}</option><option value="image-to-image">{t("toon_factory.mode_image_to_image")}</option><option value="multi-image-to-image">{t("toon_factory.mode_multi_image_to_image")}</option></select></label><label className="text-[10px] text-dls-secondary">{t("toon_factory.video_mode")}<select className="mt-1 h-8 w-full rounded-md border border-dls-border bg-background px-2 text-[10px] text-dls-text" value={props.videoMode} onChange={(event) => props.onVideoModeChange(event.target.value as ToonVideoGenerationMode)}><option value="text-to-video">{t("toon_factory.mode_text_to_video")}</option><option value="image-to-video">{t("toon_factory.mode_image_to_video")}</option></select></label></div>
          <ModelField label={t("toon_factory.image_model")} selected={selected?.image} value={selectedValue(selected?.image)} options={props.imageModels.map((model) => ({ value: modelValue(model.ref), label: `${model.modelName} - ${model.providerName}` }))} unavailable={props.availability.image.reason === "selected_model_unavailable"} onChange={(value) => select("image", value)} />
          <ModelField label={t("toon_factory.video_model")} selected={selected?.video} value={selectedValue(selected?.video)} options={props.videoModels.map((model) => ({ value: modelValue(model.ref), label: `${model.modelName} - ${model.providerName}` }))} unavailable={props.availability.video.reason === "selected_model_unavailable"} onChange={(value) => select("video", value)} />
          <div className="mt-3 space-y-1">{(["text", "image", "video"] as const).map((kind) => props.availability[kind].reason ? <ModelBlockingState key={kind} reason={props.availability[kind].reason!} compact /> : null)}</div>
          <button type="button" className="mt-3 flex w-full items-center justify-center gap-1 rounded-lg border border-dls-border px-3 py-2 text-[10px] font-medium text-dls-text hover:bg-dls-hover" onClick={props.onOpenProviderSettings}><Settings2 className="size-3" />{t("toon_factory.open_provider_settings")}</button>
        </div>
      ) : null}
    </div>
  );
}

function ModelField(props: { label: string; selected?: ToonModelReference; value: string; options: Array<{ value: string; label: string }>; unavailable: boolean; onChange: (value: string) => void }) {
  return <label className="mt-3 block text-[10px] text-dls-secondary">{props.label}<select className={cn("mt-1 h-8 w-full rounded-md border bg-background px-2 text-[10px] text-dls-text", props.unavailable ? "border-destructive" : "border-dls-border")} value={props.value} onChange={(event) => props.onChange(event.target.value)}><option value="" disabled>{t("toon_factory.select_model")}</option>{props.unavailable && props.selected ? <option value={props.value}>{props.selected.providerID} / {props.selected.modelID} ({t("toon_factory.unavailable")})</option> : null}{props.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}

function ModelBlockingState({ reason, compact = false }: { reason: ToonModelBlockingReason; compact?: boolean }) {
  return <div className={cn("flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-700", compact ? "p-2 text-[9px]" : "mt-2 p-2.5 text-[10px]")} data-testid={`toon-model-block-${reason}`}><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /><span><strong className="block">{t(`toon_factory.${reason}`)}</strong>{t(`toon_factory.${reason}_hint`)}</span></div>;
}

function TextInspector(props: { client: ToonFactoryClient; workspaceId: string; project: ToonProjectResponse; episode: ToonEpisode; node: ToonNode; visible: boolean; onProjectChange: (response: ToonProjectResponse) => void }) {
  const queryClient = useQueryClient();
  const externalText = Boolean(props.node.data.contentRef);
  const queryScope = toonQueryScope(props.client.baseUrl, props.workspaceId);
  const draftKey = toonTextDraftKey(props.workspaceId, props.project.project.id, props.episode.id, props.node.id);
  const retainedDraft = readToonTextDraft(draftKey);
  const [draft, setDraft] = useState<string | null>(retainedDraft?.content ?? null);
  const [pendingWorkflowRevision, setPendingWorkflowRevision] = useState<string | null>(retainedDraft?.pendingWorkflowRevision ?? null);
  const [conflict, setConflict] = useState(false);
  const draftRef = useRef<string | null>(retainedDraft?.content ?? null);
  const baseRevisionRef = useRef<string | null>(retainedDraft?.baseRevision ?? null);
  const flushRef = useRef<() => Promise<void>>(async () => undefined);
  const textQuery = useQuery<TextDocument>({
    queryKey: toonTextKey(queryScope, props.project.project.id, props.episode.id, props.node.id),
    queryFn: async () => {
      try { return await props.client.readToonText(props.workspaceId, props.project.project.id, props.node.id); }
      catch (error) { if (error instanceof JuggleWorkServerError && error.status === 404) return { content: "" }; throw error; }
    },
    enabled: props.visible && externalText,
    retry: false,
  });
  useEffect(() => {
    if (!textQuery.data || draftRef.current !== null) return;
    baseRevisionRef.current = textQuery.data.revision ?? null;
  }, [textQuery.data]);

  const retainDraft = (content: string, pendingRevision = pendingWorkflowRevision) => {
    draftRef.current = content;
    setDraft(content);
    writeToonTextDraft(draftKey, {
      content,
      baseRevision: baseRevisionRef.current ?? textQuery.data?.revision ?? null,
      dirty: true,
      ...(pendingRevision ? { pendingWorkflowRevision: pendingRevision } : {}),
    });
  };

  const save = useMutation({
    mutationFn: async () => {
      const content = draftRef.current ?? textQuery.data?.content ?? "";
      const response = pendingWorkflowRevision ? null : await props.client.writeToonText(props.workspaceId, props.project.project.id, props.node.id, { content, expectedRevision: baseRevisionRef.current ?? textQuery.data?.revision ?? null });
      const outputRevision = pendingWorkflowRevision ?? response!.revision;
      if (response) {
        queryClient.setQueryData(toonTextKey(queryScope, props.project.project.id, props.episode.id, props.node.id), response);
        setPendingWorkflowRevision(outputRevision);
        writeToonTextDraft(draftKey, { content, baseRevision: response.revision, dirty: true, pendingWorkflowRevision: outputRevision });
      }
      const now = new Date().toISOString();
      const stepId = props.node.id.startsWith("source-") ? "source-material" : props.node.kind === "storyboard" ? "storyboard" : props.node.kind === "asset" ? "asset-plan" : "episode-script";
      const nextEpisode = applyUpstreamRevision({ ...props.episode, steps: props.episode.steps ?? createEpisodeWorkflowSteps(now, t) }, stepId, outputRevision, now);
      const projectResponse = await props.client.updateToonProject(props.workspaceId, props.project.project.id, {
        project: { ...props.project.project, episodes: props.project.project.episodes.map((episode) => episode.id === nextEpisode.id ? nextEpisode : episode), updatedAt: now },
        expectedRevision: props.project.revision,
      });
      return { response, projectResponse };
    },
    onSuccess: ({ response, projectResponse }) => {
      if (response) queryClient.setQueryData(toonTextKey(queryScope, props.project.project.id, props.episode.id, props.node.id), response);
      props.onProjectChange(projectResponse);
      clearToonTextDraft(draftKey);
      draftRef.current = null;
      setDraft(null);
      setPendingWorkflowRevision(null);
      setConflict(false);
    },
    onError: (error) => { if (error instanceof JuggleWorkServerError && error.code === "toon_factory_revision_conflict") setConflict(true); },
  });
  flushRef.current = async () => {
    if (draftRef.current === null || conflict) return;
    await save.mutateAsync();
  };
  useEffect(() => registerToonTextDraftFlusher(draftKey, () => flushRef.current()), [draftKey]);
  useEffect(() => {
    if (props.visible || draftRef.current === null || save.isPending || conflict) return;
    save.mutate();
  }, [props.visible]);
  if (!externalText) return <section className="mt-4 rounded-xl border border-dls-border p-3"><h3 className="text-xs font-semibold text-dls-text">{t("toon_factory.node_inspector")}</h3><p className="mt-1 text-[11px] text-dls-secondary">{t("toon_factory.media_node_future")}</p></section>;
  return <section className="mt-4" data-testid="toon-text-editor"><div className="flex items-center justify-between"><h3 className="text-xs font-semibold text-dls-text">{t("toon_factory.external_text")}</h3><button type="button" onClick={() => save.mutate()} disabled={draft === null || save.isPending || conflict} className="rounded-md bg-dls-accent px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40">{save.isPending ? t("toon_factory.saving") : pendingWorkflowRevision ? t("toon_factory.retry_workflow_update") : t("toon_factory.save_text")}</button></div>{textQuery.isLoading ? <p className="mt-2 text-xs text-dls-secondary">{t("toon_factory.loading_text")}</p> : null}{textQuery.error ? <p className="mt-2 text-xs text-destructive" role="alert">{describeError(textQuery.error)}</p> : null}{pendingWorkflowRevision ? <p className="mt-2 text-[10px] text-amber-700" role="status">{t("toon_factory.text_saved_workflow_pending")}</p> : null}{conflict ? <ConflictBanner message={t("toon_factory.text_conflict")} onReload={() => { clearToonTextDraft(draftKey); draftRef.current = null; setDraft(null); setConflict(false); void queryClient.invalidateQueries({ queryKey: toonProjectKey(queryScope, props.project.project.id), exact: true }); void textQuery.refetch(); }} compact /> : null}<textarea data-testid="toon-text-draft" className="mt-2 min-h-44 w-full resize-y rounded-xl border border-dls-border bg-[var(--app-list-bg)] p-3 text-xs leading-5 text-dls-text outline-none focus:border-dls-accent" value={draft ?? textQuery.data?.content ?? ""} onChange={(event) => retainDraft(event.target.value)} placeholder={t("toon_factory.text_placeholder")} />{save.error && !conflict ? <p className="mt-1 text-[10px] text-destructive" role="alert">{describeError(save.error)}</p> : null}</section>;
}

function DecisionSummary({ step }: { step: ToonWorkflowStep }) {
  return <div className="mt-2 grid grid-cols-3 gap-1 text-center text-[9px]"><span className={cn("rounded-md px-1 py-1", step.contentApprovals.length ? "bg-emerald-500/15 text-emerald-600" : "bg-dls-hover text-dls-secondary")}>{t("toon_factory.content_approval")} {step.contentApprovals.length}</span><span className={cn("rounded-md px-1 py-1", step.computeAuthorizations.length ? "bg-blue-500/15 text-blue-600" : "bg-dls-hover text-dls-secondary")}>{t("toon_factory.compute_authorization")} {step.computeAuthorizations.length}</span><span className={cn("rounded-md px-1 py-1", step.resultAdoptions.length ? "bg-violet-500/15 text-violet-600" : "bg-dls-hover text-dls-secondary")}>{t("toon_factory.result_adoption")} {step.resultAdoptions.length}</span></div>;
}

function StatusBadge({ status }: { status: ToonWorkflowStep["status"] }) { return <span role="status" className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[9px]", status === "stale" || status === "failed" ? "bg-amber-500/15 text-amber-600" : status === "approved" || status === "adopted" ? "bg-emerald-500/15 text-emerald-600" : "bg-dls-hover text-dls-secondary")}>{t(`toon_factory.status_${status.replaceAll("-", "_")}`)}</span>; }
function SidebarState({ icon: Icon, label, detail, spin = false }: { icon: typeof CircleDashed; label: string; detail?: string; spin?: boolean }) { return <div className="flex h-48 flex-col items-center justify-center px-4 text-center"><Icon className={cn("size-5 text-dls-secondary", spin && "animate-spin")} /><p className="mt-2 text-xs font-medium text-dls-text">{label}</p>{detail ? <p className="mt-1 text-[10px] leading-4 text-dls-secondary">{detail}</p> : null}</div>; }
function SidebarError({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="m-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-center"><Unplug className="mx-auto size-4 text-destructive" /><p className="mt-2 text-[10px] text-destructive">{message}</p><button type="button" className="mt-2 rounded-md border border-dls-border px-2 py-1 text-[10px]" onClick={onRetry}>{t("toon_factory.retry")}</button></div>; }
function MainState({ label }: { label: string }) { return <div className="flex h-full items-center justify-center gap-2 text-xs text-dls-secondary"><LoaderCircle className="size-4 animate-spin" />{label}</div>; }
function MainError({ message, onRetry, onBack }: { message: string; onRetry: () => void; onBack?: () => void }) { return <div className="flex h-full flex-col items-center justify-center p-6 text-center"><AlertTriangle className="size-6 text-destructive" /><p className="mt-2 max-w-md text-xs text-destructive">{message}</p><div className="mt-3 flex gap-2">{onBack ? <button type="button" className="flex items-center gap-1 rounded-lg border border-dls-border px-3 py-1.5 text-xs" onClick={onBack} data-testid="toon-project-error-back"><ArrowLeft className="size-3" />{t("toon_factory.back_to_projects")}</button> : null}<button type="button" className="flex items-center gap-1 rounded-lg border border-dls-border px-3 py-1.5 text-xs" onClick={onRetry} data-testid="toon-main-error-retry"><RefreshCw className="size-3" />{t("toon_factory.retry")}</button></div></div>; }
function EmptyWorkspace({ title, description, action }: { title: string; description: string; action?: ReactNode }) { return <div className="flex h-full flex-col items-center justify-center p-8 text-center"><span className="flex size-12 items-center justify-center rounded-2xl bg-dls-hover"><FileText className="size-5 text-dls-secondary" /></span><h2 className="mt-3 text-sm font-semibold text-dls-text">{title}</h2><p className="mt-1 max-w-md text-xs leading-5 text-dls-secondary">{description}</p>{action}</div>; }
function ConflictBanner({ message, onReload, compact = false }: { message: string; onReload: () => void; compact?: boolean }) { return <div className={cn("flex items-center justify-between gap-3 border-amber-500/30 bg-amber-500/10 text-amber-700", compact ? "mt-2 rounded-lg border p-2" : "border-b px-4 py-2")} data-testid="toon-conflict"><span className="flex items-center gap-1.5 text-[10px]"><AlertTriangle className="size-3.5 shrink-0" />{message}</span><button type="button" onClick={onReload} className="shrink-0 rounded-md border border-amber-500/30 px-2 py-1 text-[10px]">{t("toon_factory.reload")}</button></div>; }
