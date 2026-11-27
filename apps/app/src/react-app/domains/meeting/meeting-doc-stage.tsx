import { useEffect, useRef } from "react";
import { hasCloudDocsOccluder } from "../cloud-docs/cloud-docs-visibility";
import { useDocShareStore } from "./doc-share-controller";

/**
 * 会议窗口里的文档舞台占位。原生 Docs 视图盖在窗口所有界面元素之上，
 * 因此这里只负责测量位置；弹窗出现时让出原生层，避免遮住弹窗。
 */
export function MeetingDocStage({ ownerDocument }: { ownerDocument?: Document }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useDocShareStore(state => state.view);
  const instanceId = view.phase === "ready" ? view.instanceId : "";
  useEffect(() => {
    const bridge = window.__JUGGLEWORK_ELECTRON__?.cloudDocs;
    const element = host.current;
    if (!bridge || !element || !instanceId) return;
    const doc = ownerDocument ?? document;
    const sync = () => {
      const rect = element.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && !doc.hidden && !hasCloudDocsOccluder(rect, doc);
      bridge.setBounds({ instanceId, x: rect.x, y: rect.y, width: rect.width, height: rect.height, borderRadius: 12, visible });
    };
    const resize = new ResizeObserver(sync);
    resize.observe(element);
    const mutation = new MutationObserver(sync);
    mutation.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-modal"] });
    const win = doc.defaultView ?? window;
    win.addEventListener("resize", sync);
    doc.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      resize.disconnect(); mutation.disconnect();
      win.removeEventListener("resize", sync);
      doc.removeEventListener("visibilitychange", sync);
      bridge.setBounds({ instanceId, x: 0, y: 0, width: 0, height: 0, borderRadius: 0, visible: false });
    };
  }, [instanceId, ownerDocument]);

  return <div className="doc-stage" ref={host} data-phase={view.phase}>
    {view.phase === "opening" ? <div className="doc-stage-note" role="status">正在打开文档…</div> : null}
    {view.phase === "denied" ? <div className="doc-stage-note" role="alert">
      <strong>你没有该文档的访问权限</strong><span>可请共享人改用 JuggleWork 窗口共享</span></div> : null}
  </div>;
}
