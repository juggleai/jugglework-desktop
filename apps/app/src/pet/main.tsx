import { createRoot } from "react-dom/client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Bell, Check, ChevronUp, CornerDownLeft, MessageSquare, Plus, Square, X } from "lucide-react";
import type { PetAction, PetActionResult, PetInteraction, PetSnapshot, PetTarget, PetTask, PetWindowBridge } from "@/app/lib/desktop-pet-types";
import { setLocale, t } from "@/i18n";
import { createPetAnimator, selectPetBaseAction, PET_FRAME_DURATIONS, type PetAnimation } from "./animation";
import { PET_WIDTH, PET_HEIGHT, PET_HIT_SCALE } from "./geometry";
import { PetComposeIcon, PetVoiceIcon } from "./icons";
import { interactionForBridge } from "./interaction-sync";
import { usePetPlacement } from "./use-pet-placement";
import originalHitRegions from "./hit-regions.json";
import "./pet.css";

declare global { interface Window { __JUGGLEWORK_PET__?: PetWindowBridge } }
const hitRegions = originalHitRegions.map((rect) => ({ x: rect.x * PET_HIT_SCALE, y: rect.y * PET_HIT_SCALE, width: rect.width * PET_HIT_SCALE, height: rect.height * PET_HIT_SCALE }));
const contour = hitRegions.map((rect) => `M${rect.x},${rect.y}h${rect.width}v${rect.height}h-${rect.width}Z`).join(" ");
const bridge = window.__JUGGLEWORK_PET__;
/** 读取宠物动作资源；小跳图集修订号避免已有窗口继续复用旧图片缓存。 */
const petImageUrl = (action: PetAnimation | "fallback") => `${import.meta.env.BASE_URL}pets/juggle/${action}.png${action === "celebrate" ? "?v=20261024" : ""}`;
const EMPTY: PetSnapshot = { visible: false, ready: false, syncing: true, partial: false, tasks: [], locale: "zh", theme: "light", editing: false, voicePhase: "idle" };
const EMPTY_INTERACTION: PetInteraction = { drafts: {}, targets: {}, dismissed: {}, target: null };

