import { useEffect, useState } from "react";
import type { PetSnapshot } from "@/app/lib/desktop-pet-types";

/** 订阅主进程确认的宠物显隐状态，网页端不显示桌面专用入口。 */
export function useDesktopPet() {
  const bridge = window.__JUGGLEWORK_ELECTRON__?.pet;
  const [snapshot, setSnapshot] = useState<PetSnapshot | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const release = bridge.onState((state) => { if (active) setSnapshot(state); });
    void bridge.getState().then((state) => { if (active) setSnapshot(state); }).catch(() => {});
    return () => { active = false; release(); };
  }, [bridge]);
  return { bridge, snapshot };
}
