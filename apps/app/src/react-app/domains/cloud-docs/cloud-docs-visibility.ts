/** 非 modal 浮层只有实际与文档相交才遮挡；modal 即使内容框不相交也要让出整个原生层。 */
const modalBackdrops = '[data-slot="dialog-overlay"], [data-slot="alert-dialog-overlay"], [data-slot="sheet-overlay"]';

export function hasCloudDocsOccluder(host: DOMRect) {
  const overlays = document.querySelectorAll<HTMLElement>([
    '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]',
    '[role="menu"]', '[role="listbox"]',
    modalBackdrops,
    '[data-app-navigation-sidebar-preview]', '[data-session-list-preview="true"]',
  ].join(","));
  for (const overlay of overlays) {
    const style = getComputedStyle(overlay);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" ||
      overlay.hidden || overlay.getClientRects().length === 0) continue;
    // TIPS: BaseUI modal 不保证输出 aria-modal；Backdrop 承担全局阻止背景交互的职责。
    if (overlay.getAttribute("aria-modal") === "true" || overlay.matches(modalBackdrops)) return true;
    const rect = overlay.getBoundingClientRect();
    if (rect.right > host.left && rect.left < host.right && rect.bottom > host.top && rect.top < host.bottom) return true;
  }
  return false;
}
