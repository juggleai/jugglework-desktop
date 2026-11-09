import { focusMeetingWindow } from "@/app/lib/desktop";
import { MeetingPermissionNotice } from "./permission-notice";
import { ensureMeetingMediaPermissions, meetingDeviceError } from "./media-permission";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useDenAuth } from "../cloud/den-auth-provider";
import { useJuggleChatStore } from "../jugglechat/store";
import { meetingAPI } from "./api";
import { meetingReadinessReason } from "./readiness";
import {
  meetingClosed,
  meetingStatusLabel,
  type Meeting,
  type MeetingCreate,
  type MeetingReadiness,
} from "./types";
import { MeetingIcon as Icon } from "./meeting-icons";
import { useMeetingStore } from "./store";
import "./meeting.css";
const stamp = (date: string) =>
  new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const localDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const inputDate = (date: Date) =>
  `${localDate(date)}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
export function MeetingDialog({
  title,
  children,
  onClose,
  ownerDocument = document,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  ownerDocument?: Document;
}) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = ownerDocument.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input,button")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab") {
        const list = [
          ...ref.current!.querySelectorAll<HTMLElement>(
            "button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])",
          ),
        ];
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
        className="meeting-ui"
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
export function MeetingPage() {
  const { activeOrganization, user } = useDenAuth();
  const contacts = useJuggleChatStore((s) => s.contacts);
  const imUser = useJuggleChatStore((s) => s.user);
  const displayName = imUser?.id === user?.id ? imUser?.name || user?.name : user?.name;
  const [cancelTarget, setCancelTarget] = useState<Meeting | null>(null);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<"home" | "calendar" | "history">("home");
  const [view, setView] = useState<"month" | "week" | "day">("month");
  const [date, setDate] = useState(new Date());
  const [items, setItems] = useState<Meeting[]>([]);
  const [readiness, setReadiness] = useState<MeetingReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
  const epoch = useRef(0);
  const calendarYear = date.getFullYear();
  const calendarMonth = date.getMonth();
  const refresh = useCallback(async () => {
    const run = ++epoch.current;
    // Background refresh keeps the existing schedule mounted.

    try {
      const from = new Date(calendarYear, calendarMonth, 1);
      const to = new Date(calendarYear, calendarMonth + 1, 1);
      const [settings, list] = await Promise.allSettled([
        meetingAPI.settings(),
        meetingAPI.list(from, to),
      ]);
      if (run !== epoch.current) return;
      if (settings.status === "fulfilled") setReadiness(settings.value);
      else setReadiness(null);
      if (list.status === "fulfilled") setItems(list.value.meetings);
      const failures = [settings, list].flatMap((result) =>
        result.status === "rejected"
          ? [result.reason instanceof Error ? result.reason.message : "加载失败"]
          : [],
      );
      setError(failures.join("；"));
    } catch (e) {
      if (run === epoch.current)
        setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      if (run === epoch.current) setLoading(false);
    }
  }, [calendarYear, calendarMonth, activeOrganization?.id, user?.id]);
  useEffect(() => {
    setLoading(true);
    setError("");
    setItems([]);
    setReadiness(null);
    void refresh();
    return () => {
      epoch.current++;
    };
  }, [refresh]);
  useEffect(() => {
    const update = () => void refresh();
    window.addEventListener("meeting:changed", update);
    window.addEventListener("focus", update);
    const timer = window.setInterval(update, 30000);
    return () => {
      window.removeEventListener("meeting:changed", update);
      window.removeEventListener("focus", update);
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    const open = (event: Event) => {
      const d = (event as CustomEvent).detail;
      if (d?.meetingId) {
        void meetingAPI
          .get(d.meetingId)
          .then((v) => openPreview(v.meeting))
          .catch((e) => setError(e.message));
      } else if (d?.sourceId) {
        setSource(d);
        setDialog("schedule");
        requestKey.current = crypto.randomUUID();
      }
    };
    window.addEventListener("meeting:open", open);
    return () => window.removeEventListener("meeting:open", open);
  }, []);
  async function run(fn: () => Promise<void>) {
    if (busy) return;
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
  const upcoming = items.filter((m) => !meetingClosed(m));
  const today = upcoming.filter(
    (m) => localDate(new Date(m.startAt)) === localDate(new Date()),
  );
  const selectedDayMeetings = upcoming.filter(
    (m) => localDate(new Date(m.startAt)) === localDate(date),
  );
  const isTodaySelected = localDate(date) === localDate(new Date());
  async function create(input: MeetingCreate) {
    const { meeting } = await meetingAPI.create(input, requestKey.current);
    requestKey.current = crypto.randomUUID();
    setDialog(null);
    setSource(null);
    await refresh();
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
    requestKey.current = crypto.randomUUID();
    setDialog("schedule");
  }
  const renderItem = (m: Meeting) => (
    <div className="meeting-item" key={m.id}>
      <div className="time">
        {stamp(m.startAt)}
        <small>{stamp(m.endAt)}</small>
      </div>
      <div className="meeting-body">
        <div className="row">
          <h3>{m.title}</h3>
          <span className={`pill ${m.status === "live" ? "live" : ""}`}>
            {meetingStatusLabel(m)}
          </span>
        </div>
        <span className="sub small">
          {m.sourceKind === "group"
            ? "来自组织群"
            : m.sourceKind === "direct"
              ? "来自单聊"
              : m.organizerId === user?.id
                ? "我发起的会议"
                : "受邀会议"}{" "}
          · {meetingClosed(m) ? (m.status === "cancelled" ? "会议已取消" : "会议已结束") : m.status === "live" ? `${Object.keys(m.participants).length} 人在会` : "尚未开始"}
        </span>
      </div>
      <button
        className={m.status === "live" ? "primary" : ""}
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
        {m.status === "live" ? "加入会议" : "查看详情"}
      </button>
    </div>
  );
  const offset =
    (new Date(date.getFullYear(), date.getMonth(), 1).getDay() + 6) % 7;
  const days = Array.from(
    { length: 42 },
    (_, i) => new Date(date.getFullYear(), date.getMonth(), i - offset + 1),
  );
  return (
    <div className="meeting-ui">
      <header className="header">
        <strong>会议</strong>
        <div className="tabs">
          {(["home", "calendar", "history"] as const).map((t, i) => (
            <button
              key={t}
              className={tab === t ? "selected" : ""}
              aria-pressed={tab === t}
              onClick={() => setTab(t)}
            >
              {["首页", "日历", "历史会议"][i]}
            </button>
          ))}
        </div>
        <button
          className="ghost icon-button"
          aria-label="会议设置"
          onClick={() => setDialog("settings")}
        >
          <Icon name="settings" />
        </button>
      </header>
      <main className="content">
        {error ? (
          <div className="notice error" role="alert">
            {error}
            <button className="ghost" onClick={() => void refresh()}>
              刷新
            </button>
          </div>
        ) : null}
        {readiness && !readiness.ready ? (
          <div className="notice">
            <span>
              {meetingReadinessReason(readiness)}。可以先预约。
            </span>
            <button onClick={() => setDialog("settings")}>查看配置</button>
            <button disabled={loading} onClick={() => void refresh()}>
              重新检查
            </button>
          </div>
        ) : null}
        <div className="welcome row between">
          <div>
            <div className="eyebrow">MEET, CONNECT, CREATE</div>
            <h1>
              {tab === "home"
                ? "让想法，在这里相遇。"
                : tab === "calendar"
                  ? "会议日历"
                  : "历史会议"}
            </h1>
            <p className="sub">
              {tab === "home"
                ? `${displayName || "你好"}，今天有 ${today.length} 场会议。`
                : "为每一次有价值的交流留出时间。"}
            </p>
          </div>
          {tab !== "home" ? (
            <button className="primary" onClick={openSchedule}>
              <Icon name="plus" />
              预约会议
            </button>
          ) : null}
        </div>
        {tab === "home" ? (
          <>
            <div className="actions">
              <button
                className="action"
                disabled={busy || !readiness?.ready}
                title={meetingReadinessReason(readiness)}
                onClick={() =>
                  void run(() =>
                    create({
                      title: `${displayName || "我"}的即时会议`,
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
                  <h3>快速会议</h3>
                  <small>即刻开始，让讨论发生</small>
                </span>
              </button>
              <button className="action" onClick={() => setDialog("join")}>
                <span className="action-icon">
                  <Icon name="plus" />
                </span>
                <span>
                  <h3>加入会议</h3>
                  <small>通过会议号加入</small>
                </span>
              </button>
              <button className="action" onClick={openSchedule}>
                <span className="action-icon">
                  <Icon name="calendar" />
                </span>
                <span>
                  <h3>预约会议</h3>
                  <small>为下一次交流留出时间</small>
                </span>
              </button>
            </div>
            <div className="dashboard">
              <section>
                <div className="row between">
                  <h2>{isTodaySelected ? "今日安排" : `${date.getMonth() + 1}月${date.getDate()}日安排`}</h2>
                  <button className="ghost" onClick={() => setTab("calendar")}>
                    查看日历
                    <Icon name="arrow" />
                  </button>
                </div>
                {loading ? (
                  <div className="empty" role="status"><span className="meeting-loader" />正在加载会议…</div>
                ) : selectedDayMeetings.length ? (
                  selectedDayMeetings.map(renderItem)
                ) : (
                  <div className="empty">
                    <span className="empty-icon"><Icon name="calendar" width={26} height={26} /></span>
                    <h3>{isTodaySelected ? "今天" : "当天"}暂无会议</h3>
                    <p className="small">留一点时间，给下一次有价值的交流。</p>
                    <button className="ghost" onClick={openSchedule}><Icon name="plus" />预约一次会议</button>
                  </div>
                )}
              </section>
              <aside>
                <div className="mini-calendar">
                  <strong>
                    {date.getFullYear()} 年 {date.getMonth() + 1} 月
                  </strong>
                  <div className="mini-grid">
                    {"一二三四五六日".split("").map((d) => (
                      <span key={d} className="sub">
                        {d}
                      </span>
                    ))}
                    {days.map((d) => (
                      <button
                        key={d.toISOString()}
                        type="button"
                        aria-label={`查看 ${localDate(d)} 的会议`}
                        onClick={() => setDate(d)}
                        aria-pressed={localDate(d) === localDate(date)}
                        className={
                          localDate(d) === localDate(date)
                            ? "today"
                            : d.getMonth() !== date.getMonth()
                              ? "sub"
                              : ""
                        }
                      >
                        {d.getDate()}
                      </button>
                    ))}
                  </div>
                </div>
                <p
                  className="sub small"
                  style={{ padding: "22px 3px", lineHeight: 1.9 }}
                >
                  从群聊发起会议，成员随时加入。
                  <br />
                  也可以从单聊开始，邀请更多伙伴。
                </p>
              </aside>
            </div>
          </>
        ) : null}
        {tab !== "home" ? (
          <>
            <div className="row between calendar-toolbar">
              <div className="row">
                <button
                  aria-label="上个月"
                  onClick={() =>
                    setDate(
                      new Date(date.getFullYear(), date.getMonth() - 1, 1),
                    )
                  }
                >
                  ‹
                </button>
                <h2>
                  {date.getFullYear()} 年 {date.getMonth() + 1} 月
                </h2>
                <button
                  aria-label="下个月"
                  onClick={() =>
                    setDate(
                      new Date(date.getFullYear(), date.getMonth() + 1, 1),
                    )
                  }
                >
                  ›
                </button>
                <button onClick={() => setDate(new Date())}>今天</button>
              </div>
              {tab === "calendar" ? (
                <div className="row">
                  {(["day", "week", "month"] as const).map((v, i) => (
                    <button
                      key={v}
                      className={view === v ? "primary" : ""}
                      onClick={() => setView(v)}
                    >
                      {["日", "周", "月"][i]}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {tab === "history" ? (
              items.filter(meetingClosed).length ? (
                items.filter(meetingClosed).map(renderItem)
              ) : (
                <div className="empty">本月暂无历史会议</div>
              )
            ) : view === "month" ? (
              <div className="calendar">
                {"一二三四五六日".split("").map((d) => (
                  <div key={d} className="cal-day cal-head">
                    周{d}
                  </div>
                ))}
                {days.map((d) => (
                  <div
                    key={d.toISOString()}
                    className={`cal-day ${localDate(d) === localDate(new Date()) ? "today" : ""}`}
                  >
                    <span
                      className={d.getMonth() !== date.getMonth() ? "sub" : ""}
                    >
                      {d.getDate()}
                    </span>
                    {items
                      .filter(
                        (m) => localDate(new Date(m.startAt)) === localDate(d),
                      )
                      .map((m) => (
                        <button
                          className="cal-event"
                          key={m.id}
                          onClick={() => setDetail(m)}
                        >
                          {stamp(m.startAt)} {m.title}
                        </button>
                      ))}
                  </div>
                ))}
              </div>
            ) : (
              <>
                {view === "day" ? (
                  <input
                    aria-label="选择日期"
                    type="date"
                    value={localDate(date)}
                    onChange={(e) =>
                      setDate(new Date(`${e.target.value}T12:00:00`))
                    }
                  />
                ) : (
                  <p className="sub">本周议程 · 以当前日期所在周为准</p>
                )}
                {items
                  .filter((m) => {
                    const d = new Date(m.startAt);
                    if (view === "day") return localDate(d) === localDate(date);
                    const start = new Date(date);
                    start.setHours(0, 0, 0, 0);
                    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
                    return +d >= +start && +d < +start + 7 * 86400000;
                  })
                  .map(renderItem)}
              </>
            )}
          </>
        ) : null}
      </main>
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
              <textarea name="description" rows={3} maxLength={4000} />
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
              className="full stack"
              style={{
                border: 0,
                padding: 0,
                maxHeight: 150,
                overflow: "auto",
              }}
            >
              <legend>邀请成员（可选）</legend>
              {contacts
                .filter((c) => c.user_id !== user?.id)
                .map((c) => (
                  <label className="check" key={c.user_id}>
                    <input type="checkbox" name="invitee" value={c.user_id} />
                    {c.nickname || c.user_id}
                  </label>
                ))}
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
              <input name="code" required autoComplete="off" />
            </label>
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
                  await refresh();
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
            <h2>{detail.title}</h2>
          )}
          <div className="stack" style={{ marginTop: 20 }}>
            <p className="sub">
              {new Date(detail.startAt).toLocaleString()} –{" "}
              {stamp(detail.endAt)}
            </p>
            <p className="sub">
              会议号 {detail.code} · {meetingStatusLabel(detail)}
            </p>
            <p>{detail.description}</p>
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
                        await refresh();
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
export function MeetingPrejoin({
  meeting,
  onClose,
}: {
  meeting: Meeting;
  onClose: () => void;
}) {
  const [mic, setMic] = useState(false),
    [camera, setCamera] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  useEffect(() => {
    let cancelled = false;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (mic || camera)
      void ensureMeetingMediaPermissions(mic, camera)
        .then(() => {
          if (cancelled) return null;
          return navigator.mediaDevices.getUserMedia({ audio: mic, video: camera });
        })
        .then((v) => {
          if (!v) return;
          setError("");
          if (cancelled) {
            v.getTracks().forEach((t) => t.stop());
            return;
          }
          stream.current = v;
          if (video.current) video.current.srcObject = v;
        })
        .catch((e) => {
          if (!cancelled) {
            setError(meetingDeviceError(e, mic, camera));
            setMic(false);
            setCamera(false);
          }
        });
    return () => {
      cancelled = true;
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
    };
  }, [mic, camera]);
  return (
    <MeetingDialog
      title="加入会议"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="sub small" style={{ marginBottom: 15 }}>
        {meeting.title} · {meeting.code}
      </p>
      <div className="preview">
        <span className="avatar">我</span>
        <video autoPlay playsInline muted ref={video} />
        <span className="sub small">
          {camera ? "本地预览" : "摄像头已关闭"}
        </span>
      </div>
      <div className="row">
        <button disabled={busy} onClick={() => setMic(!mic)}>
          <Icon name="mic" off={!mic} />
          {mic ? "麦克风开启" : "麦克风关闭"}
        </button>
        <button disabled={busy} onClick={() => setCamera(!camera)}>
          <Icon off={!camera} />
          {camera ? "摄像头开启" : "摄像头关闭"}
        </button>
      </div>
      {error ? (
        <MeetingPermissionNotice message={error} onClose={() => setError("")} />
      ) : null}
      <div className="modal-foot">
        <button onClick={onClose} disabled={busy}>
          取消
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            stream.current?.getTracks().forEach((t) => t.stop());
            void useMeetingStore
              .getState()
              .join(meeting, mic, camera)
              .then(onClose)
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "正在加入…" : "加入会议"}
        </button>
      </div>
    </MeetingDialog>
  );
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
        <p className="sub">
          ZEGO 配置由 Server 配置文件统一管理。请修改服务端 conf/config.yml 中的
          meeting 配置，保存后重启 Server。
        </p>
        <label>
          ZEGO AppID
          <input readOnly value={s.appId || ""} placeholder="未配置" />
        </label>
        <p>
          ServerSecret：
          {readiness.hasServerSecret ? "已配置（不显示密钥）" : "未配置"}
        </p>
        <p>人数上限：{s.capacity} 人</p>
        <p>准入验证：{s.admissionConfigured ? "已确认" : "待确认"}</p>
        {!readiness.ready ? <p>{meetingReadinessReason(readiness)}</p> : null}
        <p>
          音视频：
          {readiness.ready
            ? "可用"
            : s.enabled
              ? "已启用，服务依赖尚未就绪"
              : "未启用"}
        </p>
        <div className="modal-foot">
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </MeetingDialog>
  );
}
