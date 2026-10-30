import { useLayoutEffect, useRef, type RefObject } from "react";
import type { PetViewport, PetWindowBridge } from "@/app/lib/desktop-pet-types";
import { PET_HEIGHT } from "./geometry";
import { petPanelNaturalHeight, placePetPanel, placePetInputOptions, type PetPanelSide } from "./placement";

/** 固定画布中的布局与命中更新；拖动通过CSS坐标更新，不重挂人物或重启动画。 */
export function usePetPlacement(root: RefObject<HTMLDivElement | null>, bridge: PetWindowBridge | undefined,
  hitRegions: Array<{ x: number; y: number; width: number; height: number }>, mode: "tasks" | "input" | null, controlsVisible: boolean, tasksVisible = false) {
  const config = useRef({ mode, controlsVisible, tasksVisible }); config.current = { mode, controlsVisible, tasksVisible };
  const measure = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const node = root.current;
    const panels = node?.querySelector<HTMLElement>(".pet-panels");
    if (!node || !panels) return;
    let value: PetViewport | undefined, side: PetPanelSide = "above", previousMode = config.current.mode;
    let optionsSide: PetPanelSide = "below", hadOptions = false;
    let taskSide: PetPanelSide = "above";
    let lastLayout = "", raf = 0, active = true, flip: Animation | undefined;
    const place = () => {
      if (!value || !active) return;
      const { character, width, height } = value;
      const { mode, controlsVisible, tasksVisible } = config.current;
      if (mode !== previousMode) { if (mode) side = mode === "input" ? "below" : taskSide; previousMode = mode; }
      node.style.setProperty("--pet-window-width", `${width}px`);
      node.style.setProperty("--pet-window-height", `${height}px`);
      node.style.setProperty("--pet-x", `${character.x}px`);
      node.style.setProperty("--pet-y", `${character.y}px`);
      const tools = node.querySelector<HTMLElement>(".pet-tools");
      const taskPanel = panels.querySelector<HTMLElement>(".pet-task-panel");
      const separateTasks = mode === "input" && tasksVisible && taskPanel;
      panels.dataset.separateTasks = separateTasks ? "true" : "false";
      if (taskPanel && !separateTasks) taskPanel.style.top = "";
      const toolWidth = tools?.offsetWidth ?? 120;
      const belowTop = character.y + PET_HEIGHT + (mode === "input" ? 2 : 54);
      const horizontal = placePetPanel(value, toolWidth, 0, belowTop, side);
      panels.style.width = `${horizontal.width}px`;
      panels.style.left = `${horizontal.x}px`;
      // 输入只测文档流中的自身内容；绝对定位的任务和菜单不能影响输入坐标。
      const scrollable = mode === "input" ? null : taskPanel?.querySelector<HTMLElement>(".pet-cards");
      const currentHeight = panels.getBoundingClientRect().height;
      const scrollHeight = scrollable?.getBoundingClientRect().height ?? 0;
      const desiredHeight = petPanelNaturalHeight(currentHeight, scrollable ? { height: scrollHeight, scrollHeight: scrollable.scrollHeight } : undefined);
      const placement = placePetPanel(value, toolWidth, desiredHeight, belowTop, side);
      if (scrollable) node.style.setProperty("--pet-list-limit", `${Math.max(0, Math.min(360, placement.maxHeight - (currentHeight - scrollHeight)))}px`);
      const panelHeight = panels.getBoundingClientRect().height;
      panels.style.top = `${placement.side === "above" ? character.y - 12 - panelHeight : belowTop}px`;
      if (side !== placement.side && panelHeight > 0 && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        flip?.cancel(); flip = panels.animate([{ opacity: .35 }, { opacity: 1 }], { duration: 140, easing: "ease-out" });
      }
      side = placement.side; panels.dataset.side = side; panels.dataset.align = placement.align;
      node.dataset.panelSide = side;
      if (separateTasks) {
        // 输入只按自身高度定位；任务脱离文档流，不能推挤或翻转输入胶囊。
        const inputBounds = panels.getBoundingClientRect();
        const aboveBottom = Math.min(character.y - 12, inputBounds.top - 8);
        const taskBelowTop = Math.max(character.y + PET_HEIGHT + 54, inputBounds.bottom + 8);
        const available = { above: Math.max(0, aboveBottom - 32), below: Math.max(0, height - taskBelowTop - 32) };
        const other = taskSide === "above" ? "below" : "above";
        const currentTaskHeight = taskPanel.getBoundingClientRect().height;
        const cards = taskPanel.querySelector<HTMLElement>(".pet-cards");
        const cardsHeight = cards?.getBoundingClientRect().height ?? 0;
        const desiredTaskHeight = petPanelNaturalHeight(currentTaskHeight, cards ? { height: cardsHeight, scrollHeight: cards.scrollHeight } : undefined);
        if (available[taskSide] < desiredTaskHeight && available[other] >= available[taskSide] + 24) taskSide = other;
        const overhead = currentTaskHeight - cardsHeight;
        node.style.setProperty("--pet-list-limit", `${Math.max(0, Math.min(360, available[taskSide] - overhead))}px`);
        const taskHeight = taskPanel.getBoundingClientRect().height;
        taskPanel.style.top = `${(taskSide === "above" ? aboveBottom - taskHeight : taskBelowTop) - inputBounds.top}px`;
        node.dataset.panelSide = taskSide;
      } else if (mode === "tasks") taskSide = side;
      const options = panels.querySelector<HTMLElement>(".pet-input-options");
      const composer = panels.querySelector<HTMLElement>(".pet-composer");
      if (options && composer) {
        if (!hadOptions) optionsSide = "below";
        // TIPS: 向上以目标行、向下以胶囊为边界；菜单不占文档流且不遮挡发送目标。
        const anchor = composer.getBoundingClientRect();
        const targetRow = panels.querySelector<HTMLElement>(".pet-target-row")?.getBoundingClientRect();
        const list = options.querySelector<HTMLElement>(".pet-session-list");
        const desiredMenuHeight = petPanelNaturalHeight(options.getBoundingClientRect().height, list ? { height: list.getBoundingClientRect().height, scrollHeight: list.scrollHeight } : undefined, 280);
        const menu = placePetInputOptions(height, { top: targetRow?.top ?? anchor.top, bottom: anchor.bottom }, desiredMenuHeight, optionsSide);
        options.style.maxHeight = `${menu.maxHeight}px`;
        options.style.top = `${menu.top - panels.getBoundingClientRect().top}px`;
        optionsSide = menu.side; panels.dataset.optionsSide = menu.side;
      } else delete panels.dataset.optionsSide;
      hadOptions = Boolean(options);
      node.dataset.positioned = "true";
      const regions = [...node.querySelectorAll<HTMLElement>("[data-pet-hit]")].flatMap((element) => {
        const style = getComputedStyle(element);
        if (element.closest("[inert]") || style.visibility !== "visible" || style.pointerEvents === "none") return [];
        const r = element.getBoundingClientRect();
        let { left, top, right, bottom } = r;
        // TIPS: DOM矩形包含滚动区外的按钮；原生命中必须只保留实际可见、未被祖先裁剪的部分。
        for (let parent = element.parentElement; parent && parent !== node; parent = parent.parentElement) {
          const clip = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
          if (clip.overflowX !== "visible") { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
          if (clip.overflowY !== "visible") { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
        }
        return right > left && bottom > top ? [{ x: left, y: top, width: right - left, height: bottom - top }] : [];
      });
      for (const r of hitRegions) regions.push({ ...r, x: character.x + r.x, y: character.y + r.y });
      const travelWidth = controlsVisible ? Math.min(104, toolWidth) : 40;
      regions.push({ x: character.x + (104 - travelWidth) / 2, y: character.y + PET_HEIGHT - 12, width: travelWidth, height: 36 });
      if (mode && panelHeight) regions.push({ x: character.x + 32, y: side === "above" ? character.y - 12 : belowTop - 12, width: 40, height: 12 });
      if (options && composer) {
        const input = composer.getBoundingClientRect(), menu = options.getBoundingClientRect();
        regions.push({ x: menu.x, y: optionsSide === "above" ? menu.bottom : input.bottom, width: menu.width, height: 8 });
      }
      const layout = { width, height, character, regions }, serialized = JSON.stringify(layout);
      if (serialized !== lastLayout) { lastLayout = serialized; bridge?.layout(layout); }
    };
    measure.current = place;
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); };
    const observer = new ResizeObserver(schedule); observer.observe(panels);
    // 滚动不触发ResizeObserver；悬停/焦点还会改变关闭按钮的可交互状态。
    const hitEvents = ["scroll", "pointerover", "pointerout", "focusin", "focusout"];
    for (const event of hitEvents) node.addEventListener(event, schedule, true);
    const apply = (next: PetViewport) => { value = next; schedule(); };
    const release = bridge?.onViewport?.(apply);
    void bridge?.getViewport?.().then((next) => { if (active) { value = next; place(); } });
    return () => {
      active = false; cancelAnimationFrame(raf); flip?.cancel(); observer.disconnect(); release?.(); measure.current = () => {};
      for (const event of hitEvents) node.removeEventListener(event, schedule, true);
    };
  }, [root, bridge, hitRegions]);
  // TIPS: React提交开合、编辑和状态内容后在同一绘制周期定位；人物不参与面板文档流。
  useLayoutEffect(() => { measure.current(); });
}
