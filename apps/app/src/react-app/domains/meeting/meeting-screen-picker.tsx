import { useEffect, useRef, useState } from "react";
import type { MeetingScreenSource } from "@jugglework/types/desktop-ipc";
import { listMeetingScreenSources, chooseMeetingScreenSource } from "@/app/lib/desktop";
import { MeetingDialog } from "./meeting-page";
import { MeetingIcon as Icon } from "./meeting-icons";

import { MeetingPermissionNotice, MeetingPermissionRestart } from "./permission-notice";
import { ensureMeetingPermission } from "./media-permission";

async function listSharedScreens(requestId: string) {
  await ensureMeetingPermission("screen");
  return listMeetingScreenSources(requestId);
}

export function MeetingScreenPicker({ requestId, ownerDocument, onClose,
  listSources = listSharedScreens, chooseSource = chooseMeetingScreenSource,
}: { requestId: string; ownerDocument?: Document; onClose: () => void;
  listSources?: typeof listMeetingScreenSources; chooseSource?: typeof chooseMeetingScreenSource }) {
  const [sources, setSources] = useState<MeetingScreenSource[]>([]);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const filtersRef = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState({ left: false, right: false });
  useEffect(() => {
    const rail = filtersRef.current;
    if (!rail) return;
    const update = () => setScrollable({ left: rail.scrollLeft > 1, right: rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 1 });
    const observer = new ResizeObserver(update);
    observer.observe(rail);
    rail.addEventListener("scroll", update, { passive: true });
    update();
    return () => { observer.disconnect(); rail.removeEventListener("scroll", update); };
  }, [sources]);
  function scrollFilters(direction: number) {
    const rail = filtersRef.current;
    if (rail) rail.scrollBy({ left: direction * Math.max(144, rail.clientWidth * .75), behavior: "smooth" });
  }
  async function refresh() {
    const sequence = ++generation.current;
    setLoading(true); setError("");
    try {
      const next = await listSources(requestId);
      if (sequence !== generation.current) return;
      setSources(next);
      setSelected(previous => next.some(source => source.id === previous) ? previous : "");
      setFilter(previous => ["all", "screen", "window"].includes(previous) || next.some(source => source.appKey === previous) ? previous : "all");
    } catch (cause) {
      if (sequence === generation.current) {
        setSources([]);
        setSelected("");
        setError(cause instanceof Error ? cause.message : "无法获取共享画面，请重试。");
      }
    } finally { if (sequence === generation.current) setLoading(false); }
  }
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, [requestId]);
  const apps = [...new Map(sources.filter(source => source.appKey).map(source => [source.appKey, source])).values()];
  const visible = sources.filter(source => filter === "all" || source.kind === filter || source.appKey === filter);
  const selection = sources.find(source => source.id === selected);
  function changeFilter(value: string) { setFilter(value); setSelected(""); }
  async function confirm() {
    if (!selection || submitting || loading) return;
    setSubmitting(true); setError("");
    try { if (await chooseSource(requestId, selection.id)) onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法开始共享，请重试。"); }
    finally { setSubmitting(false); }
  }
  return <MeetingDialog title="桌面与窗口" className="meeting-screen-dialog" ownerDocument={ownerDocument} onClose={onClose}>
    <p className="screen-picker-hint">选择要共享的画面，其他参会者将只能看到你选择的内容</p>
    <div className="screen-filter-row">
      <button className="ghost icon-button screen-filter-nav" aria-label="向左浏览应用" disabled={!scrollable.left} onClick={() => scrollFilters(-1)}><Icon name="chevronLeft" /></button>
      <div className="screen-filters" ref={filtersRef} role="group" aria-label="共享内容筛选">
        {([{ key: "all", name: "全部", icon: "grid" }, { key: "screen", name: "桌面", icon: "monitor" },
          { key: "window", name: "窗口", icon: "window" }] as const).map(item =>
          <button key={item.key} className="screen-filter" aria-pressed={filter === item.key} onClick={() => changeFilter(item.key)}>
            <span className="screen-filter-icon"><Icon name={item.icon} /></span><span className="screen-filter-label">{item.name}</span>
          </button>)}
        {apps.map(app => {
          const label = sources.filter(source => source.appKey === app.appKey).map(source => source.name).join("、");
          return <button key={app.appKey} className="screen-filter app-filter" title={label} aria-label={`筛选窗口：${label}`}
            aria-pressed={filter === app.appKey} onClick={() => changeFilter(app.appKey)}>
            <span className="screen-filter-icon"><img src={app.appIcon} alt="" /></span>
          </button>;
        })}
      </div>
      <button className="ghost icon-button screen-filter-nav" aria-label="向右浏览应用" disabled={!scrollable.right} onClick={() => scrollFilters(1)}><Icon name="chevronRight" /></button>
      <button className="ghost icon-button screen-filter-nav" aria-label="刷新共享列表" disabled={loading || submitting} onClick={() => void refresh()}><Icon name="refresh" /></button>
    </div>
    <div className="screen-source-list" aria-busy={loading}>
      {loading && !sources.length ? <div className="screen-picker-empty" role="status"><Icon name="monitor" /><span>正在获取可共享的画面…</span></div> :
        !visible.length ? <div className="screen-picker-empty"><Icon name="window" /><span>{error ? "暂时无法获取画面" : "没有可共享的窗口"}</span><small>打开需要共享的窗口后，点击右上角刷新</small></div> :
        <div className="screen-source-grid" role="group" aria-label="选择共享画面">{visible.map(source =>
          <button key={source.id} className="screen-source" aria-pressed={selected === source.id} disabled={loading || submitting}
            onClick={() => setSelected(source.id)} title={source.name}>
            <span className="screen-source-preview">
              {source.thumbnail ? <img className="screen-thumbnail" src={source.thumbnail} alt="" /> : <span className="screen-preview-unavailable"><Icon name={source.kind === "screen" ? "monitor" : "window"} />预览不可用</span>}
              <span className="screen-source-badge">{source.appIcon ? <img src={source.appIcon} alt="" /> : <Icon name={source.kind === "screen" ? "monitor" : "window"} />}</span>
              <span className="screen-source-check"><Icon name="check" /></span>
            </span><span className="screen-source-name">{source.name}</span>
          </button>)}</div>}
    </div>
    {error ? <MeetingPermissionNotice message={error} onClose={() => setError("")} /> :
      <div className="screen-picker-status" role="status">{loading ? "正在刷新…" : ""}</div>}
    <MeetingPermissionRestart />
    <div className="modal-foot screen-picker-foot"><span title={selection?.name}>{selection ? `已选择：${selection.name}` : "请选择一个桌面或窗口"}</span>
      <button onClick={onClose}>取消</button><button className="primary" disabled={!selection || loading || submitting} onClick={() => void confirm()}>{submitting ? "正在共享…" : "开始共享"}</button>
    </div>
  </MeetingDialog>;
}
