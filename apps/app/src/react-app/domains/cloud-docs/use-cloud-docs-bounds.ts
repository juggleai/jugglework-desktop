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
    const element = host.current;
    const rect = element?.getBoundingClientRect();
    if (!bridge || !rect || !element) return;
    // TIPS: 原生视图不受 DOM 的圆角裁切，需将宿主的实际圆角同步给 Electron。
    const borderRadius = parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
    const visible = ready && active && !document.hidden && rect.width > 0 && rect.height > 0;
    const overlay = visible && hasNativeBrowserOccluder(true);
    const bounds = (show: boolean) => bridge.setBounds({ instanceId, x: rect.x, y: rect.y, width: rect.width, height: rect.height, borderRadius, visible: show });
    if (overlay) {
      if (frozen.current?.id === instanceId) {
        if (frozen.current.loaded) bounds(false);
        return;
      }
      const frame = { id: instanceId, loaded: false };
      frozen.current = frame;
      // TIPS: 初次点击导航时提示仍打开；先显示原生页产生画面，隐藏视图不能 capturePage。
      bounds(true);
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
