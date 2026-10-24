/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QueryObserver } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import type { Session } from "@opencode-ai/sdk/v2/client";
import type { Client, ComposerDraft, ModelRef, TodoItem } from "@/app/types";
import type { PetAction, PetActionResult, PetTarget, PetTask } from "@/app/lib/desktop-pet-types";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import type { JuggleWorkSessionListItem } from "@/app/lib/jugglework-server";
import { createClient, unwrap } from "@/app/lib/opencode";
import { useLocale } from "@/i18n/use-locale";
import { t } from "@/i18n";
import { readSessionChoices, resolveSessionModelChoice } from "@/react-app/kernel/session-model-store";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { getProviderSource, isModelAvailableInConnectedProviders } from "@/react-app/infra/provider-list-query";
import { isDesktopModelBlocked } from "@/app/cloud/desktop-app-restrictions";
import { useCheckDesktopRestriction, useDesktopAllowedModels } from "../cloud/desktop-config-provider";
import { useHostMarketplacePlugins } from "../settings/state/host-marketplace-plugins-provider";
import { useSessionMcpMaintenance } from "../connections/use-session-mcp-maintenance";
import type { CloudMcpSubmissionResult } from "../connections/cloud-mcp-submit-readiness";
import { isManagedModelSubmissionReady } from "../connections/provider-auth/cloud-provider-readiness";
import { isCloudManagedProviderKey } from "../connections/provider-auth/cloud-provider-config";
import { getModelBehaviorSummary } from "@/app/lib/model-behavior";
import { type RouteWorkspace, workspaceLabel } from "@/react-app/shell/route-workspaces";
import { latestRoot, sortedRoots, sessionTreeIds, reconcilePetTaskConnection } from "./pet-model";
import { useDesktopPet } from "./use-desktop-pet";
import { useSessionActivityStore } from "../session/status/session-activity-store";
import { sessionTaskPresentation } from "../session/status/task-presentation";
import { snapshotToUIMessages } from "../session/sync/usechat-adapter";
import { ensureWorkspaceSessionSync, trackWorkspaceSessionsSync, seedSessionState, snapshotKey, transcriptKey, todoKey, clearSessionTodos, captureTodoSnapshotRevision, captureSessionSnapshotRevision, recordSessionSnapshotRevision, isSessionSnapshotCurrent } from "../session/sync/session-sync";
import { seedWorkspaceSessionAncestry } from "../session/sync/workspace-interactions";
import { useComposerStateStore } from "../session/surface/composer-state-store";
import { submitPetFollowUp } from "./pet-submission";
import { clearQueuedSessionDrafts } from "../session/surface/queued-draft-cleanup";
import { isSessionSubmissionPreparing } from "../session/sync/submission-guard";
import { submitSessionDraft } from "../session/sync/draft-submission";
import { useCloudMcpSubmitReadiness } from "../connections/use-cloud-mcp-submit-readiness";
import { generationDraftAvailableInCache, imageModelsQueryOptions, videoModelsQueryOptions, mediaModelQueryScope } from "../connections/media-model-queries";
import type { DenAuthStatus } from "../cloud/den-auth-provider";
import { shouldSynthesizeBusyAfterAcceptance } from "../session/surface/task-progress-state";
import { checkVoiceServiceAvailability, useVoiceService } from "../session/surface/composer/use-voice-service";
import { VoiceDictationController, type VoiceDictationSnapshot } from "../session/surface/composer/voice-dictation";
import { subscribeComposerEditing } from "../session/surface/composer/editing";

type Send = (draft: ComposerDraft, id: string) => Promise<CloudMcpSubmissionResult>;
type Props = {
  workspaces: RouteWorkspace[]; endpointForWorkspace: (workspace: RouteWorkspace) => ResolvedWorkspaceEndpoint | null;
  contextKey: string; defaultModel: ModelRef | null; defaultVariant: string | null;
  coordinatorIds: Record<string, string[]>;
  selectedWorkspaceId: string; selectedSend: Send | null; reloadBusy: boolean; cloudSignedIn: boolean; cloudAuthStatus: DenAuthStatus;
  onOpen: (workspaceId: string, sessionId: string) => void;
  onOpenApp: () => void;
};
type Entry = {
  workspace: RouteWorkspace; endpoint: ResolvedWorkspaceEndpoint; client: Client;
  sessions: Map<string, JuggleWorkSessionListItem>; tasks: PetTask[]; syncing: boolean; partial: boolean;
  reconcileActive: (ids: string[]) => void;
  refresh: () => Promise<void>; send: (target: PetTarget, text: string, continuation?: boolean) => Promise<PetActionResult>;
  stop: (target: PetTarget) => Promise<PetActionResult>;
};
const EMPTY_MESSAGES: UIMessage[] = [];
const EMPTY_TODOS: TodoItem[] = [];
const keyFor = (workspaceId: string, sessionId: string) => `${workspaceId}:${sessionId}`;
const targetFor = (workspace: RouteWorkspace, session: Session): PetTarget => ({ key: keyFor(workspace.id, session.id), workspaceId: workspace.id, sessionId: session.id, project: workspaceLabel(workspace), title: session.title });
const textDraft = (text: string): ComposerDraft => ({ text, parts: [{ type: "text", text }], attachments: [], mode: "prompt" });

