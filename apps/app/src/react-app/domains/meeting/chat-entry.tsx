import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ChatConversation, ChatMessage } from "../jugglechat/types";
import { meetingAPI } from "./api";
import { meetingClosed, meetingStatusLabel, type Meeting } from "./types";
import { MeetingIcon } from "./meeting-icons";
function dispatchMeeting(detail: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent("meeting:open", { detail }));
}
export function MeetingChatEntry({
  conversation,
}: {
  conversation: ChatConversation;
}) {
  const navigate = useNavigate();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      const from = new Date(Date.now() - 86400000),
        to = new Date(Date.now() + 86400000);
      void meetingAPI
        .list(from, to)
        .then((r) => {
          if (alive)
            setMeetings(
              r.meetings.filter(
                (m) =>
                  m.sourceId === conversation.conversationId &&
                  m.sourceKind ===
                    (conversation.conversationType === 2
                      ? "group"
                      : "direct") &&
                  m.status === "live",
              ),
            );
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [conversation.conversationId, conversation.conversationType]);
  return (
    <>
      <button
        type="button"
        className="tool btn btn-icon btn-light"
        aria-label="发起会议"
        title="发起会议"
        onClick={() => {
          navigate("/meetings");
          dispatchMeeting({
            sourceKind:
              conversation.conversationType === 2 ? "group" : "direct",
            sourceId: conversation.conversationId,
            title: `${conversation.conversationTitle || "会话"}的会议`,
          });
        }}
      >
        <MeetingIcon />
      </button>
      {meetings.length ? (
        <button
          type="button"
          onClick={() => {
            navigate("/meetings");
            dispatchMeeting({ meetingId: meetings[0].id });
          }}
        >
          加入会议{meetings.length > 1 ? `（${meetings.length} 场进行中）` : ""}
        </button>
      ) : null}
    </>
  );
}
export function MeetingMessageCard({ message }: { message: ChatMessage }) {
  const navigate = useNavigate();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [error, setError] = useState("");
  const id = String(message.content?.meetingId || "");
  useEffect(() => {
    if (!id) return;
    let alive = true;
    void meetingAPI
      .get(id)
      .then((r) => {
        if (alive) setMeeting(r.meeting);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 16,
        width: 280,
        maxWidth: "100%",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <MeetingIcon />
        <strong>
          {meeting?.title || String(message.content?.title || "会议邀请")}
        </strong>
      </div>
      <p style={{ fontSize: 12, opacity: 0.65, margin: "12px 0" }}>
        {meeting ? meetingStatusLabel(meeting) : "点击获取最新会议状态"}
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <button
        type="button"
        disabled={meeting ? meetingClosed(meeting) : !id}
        style={{
          borderRadius: 8,
          padding: "8px 15px",
          border: "1px solid var(--border)",
          width: "100%",
        }}
        onClick={() => {
          void meetingAPI
            .get(id)
            .then((r) => {
              setMeeting(r.meeting);
              if (meetingClosed(r.meeting)) {
                setError("会议已结束或取消");
                return;
              }
              navigate("/meetings");
              dispatchMeeting({ meetingId: id });
            })
            .catch((e) => setError(e.message));
        }}
      >
        加入会议
      </button>
    </div>
  );
}
