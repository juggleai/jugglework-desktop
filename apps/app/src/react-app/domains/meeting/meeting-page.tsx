import { focusMeetingWindow } from "@/app/lib/desktop";
import { Temporal } from "@js-temporal/polyfill";
import { MeetingPermissionNotice, MeetingPermissionRestart, MeetingPermissionSetup } from "./permission-notice";
import { meetingDeviceError } from "./media-permission";
import { startPrejoinPreview } from "./prejoin-preview";
import { MeetingUserSettings, useMeetingUserPreferences } from "./meeting-user-settings";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { AppInsetSurface } from "@/react-app/shell/app-inset-surface";
import { AppSecondarySidebarResizeHandle } from "@/react-app/shell/app-secondary-sidebar-resize-handle";
import { ListPanelHeader } from "@/react-app/shell/list-panel-header";
import { appInsetSidebarCssWidth, useWorkspaceShellLayout } from "@/react-app/shell/workspace-shell-layout";
import { useDenAuth } from "../cloud/den-auth-provider";
import { useCloudSession } from "../settings/cloud/cloud-session-provider";
import { useJuggleChatStore } from "../jugglechat/store";
import { CalendarEventCreateDialog } from "../calendar/calendar-event-create-dialog";
import { resolveCalendarPageGate } from "../calendar/calendar-page-gate";
import { useCalendarBootstrapQuery, useCalendarOrganizationMembersQuery, useCalendarSchedulingEventsQuery } from "../calendar/calendar-queries";
import { meetingAPI } from "./api";
import { calendarMeetingOccurrences, meetingOverviewLists, meetingOverviewWindow, type CalendarMeetingOccurrence, type MeetingHistoryEntry } from "./meeting-overview";
import { isMeetingRequestScopeCurrent, useMeetingRequestScope } from "./meeting-request-scope";
import { meetingReadinessReason } from "./readiness";
import {
  meetingClosed,
  meetingStatusLabel,
  type Meeting,
  type MeetingCreate,
  type MeetingReadiness,
} from "./types";
import { MeetingIcon as Icon } from "./meeting-icons";
import { MeetingMemberAvatar } from "./meeting-invite-picker";
import { MeetingCode } from "./meeting-code";
import { CalendarPrejoinDialog } from "./calendar-prejoin-dialog";
import { useMeetingStore } from "./store";
import { useMeetingOverview } from "./use-meeting-overview";
import "./meeting.css";
const stamp = (date: string) =>
  new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const dateStamp = (date: string) =>
  new Date(date).toLocaleDateString([], { month: "numeric", day: "numeric", weekday: "short" });
const localDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const inputDate = (date: Date) =>
  `${localDate(date)}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
export function MeetingDialog({
  title,
  children,
  onClose,
  ownerDocument = document,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  ownerDocument?: Document;
  className?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = ownerDocument.activeElement as HTMLElement | null;
    (ref.current?.querySelector<HTMLElement>("[data-meeting-initial-focus]")
      || ref.current?.querySelector<HTMLElement>("input:not([disabled]),textarea:not([disabled])")
      || ref.current?.querySelector<HTMLElement>("button:not([disabled])"))?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (!e.repeat) closeRef.current(); }
      if (e.key === "Tab") {
        const list = [
          ...ref.current!.querySelectorAll<HTMLElement>(
             "button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex='0']",
          ),
        ].filter(node => node.tabIndex >= 0 && !node.closest("[hidden]"));
        if (e.shiftKey && ownerDocument.activeElement === list[0]) {
          e.preventDefault();
          list.at(-1)?.focus();
        } else if (!e.shiftKey && ownerDocument.activeElement === list.at(-1)) {
          e.preventDefault();
          list[0]?.focus();
        }
      }
    };
    ownerDocument.addEventListener("keydown", key);
    return () => {
      ownerDocument.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [ownerDocument]);
  return createPortal(
    <div className="meeting-dialog-backdrop">
      <section
        className={`meeting-ui ${className}`}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="row between modal-head">
          <h2>{title}</h2>
          <button
            className="ghost icon-button"
            aria-label="关闭"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        {children}
      </section>
    </div>,
    ownerDocument.body,
  );
}
export function MeetingPage({ active }: { active: boolean }) {
  const scope = useMeetingRequestScope();
  if (scope) return <ScopedMeetingPage key={scope} active={active} scope={scope} />;
  if (!active) return null;
  return (
    <div className="meeting-ui meeting-page">
      <AppInsetSurface className="meeting-inset-surface" testId="meeting-inset-surface">
        <div className="notice" role="status">请切换到已登录的团队组织使用视频会议。</div>
      </AppInsetSurface>
    </div>
  );
}

function ScopedMeetingPage({ active, scope }: { active: boolean; scope: string }) {
  const navigate = useNavigate();
  const { leftSidebarResizing, leftSidebarWidth, startLeftSidebarResize } = useWorkspaceShellLayout({
    expandedRightWidth: 520,
  });
  const pageStyle = {
    "--jugglework-left-sidebar-width": appInsetSidebarCssWidth(leftSidebarWidth),
  } as CSSProperties;
  const { user } = useDenAuth();
  const cloud = useCloudSession();
  const contacts = useJuggleChatStore((s) => s.contacts);
  const imUser = useJuggleChatStore((s) => s.user);
  const displayName = imUser?.id === user?.id ? imUser?.name || user?.name : user?.name;
  const [cancelTarget, setCancelTarget] = useState<Meeting | null>(null);
  const [editing, setEditing] = useState(false);
  const [actionError, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [calendarScheduleOpen, setCalendarScheduleOpen] = useState(false);
  const [dialog, setDialog] = useState<"schedule" | "join" | "settings" | null>(
    null,
  );
  const [detail, setDetail] = useState<Meeting | null>(null);
  const [preview, setPreview] = useState<Meeting | null>(null);
  const openPreview = (meeting: Meeting) => {
    if (useMeetingStore.getState().meeting?.id === meeting.id) {
      void focusMeetingWindow("meeting").catch((e) => setError(e.message));
      return;
    }
    setPreview(meeting);
  };
  const [source, setSource] = useState<{
    sourceKind: Meeting["sourceKind"];
    sourceId: string;
    title: string;
  } | null>(null);
  const requestKey = useRef(crypto.randomUUID());
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayKey = localDate(new Date());
  const overviewWindow = useMemo(
    () => meetingOverviewWindow(Temporal.Now.instant(), timeZone),
    [timeZone, todayKey],
  );
  const { items, readiness, loading, error: overviewError, refresh } = useMeetingOverview({
    active, scope, from: overviewWindow.from, to: overviewWindow.to,
  });
  const error = actionError || overviewError;
  const { activeOrganization: calendarOrganization, baseUrl, isSignedIn } = cloud;
  const calendarGate = useMemo(() => resolveCalendarPageGate({
    activeOrganization: calendarOrganization, baseUrl, isSignedIn,
  }), [calendarOrganization, baseUrl, isSignedIn]);
  const calendarScope = calendarGate.kind === "ready" ? calendarGate.scope : null;
  const calendarBootstrap = useCalendarBootstrapQuery({
    client: cloud.client,
    scope: calendarScope,
    range: overviewWindow.calendarRange,
    active: active && calendarScope !== null,
  });
  const calendarScheduling = useCalendarSchedulingEventsQuery({
    client: cloud.client,
    scope: calendarScope,
    range: overviewWindow.schedulingRange,
    active: active && calendarScope !== null,
  });
  const calendarMembers = useCalendarOrganizationMembersQuery({
    client: cloud.client,
    scope: calendarScope,
    active: active && calendarScope !== null,
  });
  const calendarMembersById = useMemo(
    () => new Map((calendarMembers.data ?? []).map((member) => [member.id, member])),
    [calendarMembers.data],
  );
  useEffect(() => {
    if (!active || !calendarScope) return;
    const update = () => {
      if (!isMeetingRequestScopeCurrent(scope)) return;
      void calendarBootstrap.refetch();
      void calendarScheduling.refetch();
      void calendarMembers.refetch();
    };
    window.addEventListener("meeting:changed", update);
    window.addEventListener("focus", update);
    const timer = window.setInterval(update, 30000);
    return () => {
      window.removeEventListener("meeting:changed", update);
      window.removeEventListener("focus", update);
      clearInterval(timer);
    };
  }, [active, calendarBootstrap.refetch, calendarMembers.refetch, calendarScheduling.refetch, calendarScope, scope]);
  useEffect(() => {
    const open = (event: Event) => {
      // Chat and reminders dispatch this as they navigate to Meetings.
      if (!isMeetingRequestScopeCurrent(scope)) return;
      const d = (event as CustomEvent).detail;
      if (d?.meetingId) {
        void meetingAPI
          .get(d.meetingId)
          .then((v) => { if (isMeetingRequestScopeCurrent(scope)) openPreview(v.meeting); })
          .catch((e) => setError(e.message));
      } else if (d?.sourceId) {
        setSource(d);
        setDialog("schedule");
        requestKey.current = crypto.randomUUID();
      }
    };
    window.addEventListener("meeting:open", open);
    return () => window.removeEventListener("meeting:open", open);
  }, [scope]);
  async function run(fn: () => Promise<void>) {
    if (busy || !isMeetingRequestScopeCurrent(scope)) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  const close = useCallback(() => {
    setDialog(null);
    setDetail(null);
    setEditing(false);
    setPreview(null);
    setSource(null);
  }, []);
  const calendarOccurrences = calendarMeetingOccurrences(
    calendarBootstrap.data?.events ?? [],
    calendarScheduling.data?.items ?? [],
    timeZone,
  );
  const { upcoming: upcomingForHome, history: historyForHome } = meetingOverviewLists(items, calendarOccurrences, Date.now());
  const calendarLoading = calendarScope !== null && (calendarBootstrap.isLoading || calendarScheduling.isLoading);
  const calendarError = calendarScope !== null && (calendarBootstrap.isError || calendarScheduling.isError || calendarMembers.isError);
  const calendarStartUnavailable = calendarError || calendarMembers.isLoading;
  async function create(input: MeetingCreate) {
    const { meeting } = await meetingAPI.create(input, requestKey.current);
    requestKey.current = crypto.randomUUID();
    setDialog(null);
    setSource(null);
    if (input.immediate) openPreview(meeting);
    else setDetail(meeting);
    try {
      await meetingAPI.notify(meeting.id);
    } catch {
      setError(
        "会议已创建，邀请消息尚未送达。可在详情中点击「重新发送邀请」。",
      );
    }
  }
  function openSchedule() {
    setCalendarScheduleOpen(true);
  }
  async function startCalendarOccurrence(occurrence: CalendarMeetingOccurrence) {
    if (!calendarScope) throw new Error("日历会议暂不可用");
    const missing = occurrence.attendeeMemberIds.filter((memberId) => !calendarMembersById.has(memberId));
    if (missing.length > 0) throw new Error("部分日程参与人暂不可用，无法发起会议");
    const organizerUserId = calendarMembersById.get(calendarScope.memberId)?.userId;
    const invitees = [...new Set(occurrence.attendeeMemberIds
      .map((memberId) => calendarMembersById.get(memberId)!.userId)
      .filter((userId) => userId && userId !== organizerUserId))];
    const startAt = new Date();
    requestKey.current = crypto.randomUUID();
    await create({
      title: occurrence.title.slice(0, 120),
      description: occurrence.description.slice(0, 4000),
      immediate: true,
      startAt: startAt.toISOString(),
      endAt: new Date(startAt.getTime() + 1_800_000).toISOString(),
      timezone: timeZone,
      invitees,
    });
  }
  const renderCalendarHomeItem = (occurrence: CalendarMeetingOccurrence, upcoming: boolean) => (
    <div className="home-meeting-item" key={occurrence.key} data-status="calendar" data-source="calendar">
      <span className="home-meeting-icon"><Icon /></span>
      <div className="home-meeting-copy">
        <div className="row">
          <h3 title={occurrence.title}>{occurrence.title}</h3>
          {occurrence.recurring && !(occurrence.collapsedCount && occurrence.collapsedCount > 1) ? <span className="pill">循环日程</span> : null}
        </div>
        <p className="sub">
          {dateStamp(occurrence.startAt)} {occurrence.allDay ? "全天" : `${stamp(occurrence.startAt)}–${stamp(occurrence.endAt)}`}
          <span aria-hidden="true"> · </span>
          <span>日历视频会议</span>
        </p>
      </div>
      {upcoming ? (
        <button
          className="primary home-meeting-start"
          disabled={busy || !readiness?.ready || calendarStartUnavailable}
          onClick={() => void run(() => startCalendarOccurrence(occurrence))}
          data-testid={`meeting-start-calendar-${occurrence.key}`}
        >
          发起会议
        </button>
      ) : null}
    </div>
  );
  const renderHistoryItem = (entry: MeetingHistoryEntry) => {
    if (entry.kind === "calendar") return renderCalendarHomeItem(entry.value, false);
    const m = entry.value;
    return (
      <div className="home-meeting-item" key={m.id} data-status={m.status} data-source="meeting">
        <span className="home-meeting-icon"><Icon /></span>
        <div className="home-meeting-copy">
          <div className="row">
            <h3 title={m.title}>{m.title}</h3>
            {m.status === "live" ? <span className="pill live">进行中</span> : null}
          </div>
          <p className="sub">
            {dateStamp(m.startAt)} {stamp(m.startAt)}–{stamp(m.endAt)}
            <span aria-hidden="true"> · </span>
            <span className="meeting-code">{m.code}</span>
          </p>
        </div>
        <button
          className={m.status === "live" ? "primary" : "home-meeting-open"}
          onClick={() => void run(async () => {
            if (useMeetingStore.getState().meeting?.id === m.id) {
              await focusMeetingWindow("meeting");
              return;
            }
            const current = (await meetingAPI.get(m.id)).meeting;
            if (current.status === "live") openPreview(current);
            else setDetail(current);
          })}
        >
          {m.status === "live" ? "加入" : "详情"}
        </button>
      </div>
    );
  };
  return (
    <div className="meeting-ui meeting-page" style={pageStyle}>
      <AppInsetSurface className="meeting-inset-surface" testId="meeting-inset-surface">
        <div className="meeting-home">
          <aside className="meeting-launcher">
            <ListPanelHeader title="视频会议" titleOnly />
            <div className="meeting-launcher-content">
              <div className="actions">
              <button
                className="action action-start"
                disabled={busy || !readiness?.ready}
                title={meetingReadinessReason(readiness)}
                onClick={() =>
                  void run(() =>
                    create({
                      title: `${displayName || "我"}的音视频会议`,
                      immediate: true,
                      startAt: new Date().toISOString(),
                      endAt: new Date(Date.now() + 1800000).toISOString(),
                      timezone:
                        Intl.DateTimeFormat().resolvedOptions().timeZone,
                    }),
                  )
                }
              >
                <span className="action-icon">
                  <Icon />
                </span>
                <span>
                  <h3>发起会议</h3>
                  <small>即刻开始音视频会议</small>
                </span>
              </button>
              <button className="action action-join" onClick={() => setDialog("join")}>
                <span className="action-icon">
                  <Icon name="plus" />
                </span>
                <span>
                  <h3>加入会议</h3>
                  <small>通过会议号加入</small>
                </span>
              </button>
              <button className="action action-schedule" onClick={openSchedule}>
                <span className="action-icon">
                  <Icon name="calendar" />
                </span>
                <span>
                  <h3>预约会议</h3>
                  <small>为下一次交流留出时间</small>
                </span>
              </button>
              </div>
            </div>
          </aside>
            <section className="meeting-overview">
              <div className="meeting-notice-stack">
                {active && <MeetingPermissionSetup />}
                {error ? (
                  <div className="notice error" role="alert">
                    {error}
                     <button className="ghost" onClick={() => { setError(""); refresh(); }}>刷新</button>
                  </div>
                ) : null}
                {calendarError ? (
                  <div className="notice error" role="alert">
                    部分日历会议未能加载。
                    <button className="ghost" onClick={() => { void calendarBootstrap.refetch(); void calendarScheduling.refetch(); void calendarMembers.refetch(); }}>刷新</button>
                  </div>
                ) : null}
                {readiness && !readiness.ready ? (
                  <div className="notice">
                    <span>{meetingReadinessReason(readiness)}。可以先预约。</span>
                    <button onClick={() => setDialog("settings")}>查看配置</button>
                    <button disabled={loading} onClick={() => void refresh()}>重新检查</button>
                  </div>
                ) : null}
              </div>
              <section className="home-list-section">
                <div className="section-heading row between">
                  <h2>即将开始</h2>
                  <button type="button" className="ghost calendar-all-link" onClick={() => navigate("/calendar")}>在日历中查看全部 <Icon name="chevronRight" /></button>
                </div>
                <div className="home-meeting-list">
                  {calendarLoading ? (
                    <div className="home-list-empty" role="status"><span className="meeting-loader" />正在加载会议…</div>
                  ) : upcomingForHome.length ? (
                    upcomingForHome.slice(0, 4).map((occurrence) => renderCalendarHomeItem(occurrence, true))
                  ) : (
                    <div className="home-list-empty">
                      <span className="empty-icon"><Icon /></span>
                      <div><h3>暂无即将开始的会议</h3><p className="sub small">预约一次会议，为下一次交流留出时间。</p></div>
                      <button onClick={openSchedule}>预约会议</button>
                    </div>
                  )}
                </div>
              </section>
              <section className="home-list-section history-section">
                <div className="section-heading row between">
                  <h2>历史会议</h2>
                </div>
                <div className="home-meeting-list">
                  {loading || calendarLoading ? (
                    <div className="home-list-empty" role="status"><span className="meeting-loader" />正在加载记录…</div>
                  ) : historyForHome.length ? (
                    historyForHome.map(renderHistoryItem)
                  ) : (
                    <div className="home-list-empty compact">
                      <span className="empty-icon"><Icon /></span>
                      <div><h3>暂无历史会议</h3><p className="sub small">已结束的会议会保留在这里。</p></div>
                    </div>
                  )}
                </div>
              </section>
            </section>
        </div>
        <AppSecondarySidebarResizeHandle
          resizing={leftSidebarResizing}
          onPointerDown={startLeftSidebarResize}
        />
      </AppInsetSurface>
      <CalendarEventCreateDialog
        open={calendarScheduleOpen}
        onOpenChange={setCalendarScheduleOpen}
        onSaved={() => { void calendarBootstrap.refetch(); void calendarScheduling.refetch(); }}
      />
      {dialog === "schedule" ? (
        <MeetingDialog
          title={source ? "从会话发起会议" : "预约会议"}
          onClose={close}
        >
          <form
            className="fields"
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              void run(() =>
                create({
                  title: String(data.get("title")),
                  description: String(data.get("description") || ""),
                  immediate: data.get("immediate") === "on",
                  startAt: new Date(String(data.get("start"))).toISOString(),
                  endAt: new Date(String(data.get("end"))).toISOString(),
                  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                  sourceKind: source?.sourceKind,
                  sourceId: source?.sourceId,
                  invitees: data.getAll("invitee").map(String),
                }),
              );
            }}
          >
            <label className="full">
              会议主题
              <input
                name="title"
                placeholder="为这次交流起个名字"
                defaultValue={source?.title || ""}
                required
                maxLength={120}
              />
            </label>
            <label>
              开始时间
              <input
                type="datetime-local"
                name="start"
                defaultValue={inputDate(new Date(Date.now() + 600000))}
                required
              />
            </label>
            <label>
              结束时间
              <input
                type="datetime-local"
                name="end"
                defaultValue={inputDate(new Date(Date.now() + 2400000))}
                required
              />
            </label>
            <label className="full">
              说明
              <textarea name="description" placeholder="添加议题，让参会成员提前了解（选填）" rows={3} maxLength={4000} />
            </label>
            {source ? (
              <label className="check full">
                <input
                  type="checkbox"
                  name="immediate"
                  defaultChecked
                  disabled={!readiness?.ready}
                />
                立即开始（需要已配置音视频）
              </label>
            ) : null}
            <fieldset
              className="full schedule-invitees"
            >
              <legend>邀请成员（可选）</legend>
              <div className="schedule-people">{contacts
                .filter((c) => c.user_id !== user?.id && c.conversationType !== 2)
                .map((c) => (
                  <label className="check" key={c.user_id}>
                    <input type="checkbox" name="invitee" value={c.user_id} />
                    <MeetingMemberAvatar contact={c} /><span>{c.friend_display_name || c.nickname || c.user_id}</span>
                  </label>
                ))}</div>
              {!contacts.some(c => c.user_id !== user?.id && c.conversationType !== 2) ? <p className="sub small">暂无可选成员，创建后也可以分享会议号。</p> : null}
            </fieldset>
            <p className="small sub full">
              时区：{Intl.DateTimeFormat().resolvedOptions().timeZone}
            </p>
            {error ? (
              <p className="error full" role="alert">
                {error}
              </p>
            ) : null}
            <div className="modal-foot full">
              <button type="button" onClick={close}>
                取消
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "创建中…" : "创建会议"}
              </button>
            </div>
          </form>
        </MeetingDialog>
      ) : null}
      {cancelTarget ? (
        <MeetingDialog title="取消会议" onClose={() => !busy && setCancelTarget(null)}>
          <p>确定取消「{cancelTarget.title}」吗？取消后将无法加入。</p>
          <div className="modal-foot">
            <button disabled={busy} onClick={() => setCancelTarget(null)}>保留会议</button>
            <button disabled={busy} onClick={() => void run(async () => {
              await meetingAPI.action(cancelTarget.id, "cancel");
              setCancelTarget(null);
              close();
            })}>确认取消会议</button>
          </div>
          {error ? <p role="alert">{error}</p> : null}
        </MeetingDialog>
      ) : null}
      {dialog === "join" ? (
        <MeetingDialog title="加入会议" onClose={close}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const id = String(
                new FormData(e.currentTarget).get("code"),
              ).replace(/\s/g, "");
              void run(async () => {
                openPreview((await meetingAPI.get(id)).meeting);
                setDialog(null);
              });
            }}
          >
            <label>
              会议号
              <input className="meeting-code-input" name="code" placeholder="输入会议号" required autoComplete="off" />
            </label>
            <p className="sub small field-hint">下一步可预览摄像头，并选择是否开启麦克风。</p>
            {error ? (
              <p className="error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="modal-foot">
              <button className="primary" disabled={busy}>
                下一步
              </button>
            </div>
          </form>
        </MeetingDialog>
      ) : null}
      {dialog === "settings" && readiness ? (
        <MeetingSettingsDialog readiness={readiness} onClose={close} />
      ) : null}
      {detail && !cancelTarget ? (
        <MeetingDialog title="会议详情" onClose={close}>
          {editing ? (
            <form
              className="fields"
              onSubmit={(e) => {
                e.preventDefault();
                const d = new FormData(e.currentTarget);
                void run(async () => {
                  const result = await meetingAPI.action(detail.id, "edit", {
                    version: detail.version,
                    title: String(d.get("title")),
                    startAt: new Date(String(d.get("start"))).toISOString(),
                    endAt: new Date(String(d.get("end"))).toISOString(),
                  });
                  setDetail(result.meeting);
                  setEditing(false);
                  try {
                    await meetingAPI.notify(detail.id);
                  } catch {
                    setError("修改已保存，通知未送达，可重新发送邀请。");
                  }
                });
              }}
            >
              <label className="full">
                主题
                <input
                  name="title"
                  required
                  defaultValue={detail.title}
                  maxLength={120}
                />
              </label>
              <label>
                开始时间
                <input
                  name="start"
                  type="datetime-local"
                  required
                  defaultValue={inputDate(new Date(detail.startAt))}
                />
              </label>
              <label>
                结束时间
                <input
                  name="end"
                  type="datetime-local"
                  required
                  defaultValue={inputDate(new Date(detail.endAt))}
                />
              </label>
              <div className="row full">
                <button type="button" onClick={() => setEditing(false)}>
                  取消修改
                </button>
                <button className="primary" disabled={busy}>
                  保存修改
                </button>
              </div>
            </form>
          ) : (
            <div className="detail-title"><span className={`pill ${detail.status === "live" ? "live" : ""}`}>{meetingStatusLabel(detail)}</span><h2>{detail.title}</h2></div>
          )}
          <div className="stack" style={{ marginTop: 20 }}>
            <p className="detail-meta sub"><Icon name="clock" width={17} height={17} />
              {new Date(detail.startAt).toLocaleString()} –{" "}
              {stamp(detail.endAt)}
            </p>
            <p className="detail-meta sub"><Icon width={17} height={17} />
              会议号 <MeetingCode code={detail.code} />
            </p>
            {detail.description ? <p className="detail-description">{detail.description}</p> : null}
            {detail.invites[user?.id || ""] ? (
              <div className="row">
                {["accepted", "tentative", "declined"].map((v, i) => (
                  <button
                    key={v}
                    disabled={busy || meetingClosed(detail)}
                    onClick={() =>
                      void run(async () => {
                        setDetail(
                          (
                            await meetingAPI.action(detail.id, "rsvp", {
                              rsvp: v,
                            })
                          ).meeting,
                        );
                      })
                    }
                  >
                    {["接受", "待定", "婉拒"][i]}
                  </button>
                ))}
              </div>
            ) : null}
            {error ? (
              <p className="error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <div className="modal-foot">
            {detail.organizerId === user?.id ? (
              <>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await meetingAPI.notify(detail.id);
                      setError("");
                    })
                  }
                >
                  重新发送邀请
                </button>
                {!meetingClosed(detail) && detail.status !== "live" ? (
                  <button disabled={busy} onClick={() => setEditing(true)}>
                    修改预约
                  </button>
                ) : null}
                {!meetingClosed(detail) && detail.status !== "live" ? (
                  <button
                    disabled={busy}
                    onClick={() => setCancelTarget(detail)}
                  >
                    取消会议
                  </button>
                ) : null}
              </>
            ) : null}
            <button
              className="primary"
              disabled={meetingClosed(detail) || !readiness?.ready}
              onClick={() => {
                openPreview(detail);
                setDetail(null);
              }}
            >
              加入会议
            </button>
          </div>
        </MeetingDialog>
      ) : null}
      {preview ? <MeetingPrejoin meeting={preview} onClose={close} /> : null}
    </div>
  );
}
type MeetingPrejoinProps = { onClose: () => void } & (
  | { meeting: Meeting; calendarTitle?: never; startCalendarMeeting?: never }
  | { meeting?: never; calendarTitle: string; startCalendarMeeting: () => Promise<Meeting> }
);

export function MeetingPrejoin({ meeting, calendarTitle, startCalendarMeeting, onClose }: MeetingPrejoinProps) {
  const imUser = useJuggleChatStore(s => s.user);
  const prefs = useMeetingUserPreferences();
  const [mic, setMic] = useState(prefs.defaultMic),
    [camera, setCamera] = useState(prefs.defaultCamera),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  // The calendar dialog mounts its portal after finding the launching popup.
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const releasePreview = useRef<() => void>(() => {});
  const createdMeeting = useRef<Meeting | null>(null);
  const submitting = useRef(false);
  useEffect(() => () => { submitting.current = false; }, []);
  useEffect(() => {
    if (busy || (!mic && !camera) || !video) return;
    const release = startPrejoinPreview(video, mic, camera, cause => {
      setError(meetingDeviceError(cause, mic, camera));
      setMic(false);
      setCamera(false);
    });
    releasePreview.current = release;
    return release;
  }, [mic, camera, busy, video]);

  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (!settingsOpen && restoreFocus.current) settingsButton.current?.focus({ preventScroll: true });
    restoreFocus.current = settingsOpen;
  }, [settingsOpen]);
  const cancel = () => {
    if (settingsOpen) setSettingsOpen(false);
    else if (!submitting.current) onClose();
  };
  async function join() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    releasePreview.current();
    try {
      const target = startCalendarMeeting
        ? (createdMeeting.current ??= await startCalendarMeeting())
        : meeting;
      if (!submitting.current) return;
      await useMeetingStore.getState().join(target, mic, camera);
      if (submitting.current) onClose();
    } catch (cause) {
      if (submitting.current) setError(cause instanceof Error ? cause.message : String(cause || "入会失败，请重试。"));
    } finally {
      if (submitting.current) setBusy(false);
      submitting.current = false;
    }
  }

  const devices = (
    <div className="prejoin-devices" role="group" aria-label="设备设置">
      <button type="button" aria-pressed={mic} aria-label={startCalendarMeeting ? "麦克风" : undefined} className={!mic ? "device-off" : ""} disabled={busy} onClick={() => { setError(""); setMic(!mic); }}>
        <Icon name="mic" off={!mic} /><span>{mic ? "麦克风开启" : "麦克风关闭"}</span>
      </button>
      <button type="button" aria-pressed={camera} aria-label={startCalendarMeeting ? "摄像头" : undefined} className={!camera ? "device-off" : ""} disabled={busy} onClick={() => { setError(""); setCamera(!camera); }}>
        <Icon off={!camera} /><span>{camera ? "摄像头开启" : "摄像头关闭"}</span>
      </button>
    </div>
  );
  const content = <MeetingUserSettings entry="prejoin" camera={camera} prefs={prefs} preview={
      <div className="preview" data-camera-off={!camera}>
        <MeetingMemberAvatar contact={{user_id: imUser?.id || "me", nickname: imUser?.name || "我", avatar: imUser?.portrait}} />
        <video autoPlay playsInline muted ref={setVideo} data-mirrored={prefs.mirrorPreview} style={{ visibility: camera ? "visible" : "hidden" }} />
        <span className={startCalendarMeeting ? "sr-only" : "sub small"}>
          {camera ? "本地预览" : "摄像头已关闭"}
        </span>
        {!settingsOpen && <button type="button" className="preview-settings" ref={settingsButton} disabled={busy}
          aria-label="会议设置" title="会议设置" onClick={() => setSettingsOpen(true)}>
          <Icon name="settings" width={18} height={18} />设置
        </button>}
      </div>
    } prejoin={settingsOpen ? undefined : {
      heading: meeting && <div className="prejoin-heading"><h3>{meeting.title}</h3><span className="sub small">会议号 <MeetingCode code={meeting.code} /></span></div>,
      controls: <>
      {!startCalendarMeeting && <p className="sub small">首次开启麦克风或摄像头时，请在系统提示中选择允许。</p>}
      <MeetingPermissionRestart />
      {!startCalendarMeeting && devices}
      {error ? (
        <MeetingPermissionNotice message={error} onClose={() => setError("")} />
      ) : null}
      <div className="modal-foot">
        {startCalendarMeeting ? devices : <button type="button" onClick={cancel} disabled={busy}>
          取消
        </button>}
        <button type="button" className="primary" disabled={busy} onClick={() => void join()}>
          {busy ? "正在加入…" : startCalendarMeeting ? "开始会议" : "加入会议"}
        </button>
      </div></>,
    }} />;
  const settingsClass = settingsOpen ? "meeting-settings-dialog" : "";
  return startCalendarMeeting
    ? <CalendarPrejoinDialog className={settingsClass} title={settingsOpen ? "会议设置" : calendarTitle.trim() || "开始会议"}
        closeLabel={settingsOpen ? "返回预览" : "取消"} busy={busy} onClose={cancel}>{content}</CalendarPrejoinDialog>
    : <MeetingDialog className={settingsClass} title={settingsOpen ? "会议设置" : "加入会议"} onClose={cancel}>{content}</MeetingDialog>;
}
function MeetingSettingsDialog({
  readiness,
  onClose,
}: {
  readiness: MeetingReadiness;
  onClose: () => void;
}) {
  const s = readiness.settings;
  return (
    <MeetingDialog title="会议配置状态" onClose={onClose}>
      <div className="stack">
        <div className="configuration-summary"><span className="action-icon"><Icon name="settings" /></span><div><strong>{readiness.ready ? "音视频会议已就绪" : s.enabled ? "会议配置待完善" : "音视频会议未启用"}</strong><span className="sub small">{readiness.ready ? "可以发起会议并邀请成员加入" : meetingReadinessReason(readiness)}</span></div></div>
        <dl className="configuration-list">
          <div><dt>ZEGO AppID</dt><dd>{s.appId || "未配置"}</dd></div>
          <div><dt>服务端密钥</dt><dd>{readiness.hasServerSecret ? "已配置" : "未配置"}</dd></div>
          <div><dt>参会人数上限</dt><dd>{s.capacity} 人</dd></div>
          <div><dt>准入验证</dt><dd>{s.admissionConfigured ? "已确认" : "待确认"}</dd></div>
        </dl>
        <p className="sub small">
          ZEGO 配置由 Server 配置文件统一管理。请修改服务端 conf/config.yml 中的
          meeting 配置，保存后重启 Server。
        </p>
        <div className="modal-foot">
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </MeetingDialog>
  );
}
