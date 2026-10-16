/** @jsxImportSource react */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ToonCanvas,
  ToonEpisode,
  ToonImageModelDescriptor,
  ToonNode,
  ToonNodeKind,
  ToonImageGenerationMode,
  ToonMediaAuthorization,
  ToonMediaGenerationPlan,
  ToonMediaJob,
  ToonMediaJobCreateRequest,
  ToonModelReference,
  ToonProject,
  ToonProjectResponse,
  ToonReferenceScope,
  ToonVideoGenerationMode,
  ToonVideoModelDescriptor,
  ToonWorkflowStage,
  ToonWorkflowStep,
} from "@jugglework/types/toon-factory";
import {
  TOON_TEXT_OUTPUT_SCHEMAS,
  type ToonTextGenerationAction,
  type ToonTextJob,
  type ToonTextJobCreateRequest,
} from "@jugglework/types/toon-factory";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleDashed,
  Download,
  FileText,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Unplug,
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
import {
  clearToonTextDraft,
  flushToonTextDrafts,
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
>;

type WorkbenchProps = {
  client: ToonFactoryClient;
  workspaceId: string;
  workspaceRoot: string;
  projectId: string | null;
  visible: boolean;
  sidebarOpen: boolean;
  textModels: ConnectedTextModelOption[];
  textModelsPending: boolean;
  onRefreshTextModels: () => Promise<unknown>;
  onOpenProviderSettings: () => void;
  onSelectProject: (projectId: string | null) => void;
};

type TextDocument = { content: string; revision?: string };
type PendingConnection = { nodeId: string; handleId: string } | null;

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

export function ToonFactoryWorkbench(props: WorkbenchProps) {
  const queryClient = useQueryClient();
  const queryScope = toonQueryScope(props.client.baseUrl, props.workspaceId);
  const [projectName, setProjectName] = useState("");
  const [projectDirectory, setProjectDirectory] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null);
  const [selectedStage, setSelectedStage] = useState<ToonWorkflowStage>("content-script");
  const [imageMode, setImageMode] = useState<ToonImageGenerationMode>("text-to-image");
  const [videoMode, setVideoMode] = useState<ToonVideoGenerationMode>("text-to-video");
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [modelSaveError, setModelSaveError] = useState<string | null>(null);
  const [pendingEpisode, setPendingEpisode] = useState<ToonEpisode | null>(null);
  const projectOperationRef = useRef<Promise<unknown>>(Promise.resolve());

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
  const projectQuery = useQuery({
    queryKey: toonProjectKey(queryScope, props.projectId ?? "none"),
    queryFn: () => props.client.getToonProject(props.workspaceId, props.projectId!),
    enabled: props.visible && Boolean(props.projectId),
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
    mutationFn: () => props.client.createToonProject(props.workspaceId, { name: projectName.trim(), directory: projectDirectory.trim() }),
    onSuccess: (created) => {
      queryClient.setQueryData(toonProjectKey(queryScope, created.project.id), created);
      void queryClient.invalidateQueries({ queryKey: toonProjectsKey(queryScope), exact: true });
      setProjectName("");
      setProjectDirectory("");
      setCreatingProject(false);
      props.onSelectProject(created.project.id);
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
  const projectListEmpty = projectsQuery.data?.items.length === 0;
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
      <aside className={cn("h-full shrink-0 flex-col border-r border-dls-border bg-[var(--app-list-bg)]", props.sidebarOpen ? "flex w-[var(--jugglework-left-sidebar-width)]" : "hidden w-0")}>
        <header className="flex h-[var(--app-topbar-height)] shrink-0 items-center justify-between gap-2 border-b border-dls-border px-4 mac:titlebar-no-drag">
          <h1 className="truncate text-[14px] font-semibold text-dls-text">{t("toon_factory.projects")}</h1>
          <button type="button" className="rounded-lg p-1.5 text-dls-secondary hover:bg-dls-hover hover:text-dls-text" onClick={() => setCreatingProject((value) => !value)} aria-label={t("toon_factory.create_project")} data-testid="toon-factory-new-project"><Plus className="size-4" /></button>
        </header>
        {creatingProject ? (
          <form className="space-y-2 border-b border-dls-border p-3" onSubmit={(event) => { event.preventDefault(); createProject.mutate(); }} data-testid="toon-factory-create-form">
            <input className="h-9 w-full rounded-lg border border-dls-border bg-background px-3 text-xs text-dls-text outline-none focus:border-dls-accent" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder={t("toon_factory.project_name")} autoFocus />
            <input className="h-9 w-full rounded-lg border border-dls-border bg-background px-3 text-xs text-dls-text outline-none focus:border-dls-accent" value={projectDirectory} onChange={(event) => setProjectDirectory(event.target.value)} placeholder={t("toon_factory.project_directory")} />
            {createProject.error ? <p className="text-xs text-destructive">{describeError(createProject.error)}</p> : null}
            <button className="h-8 w-full rounded-lg bg-dls-accent px-3 text-xs font-semibold text-white disabled:opacity-50" disabled={!projectName.trim() || !projectDirectory.trim() || createProject.isPending} type="submit">{createProject.isPending ? t("toon_factory.creating") : t("toon_factory.create")}</button>
          </form>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="toon-factory-project-list">
          {projectsQuery.isLoading ? <SidebarState icon={LoaderCircle} label={t("toon_factory.loading_projects")} spin /> : null}
          {projectsQuery.error ? <SidebarError message={describeError(projectsQuery.error)} onRetry={() => void projectsQuery.refetch()} /> : null}
          {projectListEmpty ? <SidebarState icon={CircleDashed} label={t("toon_factory.no_projects")} detail={t("toon_factory.no_projects_hint")} /> : null}
          {projectsQuery.data?.items.map((project) => (
            <div key={project.id}>
              <button type="button" onClick={() => props.onSelectProject(project.id)} className={cn("flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left", props.projectId === project.id ? "bg-dls-active text-dls-text" : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text")} data-testid={`toon-project-${project.id}`}>
                <FileText className="size-4 shrink-0" />
                <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{project.name}</span><span className="block truncate text-[10px] opacity-70">{project.directory}</span></span>
                <ChevronRight className="size-3.5 shrink-0" />
              </button>
              {props.projectId === project.id && projectQuery.data ? (
                <div className="ml-5 mt-1 border-l border-dls-border pl-2">
                   {projectQuery.data.project.episodes.map((episode) => {
                     const progress = episodeProgress(episode);
                     return <button key={episode.id} type="button" onClick={() => { void flushToonTextDrafts().then(() => setSelectedEpisodeId(episode.id)).catch(() => undefined); }} className={cn("mb-1 block w-full rounded-lg px-2 py-1.5 text-left text-[11px]", selectedEpisodeId === episode.id ? "bg-dls-hover text-dls-text" : "text-dls-secondary hover:text-dls-text")} data-testid={`toon-episode-${episode.id}`}><span className="block truncate">{episode.title}</span><span className="mt-1 block h-1 overflow-hidden rounded-full bg-dls-border"><span className="block h-full bg-dls-accent" style={{ width: `${progress.percent}%` }} /></span><span className="mt-0.5 block text-[9px] opacity-70">{t("toon_factory.progress", { completed: progress.completed, total: progress.total })}</span></button>;
                  })}
                  <button type="button" onClick={() => addEpisode.mutate()} disabled={addEpisode.isPending} className="mb-1 flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] text-dls-secondary hover:bg-dls-hover hover:text-dls-text disabled:opacity-50" data-testid="toon-factory-add-episode"><Plus className="size-3" />{t("toon_factory.add_episode")}</button>
                   {addEpisode.error ? <p className="px-2 pb-2 text-[10px] text-destructive" role="alert">{describeError(addEpisode.error)}</p> : null}
                   {pendingEpisode ? <button type="button" className="mb-2 w-full rounded-lg border border-amber-500/40 px-2 py-1.5 text-[10px] text-amber-700" onClick={() => addEpisode.mutate()}>{t("toon_factory.retry_pending_episode")}</button> : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--app-page-bg)]">
        {!props.projectId ? <EmptyWorkspace title={t("toon_factory.empty_title")} description={t("toon_factory.empty_description")} /> : null}
        {props.projectId && projectQuery.isLoading ? <MainState label={t("toon_factory.loading_project")} /> : null}
        {props.projectId && projectQuery.error ? <MainError message={describeError(projectQuery.error)} onRetry={() => void projectQuery.refetch()} /> : null}
        {projectQuery.data && !selectedEpisode ? <>{modelSettings}<EmptyWorkspace title={projectQuery.data.project.name} description={t("toon_factory.no_episodes_hint")} action={<button type="button" className="mt-4 rounded-xl bg-dls-accent px-4 py-2 text-xs font-semibold text-white" onClick={() => addEpisode.mutate()}>{t("toon_factory.add_first_episode")}</button>} /></> : null}
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
            imageMode={imageMode}
            videoMode={videoMode}
            onSelectStage={setSelectedStage}
             onProjectChange={(response) => queryClient.setQueryData(toonProjectKey(queryScope, response.project.id), response)}
          />
        ) : null}
      </section>
    </div>
  );
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
  imageMode: ToonImageGenerationMode;
  videoMode: ToonVideoGenerationMode;
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

  return (
    <>
      <header className="flex min-h-[var(--app-topbar-height)] shrink-0 items-center justify-between gap-3 border-b border-dls-border bg-background px-4 py-2 md:px-6 mac:titlebar-drag">
        <div className="min-w-0"><h2 className="truncate text-[15px] font-semibold text-dls-text">{props.projectResponse.project.name} / {props.episode.title}</h2><p className="truncate text-[11px] text-dls-secondary">{t("toon_factory.progress_percent", { percent: progress.percent })}</p></div>
        <div className="flex items-center gap-2">{props.modelSettings}<span role="status" aria-live="polite" className={cn("flex items-center gap-1 text-[11px]", canvasConflict || canvasSaveError ? "text-destructive" : "text-dls-secondary")} data-testid="toon-canvas-save-status">{canvasSaving ? <LoaderCircle className="size-3 animate-spin" /> : <Save className="size-3" />}{canvasConflict ? t("toon_factory.save_conflict") : canvasSaveError ?? (canvasSaving ? t("toon_factory.saving") : t("toon_factory.saved"))}</span></div>
      </header>
      {canvasConflict ? <ConflictBanner message={t("toon_factory.conflict_description")} onReload={() => { conflictRef.current = false; setCanvasConflict(false); void canvasQuery.refetch(); }} /> : null}
      <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-dls-border bg-background px-3 py-2" aria-label={t("toon_factory.stages")}>{STAGES.map((stage, index) => {
        const stageRecords = steps.filter((step) => step.stage === stage);
        const done = stageRecords.length > 0 && stageRecords.every((step) => ["approved", "adopted", "skipped"].includes(step.status));
        return <button key={stage} type="button" onClick={() => props.onSelectStage(stage)} aria-pressed={props.selectedStage === stage} className={cn("flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px]", props.selectedStage === stage ? "bg-dls-active font-semibold text-dls-text" : "text-dls-secondary hover:bg-dls-hover")} data-testid={`toon-factory-stage-${stage}`}><span className={cn("flex size-4 items-center justify-center rounded-full text-[9px]", done ? "bg-emerald-500 text-white" : "bg-dls-hover")}>{done ? <Check className="size-2.5" /> : index + 1}</span>{t(STAGE_LABELS[stage])}</button>;
      })}</nav>
      {props.selectedStage === "adoption-delivery" ? <div className="max-h-[45%] shrink-0 overflow-y-auto border-b border-dls-border bg-background px-3 pb-3"><DeliveryPanel client={props.client} workspaceId={props.workspaceId} projectId={props.projectResponse.project.id} episode={props.episode} delivery={delivery} visible={props.visible} /></div> : null}
      <div className="relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px] overflow-hidden max-[900px]:grid-cols-1">
        <div className="relative min-h-0 overflow-hidden border-r border-dls-border max-[900px]:border-r-0">
          {canvasQuery.isLoading ? <MainState label={t("toon_factory.loading_canvas")} /> : null}
          {canvasQuery.error ? <MainError message={describeError(canvasQuery.error)} onRetry={() => void canvasQuery.refetch()} /> : null}
          {canvasDraft && props.visible ? <NodeCanvas canvas={canvasDraft} onChange={changeCanvas} /> : null}
          {canvasDraft && !props.visible ? <div data-testid="toon-canvas-suspended" /> : null}
        </div>
        <button type="button" className="absolute bottom-3 right-3 z-40 hidden rounded-full bg-dls-accent px-3 py-2 text-[10px] font-semibold text-white shadow-lg max-[900px]:block" aria-expanded={mobileInspectorOpen} onClick={() => setMobileInspectorOpen((open) => !open)} data-testid="toon-factory-inspector-tab">{mobileInspectorOpen ? t("toon_factory.close_inspector") : t("toon_factory.open_inspector")}</button>
        <aside className={cn("min-h-0 overflow-y-auto bg-background p-3 max-[900px]:absolute max-[900px]:inset-x-0 max-[900px]:bottom-0 max-[900px]:z-30 max-[900px]:max-h-[70%] max-[900px]:rounded-t-2xl max-[900px]:border-t max-[900px]:border-dls-border max-[900px]:shadow-xl", !mobileInspectorOpen && "max-[900px]:hidden")} data-testid="toon-factory-inspector">
          <section>
            <h3 className="text-xs font-semibold text-dls-text">{t("toon_factory.stage_steps")}</h3>
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
          {selectedNode && !["images", "videos"].includes(props.selectedStage) ? <TextInspector key={`${props.projectResponse.project.id}:${props.episode.id}:${selectedNode.id}`} client={props.client} workspaceId={props.workspaceId} project={props.projectResponse} episode={props.episode} node={selectedNode} visible={props.visible} onProjectChange={props.onProjectChange} /> : !selectedNode ? <p className="mt-4 text-center text-xs text-dls-secondary">{t("toon_factory.select_node_hint")}</p> : null}
        </aside>
      </div>
    </>
  );
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
  const [authorization, setAuthorization] = useState<ToonMediaAuthorization | null>(null);
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
    mutationFn: () => {
      if (!authorizationRequest || !plan?.prompt) throw new Error(t("toon_factory.media_prompt_required"));
      return props.client.authorizeToonMediaJob(props.workspaceId, props.project.project.id, authorizationRequest);
    },
    onSuccess: (response) => setAuthorization(response.authorization),
  });
  const create = useMutation({
    mutationFn: () => {
      if (!authorizationRequest || !authorization) throw new Error(t("toon_factory.media_authorization_required"));
      const input: ToonMediaJobCreateRequest = { ...authorizationRequest, authorization };
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
    <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-semibold text-dls-text">{props.kind === "image" ? t("toon_factory.image_generation") : t("toon_factory.video_generation")}</h3>{authorization ? <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[9px] text-blue-600">{t("toon_factory.authorized_exact_plan")}</span> : null}</div>
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
    {!validReferences ? <p className="mt-2 text-[9px] text-amber-600">{t("toon_factory.references_invalid_for_mode")}</p> : null}
    {!targetAvailable ? <p className="mt-2 text-[9px] text-amber-600">{t("toon_factory.workflow_prerequisite_incomplete")}</p> : null}
    {props.modelBlockingReason ? <ModelBlockingState reason={props.modelBlockingReason} compact /> : null}
    {error ? <p className="mt-2 text-[10px] text-destructive">{describeError(error)}</p> : null}
    <div className="mt-2 flex gap-2"><button data-testid="toon-media-authorize" type="button" className="rounded-md border border-dls-border px-2 py-1 text-[10px] text-dls-text disabled:opacity-40" disabled={!valid || authorize.isPending || !targetAvailable} onClick={() => authorize.mutate()}>{t("toon_factory.authorize_compute")}</button><button data-testid="toon-media-submit" type="button" className="rounded-md bg-dls-accent px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40" disabled={!valid || !authorization || create.isPending || !targetAvailable} onClick={() => create.mutate()}>{retryOf ? t("toon_factory.submit_retry") : t("toon_factory.submit_generation")}</button></div>
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

function NodeCanvas(props: { canvas: ToonCanvas; onChange: (canvas: ToonCanvas) => void }) {
  const [pendingConnection, setPendingConnection] = useState<PendingConnection>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const dragRef = useRef<{ kind: "canvas" | "node"; id?: string; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const viewport = props.canvas.viewport;
  const positions = new Map(props.canvas.nodes.map((node) => [node.id, node.position]));

  const addNode = (kind: ToonNodeKind) => {
    const id = makeIdentifier(kind);
    props.onChange({ ...props.canvas, nodes: [...props.canvas.nodes, createNode(kind, id, props.canvas.nodes.length)], selectedNodeId: id });
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === "canvas") {
      props.onChange({ ...props.canvas, viewport: { ...viewport, x: drag.originX + event.clientX - drag.startX, y: drag.originY + event.clientY - drag.startY } });
      return;
    }
    props.onChange({ ...props.canvas, nodes: props.canvas.nodes.map((node) => node.id === drag.id ? { ...node, position: { x: drag.originX + (event.clientX - drag.startX) / viewport.zoom, y: drag.originY + (event.clientY - drag.startY) / viewport.zoom } } : node) });
  };
  const zoom = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const nextZoom = Math.min(2.5, Math.max(0.35, viewport.zoom * (event.deltaY > 0 ? 0.9 : 1.1)));
    props.onChange({ ...props.canvas, viewport: { ...viewport, zoom: nextZoom } });
  };
  const handleClick = (node: ToonNode, handleId: string, direction: "source" | "target") => {
    if (direction === "source") {
      setPendingConnection({ nodeId: node.id, handleId });
      setConnectionError(null);
      return;
    }
    if (!pendingConnection) return;
    const candidate = { sourceNodeId: pendingConnection.nodeId, sourceHandleId: pendingConnection.handleId, targetNodeId: node.id, targetHandleId: handleId };
    const result = validateToonConnection(props.canvas, candidate);
    if (!result.valid) {
      setConnectionError(t(`toon_factory.edge_${result.reason.replaceAll("-", "_")}`));
      return;
    }
    props.onChange({ ...props.canvas, edges: [...props.canvas.edges, { id: makeIdentifier("edge"), ...candidate }] });
    setPendingConnection(null);
    setConnectionError(null);
  };
  const nodeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, node: ToonNode) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      props.onChange({ ...props.canvas, selectedNodeId: node.id });
      return;
    }
    const movement = event.shiftKey ? 25 : 8;
    const delta = event.key === "ArrowLeft" ? { x: -movement, y: 0 }
      : event.key === "ArrowRight" ? { x: movement, y: 0 }
        : event.key === "ArrowUp" ? { x: 0, y: -movement }
          : event.key === "ArrowDown" ? { x: 0, y: movement }
            : null;
    if (!delta) return;
    event.preventDefault();
    props.onChange({
      ...props.canvas,
      selectedNodeId: node.id,
      nodes: props.canvas.nodes.map((candidate) => candidate.id === node.id
        ? { ...candidate, position: { x: candidate.position.x + delta.x, y: candidate.position.y + delta.y } }
        : candidate),
    });
  };

  return (
    <div className="absolute inset-0 overflow-hidden bg-[radial-gradient(circle_at_1px_1px,var(--dls-border)_1px,transparent_0)] [background-size:20px_20px]" onWheel={zoom} onPointerMove={pointerMove} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }} onPointerDown={(event) => { if ((event.target as HTMLElement).closest("button,[data-toon-node]")) return; event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { kind: "canvas", startX: event.clientX, startY: event.clientY, originX: viewport.x, originY: viewport.y }; props.onChange({ ...props.canvas, selectedNodeId: undefined }); }} data-testid="toon-node-canvas">
      <div className="absolute left-3 top-3 z-30 flex max-w-[calc(100%-1.5rem)] flex-wrap gap-1 rounded-xl border border-dls-border bg-background/95 p-1.5 shadow-sm" data-testid="toon-node-palette">{TOON_NODE_DEFINITIONS.map((definition) => <button key={definition.kind} type="button" onClick={() => addNode(definition.kind)} className="rounded-md px-2 py-1 text-[10px] text-dls-secondary hover:bg-dls-hover hover:text-dls-text" data-testid={`toon-add-node-${definition.kind}`}>+ {t(definition.labelKey)}</button>)}</div>
      {connectionError ? <div className="absolute bottom-3 left-3 z-30 rounded-lg bg-destructive px-3 py-2 text-[10px] text-white" role="alert">{connectionError}</div> : null}
      {pendingConnection ? <div className="absolute bottom-3 right-3 z-30 rounded-lg border border-dls-border bg-background px-3 py-2 text-[10px] text-dls-secondary" role="status">{t("toon_factory.choose_target_handle")}</div> : null}
      <div className="absolute left-0 top-0 h-[1600px] w-[2400px] origin-top-left" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}>
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">{props.canvas.edges.map((edge) => {
          const source = positions.get(edge.sourceNodeId);
          const target = positions.get(edge.targetNodeId);
          if (!source || !target) return null;
          const x1 = source.x + 220; const y1 = source.y + 60; const x2 = target.x; const y2 = target.y + 60;
          return <path key={edge.id} d={`M ${x1} ${y1} C ${x1 + 90} ${y1}, ${x2 - 90} ${y2}, ${x2} ${y2}`} fill="none" stroke="var(--dls-accent)" strokeWidth="2" />;
        })}</svg>
        {props.canvas.nodes.map((node) => { const nodeLabel = node.data.label ?? t(TOON_NODE_DEFINITIONS.find((item) => item.kind === node.kind)!.labelKey); return <div key={node.id} role="button" tabIndex={0} aria-label={nodeLabel} aria-pressed={props.canvas.selectedNodeId === node.id} className={cn("absolute w-[220px] rounded-xl border bg-background shadow-[var(--dls-card-shadow)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent", props.canvas.selectedNodeId === node.id ? "border-dls-accent ring-2 ring-dls-accent/15" : "border-dls-border")} style={{ transform: `translate(${node.position.x}px, ${node.position.y}px)` }} onKeyDown={(event) => nodeKeyDown(event, node)} onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { kind: "node", id: node.id, startX: event.clientX, startY: event.clientY, originX: node.position.x, originY: node.position.y }; props.onChange({ ...props.canvas, selectedNodeId: node.id }); }} data-toon-node={node.id} data-testid={`toon-node-${node.kind}`}>
          <div className="cursor-grab border-b border-dls-border px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-dls-secondary">{t(`toon_factory.node_kind_${node.kind.replaceAll("-", "_")}`)}</p><p className="truncate text-xs font-semibold text-dls-text">{nodeLabel}</p></div>
          <div className="relative min-h-12 px-3 py-2 text-[10px] text-dls-secondary">{node.data.contentRef ?? node.data.assetRef ?? t("toon_factory.node_unconfigured")}{node.handles.map((handle, index) => <button key={handle.id} type="button" title={`${handle.direction}: ${handle.dataType}`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); handleClick(node, handle.id, handle.direction); }} className={cn("absolute size-3 rounded-full border-2 border-background", handle.direction === "source" ? "-right-1.5 bg-dls-accent" : "-left-1.5 bg-amber-500")} style={{ top: 10 + index * 15 }} data-testid={`toon-handle-${node.id}-${handle.id}`} />)}</div>
        </div>; })}
      </div>
    </div>
  );
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
      const stepId = props.node.kind === "storyboard" ? "storyboard" : props.node.kind === "asset" ? "asset-plan" : "episode-script";
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
function MainError({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="flex h-full flex-col items-center justify-center p-6 text-center"><AlertTriangle className="size-6 text-destructive" /><p className="mt-2 max-w-md text-xs text-destructive">{message}</p><button type="button" className="mt-3 flex items-center gap-1 rounded-lg border border-dls-border px-3 py-1.5 text-xs" onClick={onRetry}><RefreshCw className="size-3" />{t("toon_factory.retry")}</button></div>; }
function EmptyWorkspace({ title, description, action }: { title: string; description: string; action?: ReactNode }) { return <div className="flex h-full flex-col items-center justify-center p-8 text-center"><span className="flex size-12 items-center justify-center rounded-2xl bg-dls-hover"><FileText className="size-5 text-dls-secondary" /></span><h2 className="mt-3 text-sm font-semibold text-dls-text">{title}</h2><p className="mt-1 max-w-md text-xs leading-5 text-dls-secondary">{description}</p>{action}</div>; }
function ConflictBanner({ message, onReload, compact = false }: { message: string; onReload: () => void; compact?: boolean }) { return <div className={cn("flex items-center justify-between gap-3 border-amber-500/30 bg-amber-500/10 text-amber-700", compact ? "mt-2 rounded-lg border p-2" : "border-b px-4 py-2")} data-testid="toon-conflict"><span className="flex items-center gap-1.5 text-[10px]"><AlertTriangle className="size-3.5 shrink-0" />{message}</span><button type="button" onClick={onReload} className="shrink-0 rounded-md border border-amber-500/30 px-2 py-1 text-[10px]">{t("toon_factory.reload")}</button></div>; }
