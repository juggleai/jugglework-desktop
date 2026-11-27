import { useEffect, useState } from "react";
import { MeetingIcon as Icon } from "./meeting-icons";
import { followSharer, setDocZoom, stopDocShare, useDocShareStore } from "./doc-share-controller";
import type { MeetingShare } from "./types";

/** 文档共享状态条：独立占据舞台上方一行，不悬浮在原生文档之上。 */
export function MeetingShareBar({ share, selfId, sharerName, onChange, onError }: {
  share: MeetingShare; selfId: string; sharerName: string; onChange: () => void; onError: (message: string) => void;
}) {
  const { mode, interrupted, relation, zoom, sharerElsewhere, view } = useDocShareStore();
  const mine = share.userId === selfId;
  const [, tick] = useState(0);
  useEffect(() => { const timer = setInterval(() => tick(n => n + 1), 5_000); return () => clearInterval(timer); }, []);
  const where = sharerElsewhere ? "共享人已切换文档"
    : relation && relation.direction !== "visible" && relation.direction !== "missing"
      ? `共享人在${relation.heading ? `「${relation.heading}」` : "文档中"}${relation.direction === "above" ? "↑" : "↓"}`
      : "";
  return <div className="doc-share-bar" role="status">
    <span className="doc-share-who"><span className="avatar-dot">{sharerName.slice(0, 1)}</span>{mine ? "你正在共享" : `${sharerName} 正在共享`}</span>
    {mine ? null : <span className="doc-share-badge" data-mode={interrupted ? "interrupted" : mode}>
      {interrupted ? "位置同步已中断" : mode === "following" ? "跟随中" : "自由浏览中"}</span>}
    {!mine && mode === "free" && where ? <button className="ghost doc-share-where" onClick={followSharer}>{where}</button> : null}
    <span className="doc-share-spacer" />
    <span className="doc-share-zoom" aria-label="本地缩放">
      <button className="ghost icon-button" aria-label="缩小" disabled={view.phase !== "ready"} onClick={() => setDocZoom(zoom - 0.25)}>−</button>
      <span>{Math.round(zoom * 100)}%</span>
      <button className="ghost icon-button" aria-label="放大" disabled={view.phase !== "ready"} onClick={() => setDocZoom(zoom + 0.25)}>+</button>
    </span>
    {mine
      ? <><button onClick={onChange}>更换文档</button>
        <button className="danger" onClick={() => void stopDocShare().catch(e => onError(e instanceof Error ? e.message : "停止共享失败"))}><Icon name="screen" off width={14} height={14} />停止共享</button></>
      : <>{mode === "free" ? <button className="primary" onClick={followSharer}>跟随共享人</button> : null}
        <button onClick={onChange}>成为共享人</button></>}
  </div>;
}
