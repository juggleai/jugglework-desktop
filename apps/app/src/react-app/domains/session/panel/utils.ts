import { isElectronRuntime } from "@/app/utils";

export function getElectronBrowser() {
  if (!isElectronRuntime()) {
    return null;
  }

  return window.__JUGGLEWORK_ELECTRON__?.browser ?? null;
}

// Bounds and points are sent in renderer CSS pixels. The Electron main process
// converts them to window device-independent pixels using the authoritative
// webContents zoom factor at apply time, so the renderer never needs to track
// (and can never disagree with) the real zoom state.
export function getNativeMenuPoint(
  el: HTMLElement | null,
  point?: { clientX: number; clientY: number },
) {
  if (point) {
    return { x: point.clientX, y: point.clientY };
  }

  if (!el) {
    return undefined;
  }

  const rect = el.getBoundingClientRect();

  return {
    x: rect.left + 8,
    y: rect.bottom + 4,
  };
}

export function computeBounds(el: HTMLElement) {
  const rect = el.getBoundingClientRect();

  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

export function sameBounds(
  left: { x: number; y: number; width: number; height: number } | null,
  right: { x: number; y: number; width: number; height: number },
) {
  return Boolean(
    left &&
      left.x === right.x &&
      left.y === right.y &&
      left.width === right.width &&
      left.height === right.height,
  );
}

type NativeBrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function visibleOverlay(element: Element): element is HTMLElement {
  return element instanceof HTMLElement && (
    element.offsetParent !== null || element.getClientRects().length > 0
  );
}

export function rectanglesOverlap(left: NativeBrowserBounds, right: NativeBrowserBounds) {
  return left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y;
}

/** 检查会覆盖原生视图的宿主浮窗；云文档另包含导航提示，并保留当前画面垫底。 */
export function hasNativeBrowserOccluder(
  targetBounds?: NativeBrowserBounds,
  includeRailTooltips = false,
) {
  // Modal surfaces dim the whole renderer, so the native page must always be
  // removed even when the dialog card itself does not intersect the panel.
  const modals = document.querySelectorAll('[role="alertdialog"], [role="dialog"][aria-modal="true"]');
  if ([...modals].some(visibleOverlay)) {
    return true;
  }

  // Menus and listboxes are local floating surfaces. A WebContentsView only
  // needs to yield when one actually enters its rectangle; hiding it for a
  // model picker on the conversation side produces an unrelated blank panel.
  const floating = document.querySelectorAll(
    '[role="dialog"]:not([aria-modal="true"]), [role="menu"], [role="listbox"]' + (includeRailTooltips ? ', [data-app-rail-tooltip]' : ''),
  );
  for (const overlay of floating) {
    if (!visibleOverlay(overlay)) continue;
    if (!targetBounds) return true;
    const rect = overlay.getBoundingClientRect();
    if (rectanglesOverlap(targetBounds, {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    })) return true;
  }
  return false;
}
