import type { PetSnapshot } from "@/app/lib/desktop-pet-types";

export type PetAnimation = "typing" | "seated-working" | "celebrate" | "waiting";

/** 仅从已知任务事实选择基础动作；局部同步不完整不等同于任务断线，悬停覆盖仍由播放器负责。 */
export function selectPetBaseAction(state: Pick<PetSnapshot, "tasks" | "syncing" | "mainComposerEditing" | "voicePhase">, petEditing: boolean): PetAnimation {
  // TIPS: 跨任务等待请求优先于输入和执行；完成提醒不能掩盖其他未完成任务。
  if (state.tasks.some((task) => task.state === "waiting")) return "waiting";
  if (state.tasks.some((task) => task.state !== "completed") || petEditing || state.mainComposerEditing ||
    !["idle", "error"].includes(state.voicePhase) || state.syncing) return "seated-working";
  return "typing";
}

export const PET_FRAME_DURATIONS: Record<PetAnimation, number[]> = {
  typing: [500, 140, 100, 160, 160, 500],
  "seated-working": [150, 150, 150, 100, 150, 150],
  celebrate: [250, 130, 220, 130, 650],
  waiting: [500, 300, 350, 120, 350, 500],
};

/**
 * 图集播放器；悬停覆盖只改变动画，不改变主宿主传入的任务状态。
 * @param render 显示指定动作的帧号
 * @param reducedMotion 是否减少动态效果
 */
export function createPetAnimator(render: (action: PetAnimation, frame: number) => void, reducedMotion = false,
  clock = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: () => Date.now() }) {
  const { setTimeout, clearTimeout } = clock;
  let base: PetAnimation = "typing";
  let action: PetAnimation = "typing";
  let frame = 0, cycles = 0;
  let over = false, hold = false;
  let lastLeave = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let minimumTyping: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let paused = false;
  let minimumTypingActive = false;

  const play = (next: PetAnimation) => {
    clearTimeout(timer);
    action = next; frame = 0; cycles = 0;
    render(action, frame);
    if (reducedMotion || disposed || paused) return;
    const schedule = () => {
      timer = setTimeout(() => {
        frame++;
        if (frame === PET_FRAME_DURATIONS[action].length) { frame = 0; cycles++; }
        if (action === "celebrate" && cycles === 2) {
          // TIPS: 按两个完整落地周期计数，不依赖GIF的无限loop或动画库的repeat含义。
          play("typing");
          minimumTypingActive = !over;
          if (minimumTypingActive) minimumTyping = setTimeout(() => {
            minimumTypingActive = false;
            if (!over) { hold = false; if (action !== base) play(base); }
          }, 1560);
          return;
        }
        render(action, frame); schedule();
      }, PET_FRAME_DURATIONS[action][frame]);
    };
    schedule();
  };
  play(base);
  return {
    /** 设置真实业务基础动作；悬停覆盖期间只更新兜底，不打断两跳。 */
    setBase(next: PetAnimation) { base = next; if (!hold && action !== next) play(next); },
    /** 从固定人物命中区外进入，任何状态均跳两次，再保持typing。 */
    enter() {
      over = true;
      if (hold || clock.now() - lastLeave < 300) return;
      clearTimeout(minimumTyping); hold = true;
      play(reducedMotion ? "typing" : "celebrate");
    },
    /** 离开人物时恢复真实状态；未完成的两跳仍先完整落地。 */
    leave() {
      over = false; lastLeave = clock.now();
      if (action !== "celebrate" && !minimumTypingActive) { hold = false; if (action !== base) play(base); }
    },
    /** 拖动、休眠、减少动态效果切换时立即取消装饰动作。 */
    cancel() { clearTimeout(minimumTyping); minimumTypingActive = false; hold = false; over = false; play(base); },
    /** 应用系统动态效果设置；静态帧仍保留真实业务动作。 */
    setReduced(value: boolean) { reducedMotion = value; clearTimeout(minimumTyping); minimumTypingActive = false; hold = false; play(base); },
    /** 系统隐藏窗口时暂停计时，恢复后回到真实业务动作。 */
    setPaused(value: boolean) { paused = value; clearTimeout(minimumTyping); minimumTypingActive = false; hold = false; over = false; play(base); },
    /** 释放全部帧和恢复计时。 */
    dispose() { disposed = true; clearTimeout(timer); clearTimeout(minimumTyping); },
  };
}
