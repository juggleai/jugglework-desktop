/** @jsxImportSource react */
import * as React from "react";

import { cn } from "@/lib/utils";

type SessionDotMatrixLoaderProps = {
  className?: string;
  label: string;
};

/**
 * Paper interaction notes: 3×3 frames shuffle in the fixed left activity
 * slot (~14–16px). Under prefers-reduced-motion, hold one static frame.
 * Dots use currentColor at two opacities so the lit/dim contrast from the
 * artboard (#ECECEE vs #5A5C61 on dark) holds in both themes.
 */
const FRAMES: ReadonlyArray<ReadonlyArray<number>> = [
  [1, 0, 0, 1, 1, 0, 1, 0, 1],
  [0, 1, 0, 1, 0, 1, 0, 1, 1],
  [0, 0, 1, 0, 1, 1, 1, 1, 0],
  [1, 1, 0, 0, 1, 0, 1, 0, 1],
];

export function SessionDotMatrixLoader({ className, label }: SessionDotMatrixLoaderProps) {
  const [frame, setFrame] = React.useState(0);
  const [reduceMotion, setReduceMotion] = React.useState(false);

  React.useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  React.useEffect(() => {
    if (reduceMotion) return;
    const id = window.setInterval(() => {
      setFrame((current) => (current + 1) % FRAMES.length);
    }, 180);
    return () => window.clearInterval(id);
  }, [reduceMotion]);

  const pattern = FRAMES[frame] ?? FRAMES[0];

  return (
    <span
      data-session-loading-indicator
      role="status"
      aria-label={label}
      className={cn(
        "inline-grid size-3.5 shrink-0 grid-cols-3 grid-rows-3 gap-px text-sidebar-foreground",
        className,
      )}
    >
      {pattern.map((lit, index) => (
        <span
          key={index}
          aria-hidden="true"
          className={cn("size-full rounded-full bg-current", lit ? "opacity-90" : "opacity-25")}
        />
      ))}
    </span>
  );
}
