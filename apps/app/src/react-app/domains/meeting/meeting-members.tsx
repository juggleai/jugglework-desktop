import { MeetingIcon } from "./meeting-icons";
import { useMeetingStore } from "./store";
import { useEffect, useRef, useState } from "react";
import { getGroupMembers } from "../jugglechat/api";
import type { ChatContact } from "../jugglechat/types";
import { meetingAPI } from "./api";
import { sendMeetingInvitation } from "./im-adapter";
import { MeetingMemberAvatar } from "./meeting-invite-picker";
import type { Meeting } from "./types";

export function MeetingMembers({ meeting, contacts, userId, onTransfer, busy }: {
  meeting: Meeting; contacts: ChatContact[]; userId: string;
  onTransfer: (id: string) => void; busy: boolean;
}) {
  const devices = useMeetingStore(s => s.memberDevices);
  const localMic = useMeetingStore(s => s.mic);
  const [tab, setTab] = useState<"joined" | "absent">("joined");
  const [query, setQuery] = useState("");
  const [groupMembers, setGroupMembers] = useState<ChatContact[]>([]);
  const [groupError, setGroupError] = useState(false);
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const pending = useRef(new Set<string>());
  const current = useRef(meeting);
  current.current = meeting;
  useEffect(() => {
    let alive = true;
    if (meeting.sourceKind === "group") {
      void getGroupMembers(meeting.sourceId).then((r) => {
        if (alive) setGroupMembers(r.data.items.map((c) => ({
          user_id: c.user_id || c.id || "", nickname: c.nickname || c.name,
          avatar: c.avatar || c.portrait,
        })));
      }).catch(() => { if (alive) setGroupError(true); });
    }
    return () => { alive = false; };
  }, [meeting.id, meeting.sourceId, meeting.sourceKind]);
  const directory = new Map(contacts.filter(c => c.conversationType !== 2).map(c => [c.user_id, c]));
  for (const c of groupMembers) directory.set(c.user_id, c);
  const name = (id: string) => directory.get(id)?.friend_display_name || directory.get(id)?.nickname || meeting.participants[id]?.name || id;
  const joined = Object.keys(meeting.participants).sort((a, b) => a.localeCompare(b));
  const candidates = meeting.sourceKind === "group" ? groupMembers : contacts.filter(c => c.conversationType !== 2);
  const absent = [...new Set([...candidates.map(c => c.user_id), ...Object.keys(meeting.invites)])]
    .filter(id => id && id !== userId && !meeting.participants[id]).sort((a, b) => a.localeCompare(b));
  const visible = (tab === "joined" ? joined : absent).filter(id => name(id).toLowerCase().includes(query.trim().toLowerCase()));
  async function invite(id: string) {
    if (pending.current.has(id) || current.current.participants[id]) return;
    pending.current.add(id);
    setSending(v => ({ ...v, [id]: true }));
    setFeedback(v => ({ ...v, [id]: "" }));
    try {
      const { meeting: updated } = await meetingAPI.invite(meeting.id, [id]);
      if (current.current.participants[id]) return;
      await sendMeetingInvitation(updated, id);
      setFeedback(v => ({ ...v, [id]: "邀请已发送" }));
    } catch (e) {
      setFeedback(v => ({ ...v, [id]: e instanceof Error ? e.message : "邀请失败，请重试" }));
    } finally {
      pending.current.delete(id);
      setSending(v => ({ ...v, [id]: false }));
    }
  }
  return <div className="meeting-members">
    <div className="member-tabs" role="group" aria-label="参会状态">
      <button aria-pressed={tab === "joined"} onClick={() => setTab("joined")}>已入会 <span>{joined.length}</span></button>
      <button aria-pressed={tab === "absent"} onClick={() => setTab("absent")}>未参会 <span>{absent.length}</span></button>
    </div>
    <input aria-label="搜索参会成员" placeholder="搜索成员" value={query} onChange={e => setQuery(e.target.value)} />
    <div className="member-list">
      {visible.map(id => {
        const c = directory.get(id) || { user_id: id, nickname: name(id) };
        const status = feedback[id] || (tab === "joined" ? (id === meeting.hostId ? "主持人 · 已入会" : "已入会") : (meeting.invites[id] ? "已邀请 · 未入会" : "未参会"));
        return <div className="member-row" key={id}>
          <span className="member-avatar-status">
            <MeetingMemberAvatar contact={c} />
            {tab === "joined" && (id === userId ? !localMic : devices[id]?.sessionId === meeting.participants[id]?.sessionId && Date.now() - devices[id].receivedAt < 15_000 && !devices[id].mic)
              ? <span className="member-mic-off" title="麦克风已关闭" aria-label="麦克风已关闭"><MeetingIcon name="mic" off width={12} height={12} /></span> : null}
          </span>
          <div className="member-info"><strong title={name(id)}>{name(id)}{id === userId ? "（我）" : ""}</strong><span className="member-status" title={status} aria-live="polite">{status}</span></div>
          {tab === "absent" ? <button className="member-action" disabled={sending[id] || feedback[id] === "邀请已发送"} onClick={() => void invite(id)}>{sending[id] ? "发送中" : feedback[id] === "邀请已发送" ? "已邀请" : "邀请"}</button>
            : meeting.hostId === userId && id !== userId ? <button className="member-action ghost" disabled={busy} onClick={() => onTransfer(id)}>转交主持</button> : <span className="member-presence" aria-label="已入会" />}
        </div>;
      })}
      {!visible.length ? <div className="invite-empty">{query ? "没有匹配的成员" : tab === "joined" ? "暂无入会成员" : "暂无未参会成员"}</div> : null}
    </div>
    {groupError ? <p className="small sub">群成员加载失败，当前仅显示已知受邀成员。</p> : null}
  </div>;
}
