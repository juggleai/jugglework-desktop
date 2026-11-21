import { useEffect, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { useDenAuth } from "../cloud/den-auth-provider";
import { meetingAPI, MeetingRequestError } from "./api";
import { isMeetingRequestScopeCurrent, useMeetingRequestScope } from "./meeting-request-scope";
import type { Meeting } from "./types";
import { MeetingIcon } from "./meeting-icons";
import { readMeetingPreferences, subscribeMeetingPreferences } from "./meeting-preferences";

const remindersEnabled = () => readMeetingPreferences().meetingReminders;

// In-app reminders work while Desktop is running. No OS notification permission
// is requested, and dismissed reminders are scoped to this account/organization.
export function MeetingReminderHost() {
  const { user, activeOrganization } = useDenAuth();
  const scope = useMeetingRequestScope();
  const enabled = useSyncExternalStore(subscribeMeetingPreferences, remindersEnabled, remindersEnabled);
  if (!enabled || !scope || !user?.id || !activeOrganization?.id) return null;
  return <ScheduledMeetingReminder key={scope} scope={scope} orgId={activeOrganization.id} userId={user.id} />;
}

function ScheduledMeetingReminder({ scope, orgId, userId }: { scope: string; orgId: string; userId: string }) {
  const [reminder, setReminder] = useState<Meeting | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    let forbidden = false;
    const seen = new Set<string>();
    const isCurrent = () => !controller.signal.aborted && remindersEnabled() && isMeetingRequestScopeCurrent(scope);
    const poll = async () => {
      if (inFlight || forbidden || !isCurrent()) return;
      inFlight = true;
      try {
        const now = Date.now();
        const { meetings } = await meetingAPI.list(
          new Date(now - 300000),
          new Date(now + 300000),
          controller.signal,
        );
        // A preference write can precede React's unsubscribe/cleanup. Do not consume
        // a still-eligible reminder if the in-flight response lands in that gap.
        if (!isCurrent()) return;
        setReminder((current) => {
          if (!current) return null;
          const fresh = meetings.find((m) => m.id === current.id);
          return fresh?.status === "scheduled" && fresh.startAt === current.startAt ? fresh : null;
        });
        const next = meetings.find((m) => {
          const at = Date.parse(m.startAt);
          const key = `meeting.reminder:${orgId}:${userId}:${m.id}:${m.startAt}`;
          return (
            m.status === "scheduled" &&
            at >= now - 300000 &&
            at <= now + 300000 &&
            (m.organizerId === userId || m.invites[userId] === "accepted") &&
            !seen.has(key) &&
            sessionStorage.getItem(key) !== "shown"
          );
        });
        if (next) {
          const key = `meeting.reminder:${orgId}:${userId}:${next.id}:${next.startAt}`;
          seen.add(key);
          sessionStorage.setItem(key, "shown");
          setReminder(next);
        }
      } catch (error) {
        if (isCurrent() && error instanceof MeetingRequestError && error.status === 403) {
          forbidden = true;
          clearInterval(timer);
          setReminder(null);
        }
      } finally {
        inFlight = false;
      }
    };
    const changed = () => void poll();
    window.addEventListener("meeting:changed", changed);
    const timer = setInterval(changed, 30000);
    void Promise.resolve().then(changed);
    return () => {
      controller.abort();
      window.removeEventListener("meeting:changed", changed);
      clearInterval(timer);
    };
  }, [scope, userId, orgId]);
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
