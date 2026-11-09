import { useState } from "react";
import type { ChatContact } from "../jugglechat/types";
import { MeetingDialog } from "./meeting-page";
import { MeetingIcon as Icon } from "./meeting-icons";

const label = (c: ChatContact) => c.friend_display_name || c.nickname || c.user_id;

export function MeetingMemberAvatar({ contact }: { contact: ChatContact }) {
  return <span className="avatar person-avatar">{label(contact).slice(0, 1)}
    {contact.avatar ? <img src={contact.avatar} alt="" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : null}
  </span>;
}

export function MeetingInvitePicker({ contacts, busy, error, onClose, onInvite, ownerDocument }: {
  contacts: ChatContact[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onInvite: (ids: string[]) => void;
  ownerDocument?: Document;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const chosen = selected.flatMap((id) => contacts.find(c => c.user_id === id) || []);
  const groups = new Map<string, ChatContact[]>();
  for (const c of [...contacts].sort((a, b) => label(a).localeCompare(label(b), "zh-CN") || a.user_id.localeCompare(b.user_id)).filter((c) => label(c).toLowerCase().includes(query.trim().toLowerCase()))) {
    const initial = /^[a-z]/i.test(label(c)) ? label(c)[0]!.toUpperCase() : "#";
    groups.set(initial, [...(groups.get(initial) || []), c]);
  }
  const toggle = (id: string) => setSelected((list) => list.includes(id) ? list.filter((v) => v !== id) : [...list, id]);
  return <MeetingDialog title="邀请参会" onClose={onClose} ownerDocument={ownerDocument}>
    <div className="meeting-invite-layout">
      <div className="invite-candidates">
        <div className="invite-search">
          <input aria-label="搜索成员" placeholder="搜索成员" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query ? <button type="button" className="ghost icon-button" aria-label="清空搜索" onClick={() => setQuery("")}><Icon name="close" /></button> : null}
        </div>
        <div className="invite-list">
          {[...groups].sort(([a], [b]) => a === "#" ? 1 : b === "#" ? -1 : a.localeCompare(b)).map(([letter, members]) =>
            <div key={letter}><div className="invite-letter">{letter}</div>{members.map((c) =>
              <label className="invite-person" key={c.user_id}>
                <input type="checkbox" checked={selected.includes(c.user_id)} disabled={busy} onChange={() => toggle(c.user_id)} />
                <MeetingMemberAvatar contact={c} /><span>{label(c)}</span>
              </label>)}</div>)}
          {!groups.size ? <p className="invite-empty">{query ? "没有匹配的成员" : "暂无可邀请成员"}</p> : null}
        </div>
      </div>
      <div className="invite-selected">
        <div className="invite-selection-heading"><h3>已选成员</h3><span className="sub small" aria-live="polite">已选择 {chosen.length} 人</span></div>
        <div className="invite-list">
          {chosen.length ? chosen.map((c) => <div className="invite-person" key={c.user_id}>
            <MeetingMemberAvatar contact={c} /><span>{label(c)}</span>
            <button type="button" className="ghost icon-button" disabled={busy} aria-label={`移除 ${label(c)}`} onClick={() => toggle(c.user_id)}><Icon name="close" width={16} height={16} /></button>
          </div>) : <p className="invite-empty">从左侧选择要邀请的成员</p>}
        </div>
      </div>
    </div>
    <p className="sub small" style={{ marginTop: 12 }}>受邀者将收到会议邀请卡片。</p>
    <p className="invite-feedback error" role={error ? "alert" : undefined}>{error || "\u00a0"}</p>
    <div className="modal-foot">
      <button disabled={busy} onClick={onClose}>取消</button>
      <button className="primary" disabled={busy || !chosen.length} onClick={() => onInvite(chosen.map((c) => c.user_id))}>{busy ? "正在邀请…" : `发送邀请（${chosen.length}）`}</button>
    </div>
  </MeetingDialog>;
}