/** 常驻主渲染器的唯一宠物业务宿主；隐藏主窗口不释放会话订阅或麦克风控制器。 */
export function DesktopPetHost(props: Props) {
  const { bridge, snapshot } = useDesktopPet();
  const locale = useLocale();
  const entries = useRef(new Map<string, Entry>());
  const latest = useRef(props); latest.current = props;
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((value) => value + 1), []);
  const [editing, setEditing] = useState(false);
  const [mainComposerEditing, setMainComposerEditing] = useState(false);
  const [voice, setVoice] = useState<VoiceDictationSnapshot>({ phase: "idle" });
  const [transcript, setTranscript] = useState<{ text: string; id: number } | null>(null);
  const dictation = useRef<VoiceDictationController | null>(null);
  const voiceRequest = useRef(0);
  const visible = snapshot?.visible === true;
  const theme = document.documentElement.classList.contains("dark") || document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const [appearance, setAppearance] = useState<"light" | "dark">(theme);
  const pinnedVoiceTarget = snapshot?.interaction?.drafts.__quick__ ? snapshot.interaction.target : null;
  const voiceProject = pinnedVoiceTarget?.workspaceId ?? latestRoot([...entries.current.values()].flatMap((entry) => [...entry.sessions.values()].map((session) => ({ key: keyFor(entry.workspace.id, session.id), session, workspaceId: entry.workspace.id }))))?.workspaceId ?? props.selectedWorkspaceId;
  const voiceClient = entries.current.get(voiceProject)?.endpoint.client;
  const voiceAvailability = useVoiceService(voiceClient?.getVoiceRealtimeStatus, visible && Boolean(voiceClient));

  useEffect(() => {
    if (visible) return subscribeComposerEditing(setMainComposerEditing);
    setMainComposerEditing(false);
  }, [visible]);

  useEffect(() => {
    const observer = new MutationObserver(() => setAppearance(document.documentElement.classList.contains("dark") || document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!bridge) return;
    const values = [...entries.current.values()];
    bridge.publish({ contextKey: props.contextKey, ready: visible && (values.length > 0 || !props.workspaces.length), syncing: values.some((entry) => entry.syncing), partial: values.some((entry) => entry.partial) || values.length < props.workspaces.length,
      tasks: visible ? values.flatMap((entry) => entry.tasks) : [], locale: locale === "zh" ? "zh" : "en", theme: appearance,
      editing, mainComposerEditing, voicePhase: voice.phase, voiceAvailable: voiceAvailability === "available", voiceChecking: voiceAvailability === "checking", voiceError: voice.errorMessage, voiceText: transcript ? JSON.stringify(transcript) : undefined });
  }, [bridge, props.contextKey, visible, revision, editing, mainComposerEditing, voice, transcript, appearance, locale, voiceAvailability, props.workspaces.length]);
  useEffect(() => {
    if (visible) return;
    voiceRequest.current++;
    dictation.current?.dispose(); dictation.current = null; setVoice({ phase: "idle" }); setEditing(false); setTranscript(null);
  }, [visible]);
  useEffect(() => { voiceRequest.current++; dictation.current?.dispose(); dictation.current = null; setVoice({ phase: "idle" }); setEditing(false); setTranscript(null); }, [props.contextKey]);
  useEffect(() => {
    return () => { voiceRequest.current++; dictation.current?.dispose(); };
  }, []);
  useEffect(() => bridge?.onAction(async (action: PetAction) => {
    if (action.type === "editing") { setEditing(action.active); return; }
    if (action.type === "voice-stop") { voiceRequest.current++; await dictation.current?.stop(); return; }
    if (action.type === "voice-cancel") { voiceRequest.current++; dictation.current?.cancel(); return; }
    if (action.type === "restore") return;
    if (action.type === "open-app") { latest.current.onOpenApp(); return; }
    if (action.type === "activate-app") return;
    const all = () => [...entries.current.values()];
    if (action.type === "latest" || action.type === "sessions") {
      await Promise.all(all().map((entry) => entry.refresh()));
      const partial = all().length < latest.current.workspaces.length || all().some((entry) => entry.partial);
      // TIPS: 会话选择使用全量主会话元信息，不能复用仅包含活动/未读项的提醒卡片。
      const roots = sortedRoots(all().flatMap((entry) => [...entry.sessions.values()].map((session) => ({ key: keyFor(entry.workspace.id, session.id), session, target: targetFor(entry.workspace, session) }))));
      if (action.type === "sessions") return { targets: roots.map((item) => item.target), partial };
      const selected = roots[0];
      if (!selected) return { partial };
      return { target: selected.target, partial };
    }
    const target = "target" in action ? action.target : all().flatMap((entry) => entry.tasks).find((task) => "key" in action && task.key === action.key);
    if (!target) throw new Error("任务已变化，请重新打开原聊天");
    const entry = entries.current.get(target.workspaceId);
    if (!entry) throw new Error("目标项目不可用");
    if (action.type === "open" || action.type === "open-target") { latest.current.onOpen(target.workspaceId, target.sessionId); return; }
    if (action.type === "stop") return entry.stop(target);
    if (action.type === "send") return entry.send(target, action.text);
    if (action.type === "continue") return entry.send(target, action.text?.trim() || t("pet.continue_prompt"), true);
    if (action.type === "voice-start") {
      const request = ++voiceRequest.current;
      // TIPS: 刷新最新会话或切换项目后，必须验证实际目标；旧项目的available/checking不能替代新目标结果。
      const availability = await checkVoiceServiceAvailability(entry.endpoint.client.getVoiceRealtimeStatus);
      if (request !== voiceRequest.current || entries.current.get(target.workspaceId) !== entry) return;
      if (availability !== "available") throw new Error(t("composer.voice_unavailable"));
      if (dictation.current && !["idle", "error"].includes(dictation.current.getSnapshot().phase)) throw new Error("请先结束当前语音输入");
      dictation.current?.dispose();
      dictation.current = new VoiceDictationController({ sessionId: `pet:${target.key}`, createSession: () => entry.endpoint.client.createVoiceRealtimeSession({ purpose: "dictation" }),
        onSnapshot: (value) => setVoice({ ...value, errorMessage: value.errorCode ? t(value.errorCode === "microphone_busy" ? "composer.voice_busy" : value.errorCode === "permission_denied" ? "composer.voice_permission_denied" : value.errorCode === "service_unavailable" ? "composer.voice_unavailable" : value.errorCode === "transcription_timeout" ? "composer.voice_timeout" : "composer.voice_failed") : value.errorMessage }), onTranscript: (text) => setTranscript({ text, id: Date.now() }), onEmpty: () => {} });
      await dictation.current.start();
    }
  }), [bridge]);
  if (!bridge) return null;
  return <>{props.workspaces.map((workspace) => <PetWorkspace key={`${props.contextKey}:${workspace.id}`} workspace={workspace} endpoint={props.endpointForWorkspace(workspace)} enabled={visible} latest={latest} entries={entries} changed={changed} />)}</>;
}

