import { bindRemoteAudio } from "./remote-audio";
import { MeetingMembers } from "./meeting-members";
import { MeetingInvitePicker } from "./meeting-invite-picker";
import { MeetingPermissionNotice } from "./permission-notice";
import { focusMeetingWindow, markMeetingMiniReady } from "@/app/lib/desktop";
import { guardMeetingWindowClose } from "./window-lifecycle";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDenAuth } from "../cloud/den-auth-provider";
import { useJuggleChatStore } from "../jugglechat/store";
import { meetingAPI } from "./api";
import { useMeetingStore, forceMeetingCleanup } from "./store";
import { MeetingDialog } from "./meeting-page";
import { MeetingIcon as Icon } from "./meeting-icons";
import type { MediaTile } from "./zego-adapter";
import "./meeting.css";
function Video({ tile }: { tile: MediaTile; local: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.srcObject = tile.stream;
      void ref.current.play().catch(() => {});
    }
    return () => {
      if (ref.current) ref.current.srcObject = null;
    };
  }, [tile.stream]);
  return <video ref={ref} autoPlay playsInline muted />;
}
function RemoteAudio({ tile, onBlocked }: { tile: MediaTile; onBlocked: (id: string, blocked: boolean) => void }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const player = bindRemoteAudio(ref.current, tile.stream, value => onBlocked(tile.id, value));
    const resume = () => { void player.play(); };
    window.addEventListener("meeting:resume-audio", resume);
    return () => {
      window.removeEventListener("meeting:resume-audio", resume);
      player.dispose();
    };
  }, [tile.id, tile.stream, onBlocked]);
  return <audio ref={ref} autoPlay hidden data-meeting-remote-audio={tile.id} />;
}
export function MeetingRoomHost() {
  const s = useMeetingStore();
  const { user, activeOrganization } = useDenAuth();
  const contacts = useJuggleChatStore((v) => v.contacts);
  const imUser = useJuggleChatStore((v) => v.user);
  const participantName = (id: string, fallback?: string) =>
    (id === imUser?.id ? imUser.name : contacts.find((c) => c.user_id === id)?.nickname) || fallback || "参会人";
  const [panel, setPanel] = useState<"members" | "chat" | null>(null);
  const [invite, setInvite] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [popup, setPopup] = useState<Window | null>(null);
  const [speaker, setSpeaker] = useState(false);
  const [blockedAudio, setBlockedAudio] = useState<Set<string>>(new Set());
  const onAudioBlocked = useCallback((id: string, blocked: boolean) => {
    setBlockedAudio(previous => {
      if (previous.has(id) === blocked) return previous;
      const next = new Set(previous);
      if (blocked) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  const [miniPopup, setMiniPopup] = useState<Window | null>(null);
  const uid = user?.id || "";
  const m = s.meeting;
  const previousUser = useRef(uid);
  useEffect(() => {
    if (
      m &&
      (m.organizationId !== activeOrganization?.id ||
        !uid ||
        previousUser.current !== uid)
    )
      forceMeetingCleanup("组织或账号已切换，会议已离开。");
    previousUser.current = uid;
  }, [activeOrganization?.id, uid, m?.organizationId]);
  useEffect(() => {
    if (!m) {
      setInvite(false);
      setLeaving(false);
      setMiniPopup(null);
      popup?.close();
      setPopup(null);
    }
  }, [m, popup]);
  useEffect(() => {
    if (!popup) return;
    const watch = setInterval(() => {
      if (popup.closed) {
        setInvite(false);
        setLeaving(false);
        setPopup(null);
        const current = useMeetingStore.getState().meeting;
        const participant = current?.participants[uid];
        if (!current) return;
        forceMeetingCleanup("会议窗口已关闭，音视频已停止。");
        if (current && participant)
          void meetingAPI
            .action(current.id, "leave", { sessionId: participant.sessionId })
            .catch(() => {});
      }
    }, 500);
    return () => {
      clearInterval(watch);
    };
  }, [popup, uid]);
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (useMeetingStore.getState().phase !== "idle") {
        e.preventDefault();
        e.returnValue = "正在会议中";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, []);
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  function focusWindow(target: "main" | "meeting", child = popup) {
    if (window.__JUGGLEWORK_ELECTRON__?.invokeDesktop) {
      void focusMeetingWindow(target).catch((error) =>
        setMessage(error instanceof Error ? error.message : "窗口切换失败"),
      );
    } else if (target === "main") window.focus();
    else child?.focus();
  }
  function detach() {
    if (popup && !popup.closed) {
      focusWindow("meeting");
      return;
    }
    const w = window.open(
      "about:blank",
      "jugglework-meeting",
      "popup,width=1200,height=800",
    );
    if (!w) {
      forceMeetingCleanup("无法打开独立会议窗口，请重试加入会议。");
      return;
    }
    w.document.title = m?.title || "会议";
    w.document.documentElement.className = document.documentElement.className;
    w.document.documentElement.dataset.theme =
      document.documentElement.dataset.theme;
    w.document.body.style.cssText = "margin:0;height:100vh";
    for (const style of document.querySelectorAll(
      'link[rel="stylesheet"],style',
    ))
      w.document.head.appendChild(style.cloneNode(true));
    guardMeetingWindowClose(
      w,
      () => useMeetingStore.getState().phase !== "idle",
      () => {
        setInvite(false);
        setMessage("");
        setLeaving(true);
        focusWindow("meeting", w);
      },
    );
    const mini = window.open("about:blank", "jugglework-meeting-mini", "popup,width=260,height=82");
    if (mini) {
      mini.document.title = "会议小窗";
      mini.document.documentElement.className = document.documentElement.className;
      mini.document.documentElement.dataset.theme = document.documentElement.dataset.theme;
      mini.document.body.style.cssText = "margin:0;height:100vh;overflow:hidden";
      for (const style of document.querySelectorAll('link[rel="stylesheet"],style'))
        mini.document.head.appendChild(style.cloneNode(true));
      setMiniPopup(mini);
    }
    setPopup(w);
    focusWindow("meeting", w);
  }
  useEffect(() => {
    if (!miniPopup || !window.__JUGGLEWORK_ELECTRON__?.invokeDesktop) return;
    // Portal has committed before native code can reveal the small window.
    void markMeetingMiniReady().catch((e) => setMessage(e.message));
  }, [miniPopup]);
  // Each new meeting opens its own native window through Electron's
  // named-window handler. Closing it never moves the meeting into the main UI.
  useEffect(() => {
    if (m) { setPanel(null); detach(); }
  }, [m?.id]);
  if (!m)
    return s.error ? (
      <div className="meeting-return" role="alert">
        {s.error}
        <button
          aria-label="关闭"
          onClick={() => useMeetingStore.setState({ error: null })}
        >
          ×
        </button>
      </div>
    ) : null;
  const compactContent = (
    <div className="meeting-ui meeting-compact">
      <div className="compact-speaking">正在讲话：</div>
      <div className="compact-controls">
        <button title="展开会议" aria-label="展开会议" onClick={() => focusWindow("meeting")}><Icon name="expand" /></button>
        <button className={!s.mic ? "device-off" : ""} title={s.mic ? "静音" : "开启麦克风"} aria-label={s.mic ? "静音" : "开启麦克风"} disabled={busy} onClick={() => void run(() => s.toggleDevice("mic"))}><Icon name="mic" off={!s.mic} /></button>
        <button className={!s.camera ? "device-off" : ""} title={s.camera ? "关闭摄像头" : "开启摄像头"} aria-label={s.camera ? "关闭摄像头" : "开启摄像头"} disabled={busy} onClick={() => void run(() => s.toggleDevice("camera"))}><Icon off={!s.camera} /></button>
        <button className="compact-hangup" title="离开会议" aria-label="离开会议" onClick={() => { focusWindow("meeting"); setLeaving(true); }}><Icon name="hangup" /></button>
      </div>
      {message || s.error ? <div className="compact-error"><MeetingPermissionNotice message={message || s.error || ""} onClose={() => { setMessage(""); useMeetingStore.setState({ error: null }); }} /></div> : null}
    </div>
  );
  const content = (
    <div className="meeting-ui">
      <section className="room">
        <header className="header">
          <div className="row">
            <strong>{m.title}</strong>
            <span className="pill live">
              {s.phase === "joining" ? "连接中" : "会议中"}
            </span>
          </div>
          <div className="row">
            <button className="ghost" aria-pressed={speaker} onClick={() => setSpeaker(!speaker)}>
              {speaker ? "宫格布局" : "焦点布局"}
            </button>
            {!popup ? (
              <button className="ghost" onClick={detach}>
                独立窗口
              </button>
            ) : null}
            <button
              className="ghost"
              onClick={() => {
                focusWindow("main");
              }}
            >
              返回工作台
            </button>
          </div>
        </header>
        {s.error || message ? (
          <MeetingPermissionNotice message={message || s.error || ""} onClose={() => { setMessage(""); useMeetingStore.setState({ error: null }); }} />
        ) : null}
        {blockedAudio.size > 0 ? <div className="notice" role="alert" style={{ margin: 0 }}>
          <span>会议声音尚未播放，请点击重试。</span>
          <button onClick={() => window.dispatchEvent(new Event("meeting:resume-audio"))}>播放会议声音</button>
        </div> : null}
        <div className="room-main">
          <div className="stage">
            {s.tiles
              .filter((t) => t.screen)
              .map((t) => (
                <div className="tile share-stage" key={t.id}>
                  <Video tile={t} local={t.userId === uid} />
                  <span className="tile-label">
                    屏幕共享 · {participantName(t.userId, m.participants[t.userId]?.name)}
                  </span>
                </div>
              ))}
            {Object.values(m.participants).map((p, i) => {
              const tile = s.tiles.find(
                (t) => !t.screen && t.userId === p.userId,
              );
              return (
                <div
                  className="tile"
                  key={p.userId}
                  style={
                    speaker && i === 0
                      ? { gridColumn: "1/-1", minHeight: 350 }
                      : undefined
                  }
                >
                  <span className="avatar">{participantName(p.userId, p.name).slice(0, 1)}</span>
                  {tile ? <Video tile={tile} local={p.userId === uid} /> : null}
                  <span className="tile-label">
                    {participantName(p.userId, p.name)}
                    {p.userId === uid ? "（我）" : ""}
                    {p.userId === m.hostId ? " · 主持人" : ""}
                  </span>
                </div>
              );
            })}
          </div>
          {panel ? (
            <aside className="room-panel" key={panel} aria-label={panel === "members" ? "参会成员" : "会议聊天"}>
              <div className="row between">
                <h3>
                  {panel === "members"
                    ? `参会成员 (${Object.keys(m.participants).length})`
                    : "会议聊天"}
                </h3>
                <button
                  className="ghost icon-button"
                  aria-label="关闭面板"
                  onClick={() => setPanel(null)}
                >
                  <Icon name="close" />
                </button>
              </div>
              {panel === "members" ? (
                <MeetingMembers key={m.id} meeting={m} contacts={contacts} userId={uid} busy={busy}
                  onTransfer={(id) => void run(() => s.action("transfer", { userId: id }))} />
              ) : (
                <>
                  <p className="sub small">仅当前会议聊天室成员可见</p>
                  {!s.chatReady ? (
                    <button
                      disabled={busy}
                      onClick={() => void run(s.retryChat)}
                    >
                      重连聊天室
                    </button>
                  ) : null}
                  <div className="messages" aria-live="polite">
                    {!s.messages.length ? <div className="chat-empty"><Icon name="chat" width={28} height={28} /><p>聊聊此刻的想法</p><span className="small">消息仅在当前会议内分享</span></div> : null}
                    {s.messages.map((msg, i) => (
                      <div key={msg.messageId || msg.tid || i}>
                        <small className="sub">
                          {msg.sender?.name || msg.sender?.id || "参会人"}
                        </small>
                        <div className="bubble">
                          {String(msg.content?.content || "")}
                        </div>
                      </div>
                    ))}
                  </div>
                  <form className="meeting-chat-composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(async () => {
                        await s.send(text);
                        setText("");
                      });
                    }}
                  >
                    <input
                      aria-label="会议消息"
                      placeholder="发送会议消息…"
                      maxLength={2000}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                    />
                    <button
                      className="primary"
                      disabled={busy || !s.chatReady || !text.trim()}
                    >
                      发送
                    </button>
                  </form>
                </>
              )}
            </aside>
          ) : null}
        </div>
        <footer className="room-bottom">
          <span className="room-code"><span className="sub">会议号</span><strong>{m.code}</strong></span>
          <button
            className={`control ${s.mic ? "" : "off"}`}
            disabled={busy || s.phase !== "joined"}
            onClick={() => void run(() => s.toggleDevice("mic"))}
          >
            <Icon name="mic" off={!s.mic} />
            {s.mic ? "静音" : "解除静音"}
          </button>
          <button
            className={`control ${s.camera ? "" : "off"}`}
            disabled={busy || s.phase !== "joined"}
            onClick={() => void run(() => s.toggleDevice("camera"))}
          >
            <Icon off={!s.camera} />
            {s.camera ? "关闭视频" : "开启视频"}
          </button>
          <button
            className="control"
            aria-pressed={s.tiles.some((t) => t.id === "share")}
            disabled={busy || s.phase !== "joined"}
            onClick={(event) => {
              const devices = event.currentTarget.ownerDocument.defaultView?.navigator.mediaDevices;
              void run(() => s.toggleShare(devices));
            }}
          >
            <Icon name="screen" />
            {s.tiles.some((t) => t.id === "share") ? "停止共享" : "共享屏幕"}
          </button>
          <button className="control" onClick={() => setInvite(true)}>
            <Icon name="plus" />
            邀请
          </button>
          <button
            className="control"
            aria-pressed={panel === "members"}
            onClick={() => setPanel(panel === "members" ? null : "members")}
          >
            <Icon name="users" />
            成员
          </button>
          <button
            className="control"
            aria-pressed={panel === "chat"}
            onClick={() => setPanel(panel === "chat" ? null : "chat")}
          >
            <Icon name="chat" />
            聊天
          </button>
          <button
            className="danger"
            disabled={s.phase !== "joined"}
            onClick={() => setLeaving(true)}
          >
            离开会议
          </button>
        </footer>
      </section>
    </div>
  );
  return (
    <>
      {s.tiles.filter(t => t.id !== "local" && t.id !== "share").map(tile =>
        <RemoteAudio key={tile.id} tile={tile} onBlocked={onAudioBlocked} />
      )}
      {popup && !popup.closed
        ? createPortal(content, popup.document.body)
        : null}
      {miniPopup && !miniPopup.closed ? createPortal(compactContent, miniPopup.document.body) : null}
      {invite ? (
        <MeetingInvitePicker
          ownerDocument={popup?.document}
          contacts={contacts.filter((c) => c.user_id !== uid && !m.participants[c.user_id] && c.conversationType !== 2)}
          busy={busy}
          error={message}
          onClose={() => { if (!busy) setInvite(false); }}
          onInvite={(ids) => void run(async () => {
            const eligible = ids.filter((id) => !useMeetingStore.getState().meeting?.participants[id]);
            if (!eligible.length) throw new Error("所选成员已在会议中");
            await meetingAPI.invite(m.id, eligible);
            await meetingAPI.notify(m.id);
            setInvite(false);
          })}
        />
      ) : null}
      {leaving ? (
        <MeetingDialog
          ownerDocument={popup?.document}
          title={m.hostId === uid ? "结束或离开会议" : "离开会议"}
          onClose={() => {
            if (!busy) setLeaving(false);
          }}
        >
          <p className="sub">
            {m.hostId === uid
              ? "仅自己离开会自动将主持权交给其他在会成员；全员结束会断开所有参会者。"
              : "离开后，仍可在会议进行期间重新加入。"}
          </p>
          {message ? (
            <p className="error" role="alert">
              {message}
            </p>
          ) : null}
          <div className="modal-foot">
            <button disabled={busy} onClick={() => setLeaving(false)}>
              继续会议
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await s.leave(false);
                  setLeaving(false);
                })
              }
            >
              仅自己离开
            </button>
            {m.hostId === uid ? (
              <button
                className="danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await s.leave(true);
                    setLeaving(false);
                  })
                }
              >
                确认全员结束
              </button>
            ) : null}
          </div>
        </MeetingDialog>
      ) : null}
    </>
  );
}