/** 原生宠物页面；不创建业务客户端、SSE、任务队列或独立麦克风。 */
function PetApp() {
  const [state, setState] = useState(EMPTY);
  const [interaction, setInteraction] = useState(EMPTY_INTERACTION);
  const interactionRef = useRef(EMPTY_INTERACTION);
  const composing = useRef<{ key: string; persistedDraft: string } | null>(null);
  const remember = (update: PetInteraction | ((current: PetInteraction) => PetInteraction), draftOnly = false) => {
    if (state.contextKey !== contextKey.current) return;
    const value = typeof update === "function" ? update(interactionRef.current) : update;
    interactionRef.current = value; setInteraction(value);
    if (!draftOnly) bridge?.remember(interactionForBridge(value, composing.current), state.contextKey);
  };
  const [panel, setPanel] = useState<"tasks" | "input" | null>(null);
  const [taskPanelPresent, setTaskPanelPresent] = useState(false);
  // TIPS: 铃铛先打开堆叠提醒，只有点击提醒才展开列表；工具条箭头始终关闭整个提醒区域。
  const [tasksExpanded, setTasksExpanded] = useState(false);
  const [editor, setEditor] = useState<string | null>(null);
  const [tools, setTools] = useState(false);
  const [inputOptions, setInputOptions] = useState(false);
  const [sessions, setSessions] = useState<PetTarget[]>([]);
  const [sessionsPartial, setSessionsPartial] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [quickKey, setQuickKey] = useState("__quick__");
  const [failedActions, setFailedActions] = useState<string[]>([]);
  const lastTranscript = useRef(0);
  const taskOrder = useRef<string[]>([]);
  const [cardHover, setCardHover] = useState(false);
  const [message, setMessage] = useState("");
  const messageTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const updateMessage = (text: string, transient = false) => {
    clearTimeout(messageTimer.current);
    messageTimer.current = undefined;
    setMessage(text);
    if (transient && text) messageTimer.current = setTimeout(() => { setMessage(""); messageTimer.current = undefined; }, 3000);
  };
  const [frame, setFrame] = useState<{ action: PetAnimation; index: number }>({ action: "typing", index: 0 });
  const root = useRef<HTMLDivElement>(null);
  const character = useRef<HTMLButtonElement>(null);
  const animator = useRef<ReturnType<typeof createPetAnimator> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const drag = useRef<{ x: number; y: number; active: boolean } | null>(null);
  // TIPS: pointerup先清理拖动会话，位移标记需保留到click以防误唤起主窗口。
  const dragged = useRef(false);
  const contextKey = useRef<string | undefined>(undefined);
  const initialized = useRef(false);
  const inputRequest = useRef(0);
  const editorFocusRequest = useRef(0);
  const editorFocusPending = useRef(false);
  const targetRequest = useRef<Promise<PetActionResult | undefined> | null>(null);
  const unreadTasks = state.tasks.filter((task) => task.state !== "completed" || interaction.read?.[task.key] !== task.turnKey);
  const visibleTasks = unreadTasks.filter((task) => interaction.dismissed[task.key] !== task.turnKey);
  const target = quickKey === "__quick__" ? interaction.target : interaction.targets[quickKey] ?? null;
  const quickDraft = interaction.drafts[quickKey] ?? "";
  const editorState = useRef({ panel, key: panel === "input" ? quickKey : editor });
  editorState.current = { panel, key: panel === "input" ? quickKey : editor };
  const voiceActive = !["idle", "error"].includes(state.voicePhase);
  const voiceLabel = state.voiceChecking ? t("composer.voice_checking") : state.voiceAvailable ? t("pet.voice") : t("composer.voice_configure_hint");
  const editing = panel === "input" || (panel === "tasks" && visibleTasks.some((task) => task.key === editor)) || voiceActive;
  const controlsVisible = tools || panel !== null;
  const baseAction = selectPetBaseAction(state, editing);
  const taskKey = (key: string) => key === "__quick__" ? interaction.target?.key ?? key : interaction.targets[key]?.key ?? key;
  const busy = (key: string) => Boolean(pending[key]) || Boolean(state.submitting?.includes(taskKey(key)));
  const uncertain = (key: string) => interaction.uncertain?.[taskKey(key)] === true;

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const apply = (snapshot: PetSnapshot) => {
      if (!active) return;
      setLocale(snapshot.locale); document.documentElement.dataset.theme = snapshot.theme;
      if (initialized.current && contextKey.current !== snapshot.contextKey) {
        composing.current = null;
        inputRequest.current++; targetRequest.current = null;
        setPanel(null); setTaskPanelPresent(false); setEditor(null); setInputOptions(false); setSessions([]); setSessionsPartial(false); setQuickKey("__quick__"); updateMessage(""); setPending({}); lastTranscript.current = 0;
      }
      // TIPS: 本地编辑即时写入主进程；回执快照只应用到页面，不能再回写而形成IPC循环。
      const incoming = snapshot.interaction ?? EMPTY_INTERACTION;
      const activeComposition = composing.current;
      interactionRef.current = activeComposition && contextKey.current === snapshot.contextKey
        ? { ...incoming, drafts: { ...incoming.drafts, [activeComposition.key]: interactionRef.current.drafts[activeComposition.key] ?? "" } }
        : incoming;
      setInteraction(interactionRef.current);
      contextKey.current = snapshot.contextKey; setState(snapshot);
    };
    const release = bridge.onState(apply);
    void bridge.getState().then((snapshot) => {
      if (!active) return;
      apply(snapshot); initialized.current = true;
    });
    return () => { active = false; release(); };
  }, []);
  useEffect(() => {
    if (panel === "tasks") { setTaskPanelPresent(true); return; }
    setCardHover(false);
    if (panel === "input" || matchMedia("(prefers-reduced-motion: reduce)").matches) { setTaskPanelPresent(false); return; }
    // TIPS: 淡出完成后再卸载，避免原生窗口先缩小而裁掉动画；重新打开会取消旧清理。
    const timer = setTimeout(() => setTaskPanelPresent(false), 200);
    return () => clearTimeout(timer);
  }, [panel]);
  useEffect(() => {
    if (!state.voiceText) return;
    try {
      const value = JSON.parse(state.voiceText) as { text: string; id: number };
      if (value.id <= lastTranscript.current) return;
      lastTranscript.current = value.id;
      remember((current) => ({ ...current, drafts: { ...current.drafts, __quick__: [current.drafts.__quick__, value.text].filter(Boolean).join("\n") } }));
      setQuickKey("__quick__"); setPanel("input");
    } catch { /* 宿主重载期间忽略未完成快照。 */ }
  }, [state.voiceText]);
  useEffect(() => {
    const images = (["typing", "seated-working", "celebrate", "waiting"] as const).map((action) => {
      const image = new Image(); image.onerror = () => setFailedActions((values) => [...values, action]);
      image.src = petImageUrl(action); return image;
    });
    return () => images.forEach((image) => { image.onerror = null; });
  }, []);
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const player = createPetAnimator((action, index) => setFrame({ action, index }), query.matches);
    animator.current = player;
    const change = () => player.setReduced(query.matches);
    const sleep = () => player.setPaused(document.hidden);
    query.addEventListener("change", change); document.addEventListener("visibilitychange", sleep);
    return () => { player.dispose(); query.removeEventListener("change", change); document.removeEventListener("visibilitychange", sleep); clearTimeout(leaveTimer.current); clearTimeout(hoverTimer.current); clearTimeout(messageTimer.current); };
  }, []);
  useEffect(() => {
    animator.current?.setBase(baseAction);
    if (state.ready) void bridge?.action({ type: "editing", active: editing }).catch(() => {});
  }, [baseAction, editing, state.ready]);
  useEffect(() => {
    return bridge?.onFocus(() => {
      setTools(true);
      setFocusRequest((value) => value + 1);
    });
  }, []);
  useLayoutEffect(() => {
    // TIPS: 工具条首次显示要等React提交DOM，再把键盘焦点交给第一个按钮。
    if (focusRequest) root.current?.querySelector<HTMLElement>(".pet-composer textarea, .pet-tools button")?.focus();
  }, [focusRequest]);
  useEffect(() => {
    const blur = () => {
      bridge?.keyboard(false);
      // TIPS: 只在快捷输入失焦时一起收回气泡；按钮主动归还焦点不应短暂缩小操作栏。
      if (!voiceActive && panel === "input") {
        void cancelVoice();
        clearTimeout(hoverTimer.current); clearTimeout(leaveTimer.current);
        setTools(false); setPanel(null);
      }
      setEditor(null);
      setInputOptions(false);
    };
    window.addEventListener("blur", blur);
    return () => window.removeEventListener("blur", blur);
  }, [voiceActive, panel, pending.__voice__]);
  usePetPlacement(root, bridge, hitRegions, panel, controlsVisible);

  useLayoutEffect(() => {
    // TIPS: 单行时保持参考图的胶囊高度；多行只增长输入区，避免原生textarea拖拽柄和蓝色矩形边框。
    root.current?.querySelectorAll<HTMLTextAreaElement>("textarea").forEach((field) => {
      field.style.height = "24px";
      const height = field.scrollHeight;
      field.style.height = `${Math.min(96, Math.max(24, height))}px`;
      field.style.overflowY = height > 96 ? "auto" : "hidden";
    });
  }, [interaction.drafts, panel, editor]);
  useLayoutEffect(() => {
    // TIPS: 关闭或切换编辑入口即失效待启动的听写，延迟目标回执不能重新请求麦克风。
    if (panel !== "input" || quickKey !== "__quick__") inputRequest.current++;
    const request = ++editorFocusRequest.current;
    const field = panel === "input" ? root.current?.querySelector<HTMLTextAreaElement>(".pet-composer textarea")
      : editor ? root.current?.querySelector<HTMLTextAreaElement>(".pet-card textarea") : null;
    editorFocusPending.current = Boolean(field && bridge);
    if (field && bridge) {
      // TIPS: 被动悬浮窗最初不可聚焦；先让原生窗口接收键盘，再聚焦textarea，避免IME首键落成字母。
      void bridge.focusEditor().then(() => {
        if (request === editorFocusRequest.current && field.isConnected && document.activeElement !== field) field.focus();
      }).catch(() => {}).finally(() => { if (request === editorFocusRequest.current) editorFocusPending.current = false; });
    }
  }, [panel, editor, quickKey]);

  useEffect(() => {
    // TIPS: 已读和关闭只移除展示，宿主仍保留任务事实；隐藏卡片不能继续占用编辑状态或自动打开输入。
    if (!editor || visibleTasks.some((task) => task.key === editor)) return;
    bridge?.keyboard(false);
    setEditor(null);
  }, [editor, visibleTasks]);
  const updateDraft = (key: string, value: string, draftTarget?: PetTarget) => remember((current) => ({
    ...current, drafts: { ...current.drafts, [key]: value },
    targets: draftTarget ? { ...current.targets, [key]: draftTarget } : current.targets,
  }), composing.current?.key === key && (!draftTarget || interactionRef.current.targets[key]?.key === draftTarget.key));
  const finishComposition = (key: string, field: HTMLTextAreaElement, draftTarget?: PetTarget) => {
    if (composing.current?.key !== key) return;
    composing.current = null;
    updateDraft(key, field.value, draftTarget);
  };
  const restorePassive = () => {
    requestAnimationFrame(() => {
      if (editorFocusPending.current) return;
      const editing = document.hasFocus() && root.current?.contains(document.activeElement);
      if (!editing) bridge?.keyboard(false);
    });
  };
  const run = async (key: string, action: PetAction) => {
    if (!bridge || busy(key)) return;
    const requestContext = contextKey.current;
    const requestEditor = editorState.current;
    setPending((value) => ({ ...value, [key]: true })); updateMessage("");
    try {
      const result = await bridge.action(action);
      if (contextKey.current !== requestContext) return;
      if (result.delivery) {
        updateMessage(result.delivery === "queued" ? t("pet.queued") : "", true);
        // TIPS: 回执只关闭原提交编辑区，不能打断用户已切换到的另一张卡片或快捷输入。
        if (result.draftCleared && editorState.current.panel === requestEditor.panel && editorState.current.key === key) {
          if (requestEditor.panel === "input") setPanel(null); else setEditor(null);
          restorePassive();
        }
      }
      return result;
    } catch (error) {
      if (contextKey.current !== requestContext) return;
      const text = error instanceof Error ? error.message : t("pet.unavailable");
      updateMessage(text, action.type === "send");
    }
    finally { if (contextKey.current === requestContext) setPending((value) => ({ ...value, [key]: false })); }
  };
  const cancelVoice = () => {
    inputRequest.current++;
    if (targetRequest.current) updateMessage("");
    // 启动请求可能仍在等待权限或连接，取消使用独立入口，不被启动中的busy保护拦截。
    if (voiceActive || busy("__voice__")) return run("__voice_cancel__", { type: "voice-cancel" });
  };
  const openInput = async (voice = false) => {
    const request = ++inputRequest.current;
    if (voiceActive || busy("__voice__")) await run("__voice_cancel__", { type: "voice-cancel" });
    if (request !== inputRequest.current) return;
    setQuickKey("__quick__"); setPanel("input"); setEditor(null); setInputOptions(false); setTools(true);
    let destination = interaction.target;
    if (!interaction.drafts.__quick__ || !destination) {
      // TIPS: 清除上次目标后才解析新目标，允许输入但不能向旧会话提前发送。
      remember((value) => ({ ...value, target: null }));
      updateMessage(t("pet.target_loading"));
      // 取消后立即重新打开可共用尚未结束的目标读取，只有当前输入请求能消费回执。
      const loading = targetRequest.current ?? run("__target__", { type: "latest" });
      targetRequest.current = loading;
      const result = await loading;
      if (targetRequest.current === loading) targetRequest.current = null;
      if (!result || request !== inputRequest.current) return;
      destination = result?.target ?? null;
      remember((value) => ({ ...value, target: destination }));
      updateMessage(result.partial ? t("pet.partial") : destination ? "" : t("pet.no_target"));
    }
    // TIPS: 恢复已有草稿时React尚未提交输入区；请求编号已覆盖关闭/切换取消，不能用上一帧的编辑状态拦截启动。
    if (destination && voice && request === inputRequest.current) await run("__voice__", { type: "voice-start", target: destination });
  };
  const submitQuick = () => { if (target && quickDraft.trim() && !busy("__target__") && !voiceActive && !uncertain(quickKey)) void run(quickKey, { type: "send", target, text: quickDraft, draftKey: quickKey }); };
  const toggleSessions = async () => {
    if (inputOptions) { setInputOptions(false); return; }
    setInputOptions(true); setSessions([]); setSessionsPartial(false);
    const result = await run("__sessions__", { type: "sessions" });
    if (result) { setSessions(result.targets ?? []); setSessionsPartial(result.partial === true); }
  };
  const selectSession = (destination: PetTarget) => {
    void cancelVoice();
    // TIPS: 只在用户明确选择时改发，保留当前草稿；后续会话排序更新不会覆盖此目标。
    remember((value) => ({ ...value, target: quickKey === "__quick__" ? destination : value.target, targets: { ...value.targets, [quickKey]: destination } }));
    setInputOptions(false); updateMessage("");
    root.current?.querySelector<HTMLTextAreaElement>(".pet-composer textarea")?.focus();
  };
  const dismiss = (task: PetTask) => {
    remember((value) => ({ ...value, dismissed: { ...value.dismissed, [task.key]: task.turnKey } }));
    if (editor === task.key) { setEditor(null); restorePassive(); }
    if (panel === "tasks" && visibleTasks.length === 1) {
      setPanel(null);
      setTasksExpanded(false);
    }
  };
  const openTask = async (task: PetTask) => {
    const requestContext = contextKey.current;
    const result = await run(`open:${task.key}`, { type: "open", key: task.key });
    // TIPS: 成功打开完成项才标记该轮已读；执行中项、打开失败及新轮次都不能被顺带移除。
    if (result !== undefined && contextKey.current === requestContext && task.state === "completed") {
      remember((value) => ({ ...value, read: { ...value.read, [task.key]: task.turnKey } }));
    }
  };
  const submitCard = (task: PetTask) => {
    const text = interaction.drafts[task.key] ?? "";
    if (!state.ready || busy(task.key) || task.state === "reconciling" || task.preparing || task.stopping || uncertain(task.key) || !text.trim()) return;
    void run(task.key, { type: "send", target: task, text, draftKey: task.key });
  };
  const keySubmit = (event: React.KeyboardEvent<HTMLTextAreaElement>, submit: () => void) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.nativeEvent.keyCode !== 229) { event.preventDefault(); submit(); }
  };
  if (!editor && !cardHover) taskOrder.current = state.tasks.map((task) => task.key);
  const orderedTasks = [...visibleTasks].sort((a,b) => {
    const aIndex = taskOrder.current.indexOf(a.key), bIndex = taskOrder.current.indexOf(b.key);
    return (aIndex < 0 ? 1e6 : aIndex) - (bIndex < 0 ? 1e6 : bIndex);
  });
  const taskCount = visibleTasks.length;
  // TIPS: 最后一条提醒移除后仍保留当前面板的关闭箭头；收起后没有提醒就不占用铃铛位置。
  const showTaskControl = taskCount > 0 || panel === "tasks";
  const hasUnreadCompletion = visibleTasks.some((task) => task.state === "completed");
  const hiddenCount = unreadTasks.length - visibleTasks.length;
  const restoreDismissed = () => remember((value) => ({ ...value, dismissed: {} }));
  const drafts = Object.entries(interaction.drafts).filter(([key, text]) => key !== "__quick__" && text.trim() && !visibleTasks.some((task) => task.key === key));
  // TIPS: 草稿恢复独立于提醒数量；最后一张卡片消失后，仍可从编辑入口找回原任务的文字。
  const draftEntries = drafts.length ? <div className="pet-drafts"><span>{t("pet.drafts")}</span>{drafts.map(([key]) => <button key={key} disabled={voiceActive} title={interaction.targets[key] ? `${interaction.targets[key].project} · ${interaction.targets[key].title}` : key} onClick={() => {
    if (!interaction.targets[key]) return;
    setQuickKey(key); setPanel("input"); setEditor(null); setInputOptions(false); setTools(true); updateMessage("");
  }}>{interaction.targets[key]?.title ?? key}</button>)}</div> : null;

  // TIPS: 在实际按下的按钮上捕获指针，短按仍是原按钮点击，超过阈值才开始拖动并吞掉随后click。
  const dragEvents = {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => { if (event.button !== 0) return; event.stopPropagation(); ((event.target as Element).closest("button") ?? event.currentTarget).setPointerCapture(event.pointerId); dragged.current = false; drag.current = { x: event.screenX, y: event.screenY, active: false }; },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => { const moving = drag.current; if (!moving || moving.active || Math.hypot(event.screenX - moving.x, event.screenY - moving.y) < 5) return; moving.active = true; dragged.current = true; animator.current?.cancel(); bridge?.drag(true); },
    onPointerUp: () => { if (drag.current?.active) bridge?.drag(false); drag.current = null; },
    onLostPointerCapture: () => { if (drag.current?.active) bridge?.drag(false); drag.current = null; },
  };

  return <div ref={root} className="pet-root" style={{ "--pet-width": `${PET_WIDTH}px`, "--pet-height": `${PET_HEIGHT}px` } as React.CSSProperties} onPointerEnter={() => clearTimeout(leaveTimer.current)} onPointerLeave={() => {
    leaveTimer.current = setTimeout(() => { if (!panel && !(document.hasFocus() && root.current?.contains(document.activeElement))) setTools(false); }, 500);
  }} onFocusCapture={() => setTools(true)} onBlurCapture={restorePassive} onKeyDown={(event) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    if (inputOptions) { setInputOptions(false); root.current?.querySelector<HTMLTextAreaElement>(".pet-composer textarea")?.focus(); return; }
    void cancelVoice();
    if (editor) setEditor(null); else setPanel(null);
    (document.activeElement as HTMLElement)?.blur(); bridge?.keyboard(false);
  }}>
    <div className="pet-panels">
    {panel === "tasks" || (taskPanelPresent && panel === null) ? <section className="pet-task-panel" data-visible={panel === "tasks"} data-pet-hit={panel === "tasks" ? true : undefined} inert={panel !== "tasks"} aria-hidden={panel !== "tasks"} data-folded={!tasksExpanded} onPointerEnter={() => setCardHover(true)} onPointerLeave={() => setCardHover(false)} onTransitionEnd={(event) => { if (event.target === event.currentTarget && event.propertyName === "opacity" && panel !== "tasks") setTaskPanelPresent(false); }} aria-label={t("pet.tasks")}>
      {state.syncing ? <p className="pet-note">{t("pet.syncing")}</p> : null}
      {state.partial ? <p className="pet-note">{t("pet.partial")}</p> : null}
      <div className="pet-cards">
        {(tasksExpanded ? orderedTasks : orderedTasks.slice(0, 1)).map((task) => <div key={task.key} className="pet-card-shell" data-stack-size={!tasksExpanded ? visibleTasks.length : undefined} style={{ "--pet-stack-depth": tasksExpanded ? 0 : visibleTasks.length - 1 } as React.CSSProperties} onClick={!tasksExpanded ? () => setTasksExpanded(true) : undefined}>
          {!tasksExpanded ? orderedTasks.slice(1).map((behind, index) => <span key={behind.key} className="pet-stack-layer" aria-hidden="true" style={{ "--pet-stack-level": index + 1, "--pet-stack-inset": `${Math.min((index + 1) * 8, 56)}px` } as React.CSSProperties} />) : null}
          <article className="pet-card" data-editing={editor === task.key} data-state={task.state}>
          {tasksExpanded ? <button className="pet-close pet-icon" data-pet-hit={panel === "tasks" ? true : undefined} aria-label={t("pet.close_card")} onClick={() => dismiss(task)}><X size={14} strokeWidth={2.2} /></button> : null}
          <div className="pet-card-head">
            <button className="pet-title" aria-label={!tasksExpanded ? t("pet.expand") : undefined} title={`${task.project} · ${task.title}\n${task.statusText}${task.progressText ? `\n${task.progressText}` : ""}`} onClick={() => tasksExpanded ? void openTask(task) : setTasksExpanded(true)}>
              <strong>{task.state === "completed" ? <i className="pet-completed" aria-label={t("pet.completed")}><Check size={10} strokeWidth={3} /></i> : task.state === "resumable" && task.stopped ? <i className="pet-stopped" aria-label={t("pet.stopped")} /> : null}{task.title}</strong>
              <span>{task.stopping ? t("pet.stopping") : task.preparing ? t("pet.sending") : task.progressText || task.statusText}</span>
            </button>
            {tasksExpanded ? <div className="pet-card-actions">
            <button className="pet-icon" aria-label={t("pet.follow_up")} aria-pressed={editor === task.key} disabled={!state.ready} onClick={() => {
              void cancelVoice();
              setPanel("tasks"); setEditor(editor === task.key ? null : task.key); if (editor === task.key) { (document.activeElement as HTMLElement)?.blur(); restorePassive(); }
            }}><CornerDownLeft size={20} /></button>
            {task.canStop ? <button className="pet-icon pet-stop" aria-label={t("pet.stop")} disabled={busy(task.key) || task.stopping} onClick={() => void run(task.key, { type: "stop", key: task.key })}><Square size={14} fill="currentColor" strokeWidth={0} /></button> : null}
            </div> : null}
          </div>
          {tasksExpanded && editor === task.key ? <div className="pet-follow">
            <textarea aria-label={`${t("pet.follow_up")} · ${task.title}`} placeholder={t("pet.follow_up")} value={interaction.drafts[task.key] ?? ""}
              onCompositionStart={() => { composing.current = { key: task.key, persistedDraft: interactionRef.current.drafts[task.key] ?? "" }; }} onCompositionEnd={(event) => finishComposition(task.key, event.currentTarget, task)}
              onBlur={(event) => finishComposition(task.key, event.currentTarget, task)}
              onChange={(event) => updateDraft(task.key, event.target.value, task)} onKeyDown={(event) => keySubmit(event, () => submitCard(task))} />
            <button className="pet-send" aria-label={t("pet.send")} disabled={!interaction.drafts[task.key]?.trim() || busy(task.key) || uncertain(task.key) || task.state === "reconciling"} onClick={() => submitCard(task)}><ArrowUp size={18} /></button>
          </div> : null}
          </article>
        </div>)}
      </div>
      {hiddenCount ? <button className="pet-restore" onClick={restoreDismissed}>{t("pet.dismissed", { count: hiddenCount })} · {t("pet.restore")}</button> : null}
      {draftEntries}
    </section> : null}
    {panel === "input" && inputOptions ? <section className="pet-input-options" id="pet-input-options" data-pet-hit aria-label={t("pet.input_options")} aria-busy={busy("__sessions__")}>
      <p className="pet-note">{t("pet.input_options")}</p>
      {busy("__sessions__") ? <p className="pet-note" role="status">{t("pet.sessions_loading")}</p> : <>
        {sessionsPartial ? <p className="pet-note">{t("pet.partial")}</p> : null}
        {sessions.length ? <ul className="pet-session-list">{sessions.map((session) => <li key={session.key}>
          <button className="pet-session-option" disabled={voiceActive || busy(quickKey)} aria-pressed={target?.key === session.key} title={`${session.project} · ${session.title}`} onClick={() => selectSession(session)}>
            <MessageSquare className="pet-session-icon" size={16} strokeWidth={1.7} aria-hidden="true" />
            <span><strong>{session.title}</strong><small>{session.project}</small></span>
            {target?.key === session.key ? <Check size={16} aria-hidden="true" /> : null}
          </button>
        </li>)}</ul> : <>
          <p className="pet-note">{t("pet.sessions_empty")}</p>
          <button className="pet-retarget" onClick={() => void run("__open__", { type: "open-app" })}>{t("pet.open_app")}</button>
        </>}
      </>}
    </section> : null}
    {panel === "input" ? <section className="pet-quick" data-pet-hit>
      <div className="pet-target-row">
      <button className="pet-target" disabled={!target} title={target ? `${target.project} · ${target.title}` : undefined} onClick={() => target && void run("__open__", { type: "open-target", target })}>{target ? t("pet.target", { project: target.project, title: target.title }) : t(busy("__target__") ? "pet.target_loading" : "pet.no_target")}</button>
      </div>
      {!target && !busy("__target__") && !inputOptions ? <button className="pet-retarget" onClick={() => void run("__open__", { type: "open-app" })}>{t("pet.open_app")}</button> : null}
      <div className="pet-composer">
        <button className="pet-input-plus" aria-label={t("pet.input_options")} title={t("pet.input_options")} aria-expanded={inputOptions} aria-controls="pet-input-options" disabled={quickKey !== "__quick__" || voiceActive || busy(quickKey) || busy("__target__")} onClick={() => void toggleSessions()}><Plus size={18} strokeWidth={1.6} /></button>
        <textarea aria-label={t("pet.input")} placeholder={t("pet.placeholder")} value={quickDraft}
          onCompositionStart={() => { composing.current = { key: quickKey, persistedDraft: interactionRef.current.drafts[quickKey] ?? "" }; }} onCompositionEnd={(event) => finishComposition(quickKey, event.currentTarget, target ?? undefined)}
          onBlur={(event) => finishComposition(quickKey, event.currentTarget, target ?? undefined)}
          onChange={(event) => updateDraft(quickKey, event.target.value, target ?? undefined)} onKeyDown={(event) => keySubmit(event, submitQuick)} />
        <button className="pet-send" aria-label={t("pet.send")} disabled={!target || !quickDraft.trim() || busy("__target__") || busy(quickKey) || uncertain(quickKey) || voiceActive} onClick={submitQuick}><ArrowUp size={18} strokeWidth={1.6} /></button>
      </div>
      {voiceActive ? <div className="pet-voice"><span>{state.voicePhase === "transcribing" ? t("pet.voice_transcribing") : t("pet.voice")}</span><button onClick={() => void run("__voice_stop__", { type: "voice-stop" })}>{t("pet.voice_stop")}</button><button onClick={() => void cancelVoice()}>{t("pet.voice_cancel")}</button></div> : null}
      {hiddenCount ? <button className="pet-restore" onClick={restoreDismissed}>{t("pet.dismissed", { count: hiddenCount })} · {t("pet.restore")}</button> : null}
      {draftEntries}
    </section> : null}
    {Object.entries(interaction.uncertain ?? {}).some(([,value]) => value) ? <div className="pet-message" data-pet-hit>{t("pet.uncertain")}
      {Object.entries(interaction.uncertain ?? {}).filter(([,value]) => value).map(([key]) => <button key={key} onClick={() => void run(`confirm:${key}`, { type: "confirm-send", key })}>{interaction.targets[key]?.title ?? interaction.target?.title} · {t("pet.checked_retry")}</button>)}
    </div> : null}
    {message || state.voiceError ? <p className="pet-message" data-pet-hit role="status">{message || state.voiceError}</p> : null}
    </div>
    <button ref={character} {...dragEvents} className="pet-character" style={{ clipPath: `path("${contour}")` }} aria-label={t("pet.character")}
      onPointerEnter={() => { if (drag.current?.active) return; animator.current?.enter(); hoverTimer.current = setTimeout(() => setTools(true), 300); }}
      onPointerLeave={() => { clearTimeout(hoverTimer.current); animator.current?.leave(); }}
      onClick={(event) => { if (event.detail > 0 && dragged.current) { dragged.current = false; return; } setTools(true); void run("__activate__", { type: "activate-app" }); }}>
      <span className="pet-sprite" style={{ backgroundImage: `url(${petImageUrl(failedActions.includes(frame.action) ? "fallback" : frame.action)})`, backgroundSize: `${(failedActions.includes(frame.action) ? 1 : PET_FRAME_DURATIONS[frame.action].length) * PET_WIDTH}px ${PET_HEIGHT}px`, backgroundPosition: `${failedActions.includes(frame.action) ? 0 : -frame.index * PET_WIDTH}px 0` }} />
    </button>
    {panel !== "input" ? <div className="pet-controls" {...dragEvents} onClickCapture={(event) => { if (event.detail > 0 && dragged.current) { event.preventDefault(); event.stopPropagation(); dragged.current = false; } }} data-expanded={controlsVisible} data-completed={hasUnreadCompletion} data-has-tasks={showTaskControl}>
    {/* TIPS: 大小气泡共用一个连续变形的表面，固定占位保护人物锚点；图标退出焦点及命中后再缩回小气泡。 */}
    <div className="pet-control-surface" aria-hidden="true" />
    <button className="pet-bubble" {...dragEvents} data-visible={!controlsVisible} data-completed={hasUnreadCompletion} data-pet-hit={!controlsVisible ? true : undefined} inert={controlsVisible} aria-hidden={controlsVisible} aria-label={hasUnreadCompletion ? `${t("pet.completed")} · ${t("pet.show_controls")}` : t("pet.show_controls")} onPointerEnter={() => setTools(true)} onClick={(event) => { if (event.detail > 0 && dragged.current) { dragged.current = false; return; } setTools(true); }} />
    <nav className="pet-tools" data-visible={controlsVisible} data-pet-hit={controlsVisible ? true : undefined} inert={!controlsVisible} aria-hidden={!controlsVisible}>
      <button aria-label={t("pet.input")} disabled={!state.ready} onClick={() => void openInput()}><PetComposeIcon /></button>
      <i /><button aria-label={t("pet.voice")} disabled={!state.ready || !state.voiceAvailable || busy("__voice__")} title={voiceLabel} onClick={() => voiceActive ? void run("__voice__", { type: "voice-stop" }) : void openInput(true)}><PetVoiceIcon /></button>
      {showTaskControl ? <><i /><button aria-label={t(panel === "tasks" ? "pet.collapse" : "pet.tasks")} aria-expanded={panel === "tasks"} onClick={() => { void cancelVoice(); if (panel === "tasks") setPanel(null); else { setTasksExpanded(false); setPanel("tasks"); } setEditor(null); (document.activeElement as HTMLElement)?.blur(); restorePassive(); }}>
        {panel === "tasks" ? <ChevronUp size={20} strokeWidth={1.8} /> : <Bell size={20} strokeWidth={1.8} />}{panel !== "tasks" && taskCount ? <b className="pet-badge">{taskCount > 99 ? "99+" : taskCount}</b> : null}
      </button></> : null}
    </nav>
    </div> : null}
  </div>;
}

createRoot(document.getElementById("root")!).render(<PetApp />);