type WorkerProps = { workspace: RouteWorkspace; endpoint: ResolvedWorkspaceEndpoint | null; enabled: boolean; latest: React.RefObject<Props>; entries: React.RefObject<Map<string, Entry>>; changed: () => void };
type ObservedDescendants = Map<string, Map<string, string>>;
/** 每个项目复用原有会话同步和队列；仅有宠物展示或尚未发送的宠物队列时保留。 */
function PetWorkspace(props: WorkerProps) {
  const queued = useComposerStateStore((state) => Object.values(state.queuedDrafts).some((queue) => queue.some((item) => item.petWorkspaceId === props.workspace.id)));
  const [sending, setSending] = useState(false);
  const observedTasks = useRef(new Set<string>());
  const observedDescendants = useRef<ObservedDescendants>(new Map());
  return props.enabled || queued || sending ? <PetWorkspaceRuntime {...props} observedTasks={observedTasks.current} observedDescendants={observedDescendants.current} onSending={setSending} /> : null;
}

/** 只在展示或消费原会话队列期间挂载实际同步和连接维护。 */
function PetWorkspaceRuntime({ workspace, endpoint, enabled, latest, entries, changed, onSending, observedTasks, observedDescendants }: WorkerProps & { onSending: (value: boolean) => void; observedTasks: Set<string>; observedDescendants: ObservedDescendants }) {
  const enabledRef = useRef(enabled); enabledRef.current = enabled;
  useEffect(() => { if (enabled) void entries.current.get(workspace.id)?.refresh(); }, [enabled]);
  const background = latest.current.selectedWorkspaceId !== workspace.id;
  const client = useMemo(() => endpoint ? createClient(endpoint.opencodeBaseUrl, workspace.path, { mode: "jugglework", token: endpoint.token }) : null, [endpoint?.opencodeBaseUrl, endpoint?.token, workspace.path]);
  const marketplace = useHostMarketplacePlugins();
  const checkRestriction = useCheckDesktopRestriction();
  const allowedModels = useDesktopAllowedModels();
  const maintenance = useSessionMcpMaintenance({ cloudSignedIn: background && latest.current.cloudSignedIn, client: background ? endpoint?.client ?? null : null, workspaceId: endpoint?.workspaceId ?? null, opencodeClient: background ? client : null, directory: workspace.path, engineReloadBusy: latest.current.reloadBusy });
  const cloudReadiness = useCloudMcpSubmitReadiness({ cloudAuthStatus: latest.current.cloudAuthStatus, client: endpoint?.client ?? null, workspaceId: endpoint?.workspaceId ?? null });
  const options = useRef({ maintenance, marketplace, checkRestriction, allowedModels, cloudReadiness }); options.current = { maintenance, marketplace, checkRestriction, allowedModels, cloudReadiness };
  const coordinatorKey = (latest.current.coordinatorIds[workspace.id] ?? []).join("\0");
  useEffect(() => { entries.current.get(workspace.id)?.reconcileActive(latest.current.coordinatorIds[workspace.id] ?? []); }, [coordinatorKey]);
  useEffect(() => {
    if (!endpoint || !client) return;
    let disposed = false, discovering: Promise<void> | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let projectTimer: ReturnType<typeof setTimeout> | undefined;
    let releaseTracked: (() => void) | undefined;
    let trackedKey = "";
    const query = getReactQueryClient();
    const sessions = new Map<string, JuggleWorkSessionListItem>();
    const observers = new Map<string, () => void>();
    const stopping = new Set<string>(), preparing = new Set<string>();
    // TIPS: 外层在隐藏期间保留已关注任务，避免隐藏再显示清掉未读完成提醒；账号切换随组件清空。
    const activeIds = new Set<string>();
    const abortingIds = new Set<string>();
    let authoritative = false;
    let metadataReady = Promise.resolve();
    const readRevisions = new Map<string, number>();
    const failedSnapshots = new Set<string>();
    const presentationCache = new Map<string, { messages: UIMessage[]; todos: TodoItem[]; activity: unknown; result: ReturnType<typeof sessionTaskPresentation> }>();
    // TIPS: 完成提醒只保留展示事实，释放正文观察者后仍保留轮次和回复；新运行重新读取原会话。
    const completedPresentations = new Map<string, ReturnType<typeof sessionTaskPresentation>>();
    const descendants = (root: string) => sessionTreeIds(sessions.values(), root);
    const rootFor = (id: string) => {
      const seen = new Set<string>();
      while (sessions.get(id)?.parentID && !seen.has(id)) { seen.add(id); id = sessions.get(id)!.parentID!; }
      return sessions.has(id) ? id : null;
    };
    const presentation = (id: string) => {
      const messages = query.getQueryData<UIMessage[]>(transcriptKey(endpoint.workspaceId, id)) ?? EMPTY_MESSAGES;
      const todos = query.getQueryData<TodoItem[]>(todoKey(endpoint.workspaceId, id)) ?? EMPTY_TODOS;
      const activity = useSessionActivityStore.getState().recordsByWorkspaceId[endpoint.workspaceId]?.[id];
      if (activeIds.has(id) || activity?.runActive || activity?.compacting || activity?.waitingPermissionIds.length || activity?.waitingQuestionIds.length || activity?.errorActive || activity?.completionBlocked) completedPresentations.delete(id);
      const completed = completedPresentations.get(id);
      if (!messages.length && completed) return completed;
      const cached = presentationCache.get(id);
      if (cached && cached.messages === messages && cached.todos === todos && cached.activity === activity) return cached.result;
      const result = sessionTaskPresentation(messages, todos, activity);
      presentationCache.set(id, { messages, todos, activity, result }); return result;
    };
    const loadSnapshot = async (id: string) => {
      try {
        let snapshotRevision = captureSessionSnapshotRevision(endpoint.workspaceId, id);
        let snapshotTodoRevision = captureTodoSnapshotRevision();
        let { item } = await endpoint.client.getSessionSnapshot(endpoint.workspaceId, id, { limit: 200 });
        // TIPS: 若最近200条仍未覆盖真实用户轮次，才补完整快照，不能把截断当作无任务。
        if (item.messages.length >= 200 && !snapshotToUIMessages(item).some((message) => message.role === "user")) {
          snapshotRevision = captureSessionSnapshotRevision(endpoint.workspaceId, id);
          snapshotTodoRevision = captureTodoSnapshotRevision();
          item = (await endpoint.client.getSessionSnapshot(endpoint.workspaceId, id)).item;
        }
        recordSessionSnapshotRevision(item, snapshotRevision);
        // TIPS: 观察者和元信息回补可能交错读取；旧回执既不能恢复busy，也不能作为返回值覆盖较新的共享快照。
        const current = query.getQueryData<import("@/app/lib/jugglework-server").JuggleWorkSessionSnapshot>(snapshotKey(endpoint.workspaceId, id));
        if (current && current.session.time.updated > item.session.time.updated) {
          if (!disposed) { failedSnapshots.delete(id); readRevisions.set(id, current.session.time.updated); }
          return current;
        }
        // TIPS: 请求开始后的实时todo优先；调用方不能再以当前版本重复回填同一快照。
        if (!disposed) { failedSnapshots.delete(id); readRevisions.set(id, item.session.time.updated); seedSessionState(endpoint.workspaceId, item, { snapshotTodoRevision }); }
        return item;
      } catch (error) {
        if (!disposed) { failedSnapshots.add(id); entry.partial = true; projectSoon(); }
        throw error;
      }
    };
    const targetValid = async (target: PetTarget) => {
      const { item } = await endpoint.client.getSession(endpoint.workspaceId, target.sessionId);
      if (item.parentID || item.time.archived) throw new Error("该任务已归档或不是主任务，请重新选择");
      sessions.set(item.id, item); return item;
    };
    const entry: Entry = { workspace, endpoint, client, sessions, tasks: [], syncing: true, partial: false,
      reconcileActive: () => {}, refresh: async () => {}, send: async () => ({}), stop: async () => ({}) };
    const observe = (id: string) => {
      if (observers.has(id)) return;
      // TIPS: transcript默认15秒回收；只有SSE跟踪和snapshot观察者仍会丢正文，须持有实际展示缓存。
      const transcript = new QueryObserver<UIMessage[]>(query, { queryKey: transcriptKey(endpoint.workspaceId, id), enabled: false });
      const releaseTranscript = transcript.subscribe(projectSoon);
      const cached = query.getQueryData<import("@/app/lib/jugglework-server").JuggleWorkSessionSnapshot>(snapshotKey(endpoint.workspaceId, id));
      if (cached && !query.getQueryData(transcriptKey(endpoint.workspaceId, id))) seedSessionState(endpoint.workspaceId, cached, { skipTodos: true });
      const observer = new QueryObserver(query, { queryKey: snapshotKey(endpoint.workspaceId, id), queryFn: async () => {
        return loadSnapshot(id);
      }, structuralSharing: false, staleTime: 30_000, retry: 1 });
      const releaseSnapshot = observer.subscribe(projectSoon);
      observers.set(id, () => { releaseTranscript(); releaseSnapshot(); });
    };
    const project = () => {
      projectTimer = undefined; if (disposed) return;
      const roots = [...sessions.values()].filter((session) => !session.parentID && !session.time.archived);
      const tasks: PetTask[] = [];
      const previousTasks = new Map(entry.tasks.map((task) => [task.key, task]));
      const membersByRoot = new Map<string, string[]>();
      for (const session of sessions.values()) {
        const root = rootFor(session.id); if (!root) continue;
        const members = membersByRoot.get(root) ?? []; members.push(session.id); membersByRoot.set(root, members);
      }
      const keep = new Set<string>();
      for (const session of roots) {
        const own = presentation(session.id);
        const members = membersByRoot.get(session.id) ?? [session.id];
        // TIPS: 记录观察到子任务运行时的根轮次；根快照晚到时再按用户消息时间归属，不能丢掉已确认的中断。
        const owned = observedDescendants.get(session.id) ?? new Map<string, string>();
        observedDescendants.set(session.id, owned);
        for (const id of owned.keys()) if (!members.includes(id)) owned.delete(id);
        for (const id of members) if (id !== session.id && (activeIds.has(id) || presentation(id).active || presentation(id).waiting)) owned.set(id, own.turnKey);
        const currentMembers = members.filter((id) => {
          if (id === session.id) return true;
          const child = presentation(id);
          // 历史终态不能污染下一轮；新轮次的子消息允许在根快照前后任意到达。
          return activeIds.has(id) || child.active || child.waiting || (owned.has(id) && (owned.get(id) === own.turnKey ||
            (typeof own.turnCreatedAt === "number" && typeof child.turnCreatedAt === "number" && child.turnCreatedAt >= own.turnCreatedAt)));
        });
        const resumableChildren = currentMembers.filter((id) => id !== session.id).map(presentation).filter((item) => item.resumable);
        const resumableChild = resumableChildren[0];
        const active = members.some((id) => activeIds.has(id) || presentation(id).active);
        const waiting = members.some((id) => presentation(id).waiting);
        const display = members.map(presentation).find((item) => item.waiting) ?? (own.active ? own : members.map(presentation).find((item) => item.active)) ?? resumableChild ?? own;
        const queue = useComposerStateStore.getState().queuedDrafts[session.id] ?? [];
        const pendingFollowUp = queue.some((item) => item.petWorkspaceId === workspace.id);
        const blocked = pendingFollowUp ? queue.find((item) => item.petBlockedReason) : undefined;
        const relevant = active || waiting || own.resumable || Boolean(resumableChild) || preparing.has(session.id) || stopping.has(session.id) || pendingFollowUp;
        if (relevant) observedTasks.add(session.id);
        const completed = !relevant && own.completed && observedTasks.has(session.id);
        if (!relevant && !observedTasks.has(session.id)) continue;
        const reconciling = (!active && (pendingFollowUp || preparing.has(session.id))) || Boolean(blocked) || stopping.has(session.id) || members.some((id) => abortingIds.has(id)) || (!relevant && !completed);
        const task: PetTask = { ...targetFor(workspace, session), turnKey: own.turnKey, state: waiting ? "waiting" : reconciling ? "reconciling" : active ? "running" : completed ? "completed" : "resumable", statusText: completed ? t("pet.completed") : !active && pendingFollowUp ? t("pet.queued") : display.statusText, progressText: completed ? own.responseText : blocked?.petBlockedReason ?? display.progressText ?? own.progressText, canStop: active, stopped: !active && !waiting && (own.stopped || resumableChildren.some((item) => item.stopped)), stopping: stopping.has(session.id) || members.some((id) => abortingIds.has(id)), preparing: preparing.has(session.id) };
        // TIPS: 上一轮的断线结束原因不是当前连接健康状态；成功读取的快照允许用户继续原任务。
        // TIPS: 无关历史子任务的读取失败只披露部分同步，不能阻塞本轮根任务的已确认结果。
        const disconnected = !authoritative || currentMembers.some((id) => failedSnapshots.has(id));
        const reconciled = reconcilePetTaskConnection(task, previousTasks.get(task.key), disconnected, t("pet.connection_lost"));
        tasks.push(reconciled);
        if (reconciled.state === "completed") completedPresentations.set(session.id, own);
        else members.forEach((id) => keep.add(id));
      }
      // TIPS: 元信息恢复失败可能缺少根任务；保留已关注的卡片，不能把查询失败当成任务完成或删除。
      if (!authoritative) for (const previous of entry.tasks) {
        if (observedTasks.has(previous.sessionId) && !tasks.some((task) => task.key === previous.key)) {
          keep.add(previous.sessionId);
          tasks.push(reconcilePetTaskConnection(previous, previous, true, t("pet.connection_lost")));
        }
      }
      tasks.sort((a,b) => (sessions.get(b.sessionId)?.time.updated ?? 0) - (sessions.get(a.sessionId)?.time.updated ?? 0) || a.key.localeCompare(b.key));
      entry.tasks = tasks;
      for (const id of observedDescendants.keys()) if ((authoritative && !sessions.has(id)) || sessions.get(id)?.time.archived) observedDescendants.delete(id);
      for (const id of observedTasks) if ((authoritative && !sessions.has(id)) || sessions.get(id)?.time.archived) { observedTasks.delete(id); completedPresentations.delete(id); }
      const nextKey = [...keep].sort().join("\0");
      if (nextKey !== trackedKey) { releaseTracked?.(); trackedKey = nextKey; releaseTracked = trackWorkspaceSessionsSync(syncInput, [...keep]); }
      for (const id of keep) observe(id);
      for (const [id, release] of observers) if (!keep.has(id) && !entry.syncing) { release(); observers.delete(id); }
      for (const id of presentationCache.keys()) if (!keep.has(id)) presentationCache.delete(id);
      changed(); void drain();
    };
    const projectSoon = () => { if (!projectTimer && !disposed) projectTimer = setTimeout(project, 150); };
    const syncInput = { workspaceId: endpoint.workspaceId, baseUrl: endpoint.opencodeBaseUrl, juggleworkToken: endpoint.token, interactionClient: endpoint.client,
      onSessionCreated: (session: Session) => { sessions.set(session.id, session); void discover(); },
      onSessionUpdated: ({ sessionId, info }: { sessionId: string; info: Record<string, unknown> }) => { const previous = sessions.get(sessionId); if (previous) sessions.set(sessionId, { ...previous, ...info } as JuggleWorkSessionListItem); projectSoon(); },
      onSessionDeleted: (id: string) => { sessions.delete(id); observedTasks.delete(id); observedDescendants.delete(id); completedPresentations.delete(id); observers.get(id)?.(); observers.delete(id); projectSoon(); } };
    const releaseWorkspace = ensureWorkspaceSessionSync(syncInput);
    const discover = (): Promise<void> => {
      if (discovering) return metadataReady;
      let releaseMetadata!: () => void;
      metadataReady = new Promise((resolve) => { releaseMetadata = resolve; });
      discovering = (async () => {
        try {
          // TIPS: 元信息覆盖全项目；只在首次发现/重新连接时读历史快照，不按悬停重新拉取。
          const [listed, runs] = await Promise.all([endpoint.client.listSessions(endpoint.workspaceId, { limit: 10_000 }), endpoint.client.listActiveSessionRuns(endpoint.workspaceId)]);
          if (disposed) return;

          sessions.clear(); listed.items.forEach((item) => sessions.set(item.id, item));
          activeIds.clear(); abortingIds.clear(); runs.items.forEach((run) => { activeIds.add(run.sessionId); if (run.status === "aborting") abortingIds.add(run.sessionId); });
          // 活跃子任务不一定在列表首屏，单独补齐其祖先，不能把子任务误当成主任务。
          for (const run of runs.items) {
            let id: string | undefined = run.sessionId; const seen = new Set<string>();
            while (id && !seen.has(id)) { seen.add(id); if (!sessions.has(id)) { const { item } = await endpoint.client.getSession(endpoint.workspaceId, id); sessions.set(id, item); } id = sessions.get(id)?.parentID; }
          }
          seedWorkspaceSessionAncestry(endpoint.workspaceId, [...sessions.values()]);
          authoritative = true; entry.partial = listed.items.length >= 10_000;
          releaseMetadata();
          const candidates = [...sessions.values()].filter((session) => {
            if (session.time.archived) return false;
            const cached = query.getQueryData<import("@/app/lib/jugglework-server").JuggleWorkSessionSnapshot>(snapshotKey(endpoint.workspaceId, session.id));
            return failedSnapshots.has(session.id) || activeIds.has(session.id) || (cached && !isSessionSnapshotCurrent(endpoint.workspaceId, cached)) || (readRevisions.get(session.id) ?? cached?.session.time.updated ?? -1) < session.time.updated;
          });
          // 每次最多四个历史读请求，完成一个即可展示；不会为每个项目额外轮询750ms。
          let cursor = 0;
          await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
            while (cursor < candidates.length && !disposed && enabledRef.current) {
              const session = candidates[cursor++]!;
              try {
                const cached = query.getQueryData<import("@/app/lib/jugglework-server").JuggleWorkSessionSnapshot>(snapshotKey(endpoint.workspaceId, session.id));
                const reuse = cached && isSessionSnapshotCurrent(endpoint.workspaceId, cached) && cached.session.time.updated >= session.time.updated && !activeIds.has(session.id) && !failedSnapshots.has(session.id);
                const item = reuse ? cached : await loadSnapshot(session.id);
                if (!disposed) {
                  readRevisions.set(session.id, item.session.time.updated); query.setQueryData(snapshotKey(endpoint.workspaceId, session.id), item);
                  // 缓存没有请求前的todo版本，只恢复正文和状态，不覆盖实时进度。
                  if (reuse) seedSessionState(endpoint.workspaceId, item, { skipTodos: true });
                  projectSoon();
                }
              }
              catch { entry.partial = true; }
            }
          }));
          for (const id of activeIds) { const root = rootFor(id); if (!root) entry.partial = true; }
        } catch { entry.partial = true; authoritative = false; }
        finally { releaseMetadata(); entry.syncing = false; projectSoon(); }
      })().finally(() => { discovering = null; });
      return metadataReady;
    };
    entry.refresh = async () => {
      await discover();
      if (!disposed && !timer && enabledRef.current) timer = setTimeout(poll, 10_000);
    };
    entry.reconcileActive = (ids) => {
      const ended = [...activeIds].filter((id) => !ids.includes(id));
      const added = ids.filter((id) => !activeIds.has(id));
      activeIds.clear(); ids.forEach((id) => activeIds.add(id));
      for (const id of abortingIds) if (!activeIds.has(id)) abortingIds.delete(id);
      for (const id of [...ended, ...added]) {
        if (!sessions.has(id)) { void discover(); continue; }
        observe(id); void query.invalidateQueries({ queryKey: snapshotKey(endpoint.workspaceId, id), exact: true });
      }
      projectSoon();
    };
    const sendNow = async (target: PetTarget, draft: ComposerDraft) => {
      if (latest.current.reloadBusy) throw new Error("引擎正在恢复，请稍后发送");
      if (disposed) throw new Error("任务上下文已变化，请重新发送");
      const before = useSessionActivityStore.getState().recordsByWorkspaceId[endpoint.workspaceId]?.[target.sessionId]?.runGeneration ?? 0;
      if (latest.current.selectedWorkspaceId === workspace.id && latest.current.selectedSend) {
        const result = await latest.current.selectedSend(draft, target.sessionId);
        if (result.outcome !== "sent") throw new Error(result.outcome === "blocked" ? result.issue.message : "目标上下文已变化，请重新发送");
      } else {
        const mediaScope = mediaModelQueryScope({ endpoint: endpoint.client.baseUrl, workspaceId: endpoint.workspaceId, workspaceRoot: workspace.path });
        const result = await submitSessionDraft({
          draft, sessionId: target.sessionId, workspaceId: workspace.id, workspaceRoot: workspace.path,
          client, host: endpoint.client, endpoint, workspaceType: workspace.workspaceType,
          isCurrent: () => !disposed && !latest.current.reloadBusy,
          cloudSubmit: (input) => options.current.cloudReadiness.submit(input),
          validateGeneration: () => generationDraftAvailableInCache(query, mediaScope, draft),
          prepare: async () => {
          await targetValid(target);
          if (disposed) throw new Error("任务上下文已变化，请重新发送");
          const choice = resolveSessionModelChoice({ choices: readSessionChoices(workspace.id), sessionId: target.sessionId, defaultModel: latest.current.defaultModel, defaultVariant: latest.current.defaultVariant });
          const providers = unwrap(await client.provider.list());
          if (choice.model && (isDesktopModelBlocked({ model: choice.model, checkRestriction: options.current.checkRestriction, allowedModels: options.current.allowedModels, providerSource: getProviderSource(providers, choice.model.providerID) }) || !isModelAvailableInConnectedProviders(providers, choice.model))) throw new Error("该任务的模型不可用，请打开原聊天选择模型");
          if (choice.model && isCloudManagedProviderKey(choice.model.providerID) && !isManagedModelSubmissionReady({ cloudProviderSyncReady: false, providerList: providers, model: choice.model })) throw new Error(t("app.error_managed_model_preparing"));
          const resume = await options.current.maintenance.waitForResumeMaintenance();
          if (resume.outcome === "timed_out" || resume.outcome === "failed") throw new Error("JuggleWork Connect 恢复未完成，请稍后重试");
          await options.current.marketplace.ensureReadyForTarget({ client: endpoint.client, token: endpoint.token, hostToken: endpoint.hostToken, workspaceType: workspace.workspaceType, remoteType: workspace.remoteType });
          if (disposed || latest.current.reloadBusy) throw new Error("目标上下文已变化，请重新发送");
          const modelEntry = providers.all.find((item) => item.id === choice.model?.providerID)?.models[choice.model?.modelID ?? ""];
          const variant = choice.model && modelEntry ? getModelBehaviorSummary(choice.model.providerID, modelEntry, choice.variant).value : choice.variant;
          await Promise.all([
            draft.imageGeneration ? query.fetchQuery(imageModelsQueryOptions(endpoint.client, mediaScope)) : null,
            draft.videoGeneration ? query.fetchQuery(videoModelsQueryOptions(endpoint.client, mediaScope)) : null,
          ]);
          clearSessionTodos(endpoint.workspaceId, target.sessionId);
          return { model: choice.model, variant };
          },
        });
        if (result.outcome !== "sent") throw new Error(result.outcome === "blocked" ? result.issue.message : "目标上下文或模型已变化，请重新发送");
      }
      const activity = useSessionActivityStore.getState();
      observedTasks.add(target.sessionId);
      if (shouldSynthesizeBusyAfterAcceptance({ runGenerationBeforeSend: before, activityAfterSend: activity.recordsByWorkspaceId[endpoint.workspaceId]?.[target.sessionId] })) activity.setRunStatus(endpoint.workspaceId, target.sessionId, { type: "busy" });
      useComposerStateStore.getState().appendHistory(target.sessionId, draft.parts.some((part) => part.type === "office-selection") ? draft.resolvedText ?? draft.text : draft.text); observe(target.sessionId); projectSoon();
    };
    entry.send = async (target, text, continuation = false) => {
      if (!text.trim()) throw new Error("请输入内容");
      if (preparing.has(target.sessionId) || stopping.has(target.sessionId) || [...descendants(target.sessionId)].some((id) => abortingIds.has(id))) throw new Error("任务操作尚未完成");
      preparing.add(target.sessionId); projectSoon();
      try {
        await targetValid(target);
        if (disposed) throw new Error("任务上下文已变化，请重新发送");
        const runs = await endpoint.client.listActiveSessionRuns(endpoint.workspaceId);
        const members = descendants(target.sessionId);
        const active = runs.items.some((run) => members.has(run.sessionId)) || isSessionSubmissionPreparing(endpoint.workspaceId, target.sessionId);
        if (continuation && active) throw new Error("任务仍在执行，请等待停止完成");
        if (continuation) {
          await loadSnapshot(target.sessionId);
          if (disposed) throw new Error("任务上下文已变化，请重新发送");
          if (!presentation(target.sessionId).resumable) throw new Error("该任务已完成或状态已变化，请查看原聊天");
        }
        return await submitPetFollowUp({ workspaceId: workspace.id, sessionId: target.sessionId,
          draft: textDraft(text.trim()), active, queueOnBusy: !continuation,
          send: () => sendNow(target, textDraft(text.trim())) });
      } finally { preparing.delete(target.sessionId); projectSoon(); }
    };
    entry.stop = async (target) => {
      stopping.add(target.sessionId); projectSoon();
      let partial = false;
      try {
        await targetValid(target);
        await discover();
        if (disposed) throw new Error("任务上下文已变化，请重新打开");
        const members = descendants(target.sessionId);
        const runs = await endpoint.client.listActiveSessionRuns(endpoint.workspaceId);
        for (const id of members) clearQueuedSessionDrafts(endpoint.client, endpoint.workspaceId, id);
        const results = await Promise.allSettled(runs.items.filter((run) => members.has(run.sessionId)).map((run) => endpoint.client.abortSessionRun(endpoint.workspaceId, run.sessionId, run.runId, { abortCommandCorrelationId: crypto.randomUUID() })));
        partial = results.some((result) => result.status === "rejected");
        for (const id of members) if (id !== target.sessionId && !runs.items.some((run) => run.sessionId === id) && (presentation(id).active || sessions.get(id)?.status?.type === "busy" || sessions.get(id)?.status?.type === "retry")) {
          try { await endpoint.client.abortDelegatedSession(endpoint.workspaceId, target.sessionId, id, { abortCommandCorrelationId: crypto.randomUUID() }); }
          catch { partial = true; }
        }
        // 回执只表示已请求停止，直到服务端确认所有成员结束才显示“继续任务”。
        for (const id of members) await query.invalidateQueries({ queryKey: snapshotKey(endpoint.workspaceId, id), exact: true });
        await discover();
      } finally { stopping.delete(target.sessionId); projectSoon(); }
      if (partial) throw new Error("部分任务停止失败，请再次点击停止重试剩余任务");
      return {};
    };
    let draining = false;
    const drain = async () => {
      if (draining || disposed || !authoritative || latest.current.reloadBusy) return;
      const state = useComposerStateStore.getState();
      for (const [id, queue] of Object.entries(state.queuedDrafts)) {
        const first = queue[0];
        if (!first || !sessions.has(id) || first.petBlockedReason || preparing.has(id) || stopping.has(id)) continue;
        if (first.petWorkspaceId !== workspace.id) {
          if (first.petWorkspaceId || !queue.some((item) => item.petWorkspaceId === workspace.id)) continue;
          if (document.querySelector(`[data-session-surface-id="${CSS.escape(id)}"]`)) continue;
        }
        if (isSessionSubmissionPreparing(endpoint.workspaceId, id) || [...descendants(id)].some((member) => activeIds.has(member) || presentation(member).active)) continue;
        // TIPS: 同一FIFO只有一个消费者领取宠物项；普通会话界面跳过该标记，
        // 宿主在前台/后台都负责它，避免根idle但后代运行时遗失自动发送时机。
        const claimed = state.removeQueuedDraft(id, first.id); if (!claimed) continue;
        draining = true; onSending(true);
        try {
          const session = sessions.get(id); if (!session || session.parentID || session.time.archived) throw new Error("任务不可用");
          await sendNow(targetFor(workspace, session), claimed.draft);
          for (const attachment of claimed.draft.attachments) if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "跟进发送失败，请在原任务编辑后重试";
          if (!disposed) state.restoreQueuedDraft(id, { ...claimed, petBlockedReason: reason });
        } finally { draining = false; onSending(false); projectSoon(); }
        break;
      }
    };
    entries.current.set(workspace.id, entry); changed();
    const releaseActivity = useSessionActivityStore.subscribe(projectSoon);
    const releaseQueries = query.getQueryCache().subscribe((event) => { const key = event.query.queryKey; if (key[1] === endpoint.workspaceId) { if (event.type === "removed" && typeof key[2] === "string") presentationCache.delete(key[2]); projectSoon(); } });
    const releaseQueue = useComposerStateStore.subscribe(projectSoon);
    const poll = async () => { timer = undefined; if (!enabledRef.current) return; await entry.refresh(); };
    void poll();
    return () => { disposed = true; clearTimeout(timer); clearTimeout(projectTimer); releaseActivity(); releaseQueries(); releaseQueue(); releaseTracked?.(); releaseWorkspace(); observers.forEach((release) => release()); entries.current.delete(workspace.id); changed(); };
  }, [endpoint?.opencodeBaseUrl, endpoint?.token, endpoint?.hostToken, client, workspace.id]);
  return null;
}
