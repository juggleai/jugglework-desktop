import { useState } from "react";
import type { ChatContact } from "../jugglechat/types";
import { MeetingDialog } from "./meeting-page";
import { MeetingIcon as Icon } from "./meeting-icons";

const label = (c: ChatContact) => c.friend_display_name || c.nickname || c.user_id;

export function MeetingMemberAvatar({ contact }: { contact: ChatContact }) {
  return <span className="avatar person-avatar" aria-hidden="true">{label(contact).slice(0, 1)}
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
  const candidates = [...contacts].sort((a, b) => label(a).localeCompare(label(b), "zh-CN") || a.user_id.localeCompare(b.user_id))
    .filter(c => label(c).toLowerCase().includes(query.trim().toLowerCase()));
  const toggle = (id: string) => setSelected((list) => list.includes(id) ? list.filter((v) => v !== id) : [...list, id]);
  return <MeetingDialog title="邀请参会" onClose={onClose} ownerDocument={ownerDocument}>
    <div className="invite-search">
      <Icon name="search" width={16} height={16} />
      <input aria-label="搜索成员" placeholder="搜索成员姓名或备注" value={query} onChange={e => setQuery(e.target.value)} />
      {query ? <button type="button" className="ghost icon-button" aria-label="清空搜索" onClick={() => setQuery("")}><Icon name="close" width={16} height={16} /></button> : null}
    </div>
    <div className="meeting-invite-layout">
      <div className="invite-candidates">
        <div className="invite-selection-heading"><h3>选择成员</h3><span className="sub small">{candidates.length} 人</span></div>
        <div className="invite-list">
          {candidates.map(c => <label className="invite-person" key={c.user_id}>
            <MeetingMemberAvatar contact={c} /><span className="invite-person-name" title={label(c)}>{label(c)}</span>
            <input type="checkbox" checked={selected.includes(c.user_id)} disabled={busy} onChange={() => toggle(c.user_id)} />
          </label>)}
          {!candidates.length ? <div className="invite-empty"><Icon name="search" width={24} height={24} /><p>{query ? "没有找到匹配的成员" : "暂无可邀请成员"}</p></div> : null}
        </div>
      </div>
      <div className="invite-selected">
        <div className="invite-selection-heading"><h3 aria-live="polite">已选成员（{chosen.length}）</h3><button type="button" className="ghost invite-clear" disabled={busy || !chosen.length} onClick={() => setSelected([])}>清空</button></div>
        <div className="invite-list">
          {chosen.length ? chosen.map(c => <div className="invite-person" key={c.user_id}>
            <MeetingMemberAvatar contact={c} /><span className="invite-person-name" title={label(c)}>{label(c)}</span>
            <button type="button" className="ghost icon-button" disabled={busy} aria-label={`移除 ${label(c)}`} onClick={() => toggle(c.user_id)}><Icon name="close" width={15} height={15} /></button>
          </div>) : <div className="invite-empty"><span className="invite-empty-icon"><Icon name="users" width={24} height={24} /></span><p>从左侧选择成员</p></div>}
        </div>
      </div>
    </div>
    <p className={`invite-feedback ${error ? "error" : "sub"}`} role={error ? "alert" : undefined}>{error || "受邀成员将收到会议邀请卡片。"}</p>
    <div className="modal-foot">
      <button disabled={busy} onClick={onClose}>取消</button>
      <button className="primary" disabled={busy || !chosen.length} onClick={() => onInvite(chosen.map(c => c.user_id))}>{busy ? "正在邀请…" : "发送邀请"}</button>
    </div>
  </MeetingDialog>;
}
