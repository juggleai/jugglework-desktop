import type { PetViewport } from "@/app/lib/desktop-pet-types";

export type PetPanelSide = "above" | "below";

/**
 * 根据人物屏幕位置选择面板方向、宽度和对齐；24像素缓冲避免拖动到临界点反复翻转。
 * @param viewport 固定透明画布和工作区
 * @param toolWidth 当前气泡宽度
 * @param desiredHeight 未压缩的面板高度
 * @param belowTop 面板朝下时的起点
 * @param previous 上一次方向，首次任务默认向上、输入默认向下
 */
export function placePetPanel(viewport: PetViewport, toolWidth: number, desiredHeight: number, belowTop: number, previous: PetPanelSide) {
  const { character, workArea } = viewport;
  const center = character.x + 52;
  let width = Math.min(336, viewport.width - 64);
  let x = center - width / 2;
  let align: "left" | "center" | "right" = "center";
  if (viewport.screenX + x < workArea.x + 32) {
    align = "left"; x = center - toolWidth / 2;
    width = Math.min(width, viewport.width - x - 32);
  } else if (viewport.screenX + x + width > workArea.x + workArea.width - 32) {
    align = "right"; width = Math.min(width, center + toolWidth / 2 - 32);
    x = center + toolWidth / 2 - width;
  }
  const available = { above: Math.max(0, character.y - 44), below: Math.max(0, viewport.height - belowTop - 32) };
  const other = previous === "above" ? "below" : "above";
  // TIPS: 能放下就保持原方向；都放不下时只在另一侧明显更宽裕时翻转，剩余内容交给滚动区。
  const side = available[previous] >= desiredHeight || available[other] < available[previous] + 24 ? previous : other;
  return { x, width, align, side, maxHeight: available[side] };
}

/**
 * 将加号菜单贴在输入胶囊上下方；独立计算空间，不移动输入栏或人物。
 * @param viewportHeight 当前画布高度
 * @param anchor 输入胶囊相对画布的上下边界
 * @param desiredHeight 菜单未压缩高度
 * @param previous 上次展开方向，首次优先向下
 */
export function placePetInputOptions(viewportHeight: number, anchor: { top: number; bottom: number }, desiredHeight: number, previous: PetPanelSide) {
  const gap = 8, margin = 16;
  const available = { above: Math.max(0, anchor.top - gap - margin), below: Math.max(0, viewportHeight - anchor.bottom - gap - margin) };
  const other = previous === "above" ? "below" : "above";
  const side = available[previous] >= desiredHeight || available[other] < available[previous] + 24 ? previous : other;
  const height = Math.min(desiredHeight, available[side]);
  return { side, maxHeight: available[side], top: side === "above" ? anchor.top - gap - height : anchor.bottom + gap };
}
