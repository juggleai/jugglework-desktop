import * as React from "react";
import { hasNativeBrowserOccluder } from "../session/panel/utils";

/** 原生页位于 DOM 上方；宿主浮窗期间用当前画面垫底，避免菜单被遮挡或整个文档变白。 */
export function useCloudDocsBounds(host: React.RefObject<HTMLDivElement | null>) {
  const [snapshot, setSnapshot] = React.useState<string | null>(null);
  const frozen = React.useRef<{ id: string; loaded: boolean } | null>(null);
  const latest = React.useRef<{ instanceId: string; ready: boolean; active: boolean } | null>(null);
  const sync = React.useCallback((instanceId: string, ready: boolean, active = true) => {
    latest.current = { instanceId, ready, active };
    const bridge = window.__JUGGLEWORK_ELECTRON__?.cloudDocs;
    const rect = host.current?.getBoundingClientRect();
    if (!bridge || !rect) return;
    const visible = ready && active && !document.hidden && rect.width > 0 && rect.height > 0;
    const overlay = visible && hasNativeBrowserOccluder();
    const bounds = (show: boolean) => bridge.setBounds({ instanceId, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: show });
    if (overlay) {
      if (frozen.current?.id === instanceId) {
        if (frozen.current.loaded) bounds(false);
        return;
      }
      const frame = { id: instanceId, loaded: false };
      frozen.current = frame;
      void bridge.snapshot(instanceId).then(image => {
        if (frozen.current !== frame) return;
        if (image) setSnapshot(image);
        else { frame.loaded = true; bounds(false); }
      }).catch(() => { if (frozen.current === frame) { frame.loaded = true; bounds(false); } });
      return;
    }
    frozen.current = null;
    setSnapshot(null);
    bounds(visible);
  }, [host]);
  const loaded = React.useCallback(() => {
    if (frozen.current) frozen.current.loaded = true;
    const current = latest.current;
    if (current) sync(current.instanceId, current.ready, current.active);
  }, [sync]);
  return { snapshot, loaded, sync };
}
