import * as React from "react";
import { getResolvedThemeMode } from "@/app/theme";
import { findPositionedRailHint, hasCloudDocsOccluder, intersectsCloudDocs } from "./cloud-docs-visibility";

type FrozenFrame = { id: string; loaded: boolean; image?: string; fallback?: boolean; restoring?: boolean };

/** 原生页位于 DOM 上方；宿主浮窗期间用当前画面垫底，避免菜单被遮挡或整个文档变白。 */
export function useCloudDocsBounds(
  host: React.RefObject<HTMLDivElement | null>,
  onRestored?: (instanceId: string) => void,
  options?: { mirrorRailHints?: boolean },
) {
  const [snapshot, setSnapshot] = React.useState<FrozenFrame | null>(null);
  const frozen = React.useRef<FrozenFrame | null>(null);
  const latest = React.useRef<{ instanceId: string; ready: boolean; active: boolean } | null>(null);
  const suspended = React.useRef<string | null>(null);
  const mirroredHint = React.useRef<{ key: string; instanceId: string } | null>(null);
  const hostRailHint = React.useRef<HTMLElement | null>(null);
  const railGuardOwner = React.useRef<string | null>(null);
  const mirrorRailHints = options?.mirrorRailHints === true;
  const restored = React.useRef(onRestored);
  restored.current = onRestored;
  const clearRailHint = React.useCallback(() => {
    const previous = mirroredHint.current;
    if (!previous) return;
    mirroredHint.current = null;
    window.__JUGGLEWORK_ELECTRON__?.cloudDocs?.setRailHint?.({ instanceId: previous.instanceId, hint: null });
  }, []);
  const allowHostRailHint = React.useCallback((node: HTMLElement | null) => {
    if (hostRailHint.current === node) return;
    hostRailHint.current?.removeAttribute("data-cloud-docs-host-hint");
    hostRailHint.current = node;
    node?.setAttribute("data-cloud-docs-host-hint", "");
  }, []);
  const setRailGuard = React.useCallback((instanceId: string | null) => {
    if (railGuardOwner.current === instanceId) return;
    const root = document.documentElement;
    if (instanceId) root.setAttribute("data-cloud-docs-rail-guard", instanceId);
    else if (root.getAttribute("data-cloud-docs-rail-guard") === railGuardOwner.current) root.removeAttribute("data-cloud-docs-rail-guard");
    railGuardOwner.current = instanceId;
  }, []);
  React.useEffect(() => () => {
    frozen.current = null;
    latest.current = null;
    suspended.current = null;
    clearRailHint();
    allowHostRailHint(null);
    setRailGuard(null);
  }, [allowHostRailHint, clearRailHint, setRailGuard]);
  const sync = React.useCallback((instanceId: string, ready: boolean, active = true) => {
    latest.current = { instanceId, ready, active };
    const bridge = window.__JUGGLEWORK_ELECTRON__?.cloudDocs;
    const element = host.current;
    const rect = element?.getBoundingClientRect();
    if (!bridge || !rect || !element) return;
    // TIPS: 原生视图不受 DOM 的圆角裁切，需将宿主的实际圆角同步给 Electron。
    const style = getComputedStyle(element);
    const borderRadius = parseFloat(style.borderTopLeftRadius) || 0;
    const visible = ready && active && !document.hidden && rect.width > 0 && rect.height > 0 &&
      style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" &&
      (!element.checkVisibility || element.checkVisibility({ checkVisibilityCSS: true }));
    const overlay = visible && hasCloudDocsOccluder(rect);
    // Portal tooltips must start transparent while the native view can cover
    // them, including the interval before Base UI finishes positioning.
    setRailGuard(mirrorRailHints && bridge.setRailHint && visible ? instanceId : null);
    const syncRailHint = () => {
      if (!mirrorRailHints || !bridge.setRailHint) return;
      const node = visible ? findPositionedRailHint() : undefined;
      const intersects = node && intersectsCloudDocs(node, rect);
      allowHostRailHint(node && !intersects ? node : null);
      const label = !overlay && intersects ? node?.dataset.appRailTooltip : undefined;
      if (!node || !label) {
        clearRailHint();
        return;
      }
      if (mirroredHint.current?.instanceId !== instanceId) clearRailHint();
      const previous = mirroredHint.current;
      const hintRect = node.getBoundingClientRect();
      const hint = {
        label,
        centerY: Math.round(hintRect.top + hintRect.height / 2 - rect.top),
        dark: getResolvedThemeMode() === "dark",
      };
      const key = JSON.stringify(hint);
      if (previous?.key !== key) bridge.setRailHint({ instanceId, hint });
      mirroredHint.current = { key, instanceId };
    };
    const bounds = (show: boolean) => {
      bridge.setBounds({ instanceId, x: rect.x, y: rect.y, width: rect.width, height: rect.height, borderRadius, visible: show });
      if (!show && ready) suspended.current = instanceId;
    };
    if (overlay) {
      syncRailHint();
      if (frozen.current?.id === instanceId) {
        let frame = frozen.current;
        if (frame.restoring) {
          // TIPS: 恢复尚未完成又打开浮层时继续使用已加载的画面，同时废弃旧恢复回调。
          frame = { ...frame, restoring: false };
          frozen.current = frame;
          setSnapshot(frame);
        }
        if (frame.loaded) bounds(false);
        return;
      }
      const frame: FrozenFrame = { id: instanceId, loaded: false };
      frozen.current = frame;
      setSnapshot(null);
      // TIPS: 首次就绪时菜单可能仍打开；先显示原生页产生画面，隐藏视图不能 capturePage。
      bounds(true);
      const captured = (image: string | null) => {
        if (frozen.current !== frame) return;
        // TIPS: 失败时以明确的主题占位替代截图，等占位完成绘制再让出原生层，菜单不能整次被盖住。
        if (image) frame.image = image;
        else frame.fallback = true;
        setSnapshot(frame);
      };
      void bridge.snapshot(instanceId).then(captured).catch(() => captured(null));
      return;
    }
    bounds(visible);
    // Activate the native view before forwarding a newly open hint.
    syncRailHint();
    // TIPS: surface 隐藏和浮层遮挡都可能让 Main 拒绝 toggle；仅真实恢复时重新读取状态，截图预热不算恢复。
    if (visible && suspended.current === instanceId) {
      suspended.current = null;
      restored.current?.(instanceId);
    }
    const frame = frozen.current;
    if (visible && frame?.id === instanceId && (frame.image || frame.fallback)) {
      if (frame.restoring) return;
      frame.restoring = true;
      // TIPS: bounds 是 send；同一 bridge 的 status invoke 作为 IPC 屏障，至少再保留一帧后才移除截图。
      void Promise.resolve(bridge.status?.(instanceId)).then(() => {
        requestAnimationFrame(() => {
          if (frozen.current !== frame) return;
          frozen.current = null;
          setSnapshot(null);
        });
      }).catch(() => {});
    } else {
      frozen.current = null;
      setSnapshot(null);
    }
  }, [allowHostRailHint, clearRailHint, host, mirrorRailHints, setRailGuard]);
  const loaded = React.useCallback(() => {
    if (!snapshot || frozen.current !== snapshot) return;
    snapshot.loaded = true;
    // TIPS: onLoad 可能晚于浮层关闭；保留已加载状态供下一帧前重开复用，但恢复中不能再次 hide。
    if (snapshot.restoring) return;
    const current = latest.current;
    if (current) sync(current.instanceId, current.ready, current.active);
  }, [snapshot, sync]);
  const failed = React.useCallback(() => {
    if (!snapshot || frozen.current !== snapshot) return;
    // TIPS: 解码失败可能晚于浮层关闭；记录结果但保留恢复帧身份，让原 RAF 正常清理，重开则绘制占位后再 hide。
    snapshot.image = undefined;
    snapshot.loaded = false;
    snapshot.fallback = true;
    if (snapshot.restoring) return;
    const frame: FrozenFrame = { id: snapshot.id, loaded: false, fallback: true };
    frozen.current = frame;
    setSnapshot(frame);
  }, [snapshot]);
  React.useEffect(() => {
    if (!snapshot?.fallback || snapshot.loaded || snapshot.restoring) return;
    // TIPS: effect 确认占位已提交；跨过一次完整绘制机会后才能隐藏 native，不能先无图隐藏。
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(loaded); });
    return () => cancelAnimationFrame(frame);
  }, [snapshot, loaded]);
  return { snapshot: snapshot?.image ?? null, fallback: snapshot?.fallback === true, loaded, failed, sync };
}
