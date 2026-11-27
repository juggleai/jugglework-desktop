import { useEffect, useRef, useState } from "react";
import { MeetingIcon as Icon } from "./meeting-icons";
import { withProductView } from "../cloud-docs/product-view";
import { readDenSettings } from "@/app/lib/den";

type DocItem = { workspaceId: string; docId: string; title: string; updatedAt: string; scope?: string; contentKind?: string };
const SUPPORTED = new Set(["document", "whiteboard"]);

function formatTime(value: string) {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  const days = Math.floor((Date.now() - at.getTime()) / 86_400_000);
  if (days < 1) return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return days < 7 ? `${days} 天前` : at.toLocaleDateString();
}

/** 「云文档」页：最近访问与标题检索，只列出会议组织内可读的文档。 */
export function MeetingDocPicker({ onClose, onConfirm }: { onClose: () => void; onConfirm?: (workspaceId: string, docId: string) => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<DocItem[]>([]);
  const [selected, setSelected] = useState<DocItem | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error" | "unavailable">("loading");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  useEffect(() => {
    const bridge = window.__JUGGLEWORK_ELECTRON__?.cloudDocs;
    const tenantId = readDenSettings().activeOrgId;
    if (!bridge || !tenantId) { setState("unavailable"); return; }
    const run = ++sequence.current;
    setState("loading");
    const timer = setTimeout(() => {
      const q = query.trim();
      void withProductView(bridge, tenantId, instanceId => bridge.api({
        instanceId, requestId: crypto.randomUUID(), op: q ? "docs-search" : "docs-recent", params: q ? { q, limit: 20 } : { limit: 20 },
      })).then(result => {
        if (run !== sequence.current) return;
        if (result.status !== 200) throw new Error("docs_unavailable");
        setItems(((result.body as { items?: DocItem[] }).items ?? []).slice(0, 20));
        setState("ready");
      }).catch(() => { if (run === sequence.current) { setItems([]); setState("error"); } });
    }, query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [query]);
  async function confirm() {
    if (!selected || !onConfirm || submitting) return;
    setSubmitting(true); setError("");
    try { await onConfirm(selected.workspaceId, selected.docId); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法共享所选文档，请重试。"); }
    finally { setSubmitting(false); }
  }
  return <>
    <input className="doc-picker-search" aria-label="搜索云文档" placeholder="搜索当前组织的云文档" value={query}
      disabled={state === "unavailable"} onChange={event => { setQuery(event.target.value); setSelected(null); }} />
    <div className="screen-source-list doc-picker-list" aria-busy={state === "loading"}>
      {state === "unavailable" ? <div className="screen-picker-empty" role="status"><Icon name="window" /><span>当前组织未开通云文档</span></div>
        : state === "error" ? <div className="screen-picker-empty" role="alert"><Icon name="window" /><span>云文档暂时无法加载</span><small>请稍后重试</small></div>
        : state === "loading" && !items.length ? <div className="screen-picker-empty" role="status"><span>正在加载…</span></div>
        : !items.length ? <div className="screen-picker-empty"><Icon name="window" /><span>{query ? "无匹配云文档" : "暂无最近文档"}</span></div>
        : <ul className="doc-picker-items" role="listbox" aria-label="云文档">{items.map(item => {
          const supported = !item.contentKind || SUPPORTED.has(item.contentKind);
          const key = `${item.workspaceId}/${item.docId}`;
          return <li key={key}>
            <button role="option" aria-selected={selected?.docId === item.docId && selected.workspaceId === item.workspaceId}
              disabled={!supported || submitting} onClick={() => setSelected(item)}>
              <span className="doc-picker-title">{item.title || "无标题"}</span>
              <small>{formatTime(item.updatedAt)} · {item.scope === "private" ? "私有" : "组织"}</small>
              {supported ? <span className="doc-picker-check"><Icon name="check" /></span> : <span className="doc-picker-note">暂不支持</span>}
            </button>
          </li>;
        })}</ul>}
    </div>
    {error ? <div className="screen-picker-status" role="alert">{error}</div> : <div className="screen-picker-hint doc-picker-hint">参会者将用自己的权限打开该文档，可跟随你浏览，也可自由浏览</div>}
    <div className="modal-foot screen-picker-foot"><span title={selected?.title}>{selected ? `已选择：${selected.title || "无标题"}` : "请选择一篇文档"}</span>
      <button onClick={onClose}>取消</button>
      <button className="primary" disabled={!selected || submitting || !onConfirm} onClick={() => void confirm()}>{submitting ? "正在共享…" : "开始共享"}</button>
    </div>
  </>;
}
