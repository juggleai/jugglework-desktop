import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDenAuth } from "../cloud/den-auth-provider";
import { meetingAPI } from "./api";
import type { Meeting } from "./types";
import { MeetingIcon } from "./meeting-icons";

// In-app reminders work while Desktop is running. No OS notification permission
// is requested, and dismissed reminders are scoped to this account/organization.
export function MeetingReminderHost() {
  const { user, activeOrganization } = useDenAuth();
  const [reminder, setReminder] = useState<Meeting | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    setReminder(null);
    if (!user?.id || !activeOrganization?.id) return;
    let alive = true;
    const seen = new Set<string>();
    const poll = async () => {
      try {
        const now = Date.now();
        const { meetings } = await meetingAPI.list(
          new Date(now - 300000),
          new Date(now + 300000),
        );
        if (!alive) return;
        setReminder((current) => {
          if (!current) return null;
          const fresh = meetings.find((m) => m.id === current.id);
          return fresh?.status === "scheduled" && fresh.startAt === current.startAt ? fresh : null;
        });
        const next = meetings.find((m) => {
          const at = Date.parse(m.startAt);
          const key = `meeting.reminder:${activeOrganization.id}:${user.id}:${m.id}:${m.startAt}`;
          return (
            m.status === "scheduled" &&
            at >= now - 300000 &&
            at <= now + 300000 &&
            (m.organizerId === user.id || m.invites[user.id] === "accepted") &&
            !seen.has(key) &&
            sessionStorage.getItem(key) !== "shown"
          );
        });
        if (next) {
          const key = `meeting.reminder:${activeOrganization.id}:${user.id}:${next.id}:${next.startAt}`;
          seen.add(key);
          sessionStorage.setItem(key, "shown");
          setReminder(next);
        }
      } catch {
        /* A reminder failure must not disrupt unrelated work. */
      }
    };
    void poll();
    const changed = () => void poll();
    window.addEventListener("meeting:changed", changed);
    const timer = setInterval(changed, 30000);
    return () => {
      alive = false;
      window.removeEventListener("meeting:changed", changed);
      clearInterval(timer);
    };
  }, [user?.id, activeOrganization?.id]);
  if (!reminder) return null;
  return (
    <aside className="meeting-ui meeting-reminder" role="status">
      <div className="row">
        <MeetingIcon name="calendar" />
        <strong>会议即将开始</strong>
        <button
          className="ghost icon-button"
          aria-label="关闭提醒"
          onClick={() => setReminder(null)}
        >
          <MeetingIcon name="close" />
        </button>
      </div>
      <p>{reminder.title}</p>
      <p className="sub small">{new Date(reminder.startAt).toLocaleString()}</p>
      <button
        className="primary"
        onClick={() => {
          navigate("/meetings");
          window.dispatchEvent(
            new CustomEvent("meeting:open", {
              detail: { meetingId: reminder.id },
            }),
          );
          setReminder(null);
        }}
      >
        查看并加入
      </button>
    </aside>
  );
}
