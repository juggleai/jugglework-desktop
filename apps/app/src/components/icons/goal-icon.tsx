/** @jsxImportSource react */
import type { SVGProps } from "react";

/**
 * Goal mark: an open ring with an inner dot and an arrow flying out of the gap
 * toward the upper right, i.e. a target that has been hit. Drawn on a 24px grid
 * with round caps so it matches the lucide icons beside it.
 */
export function GoalIcon({ size = 16, strokeWidth = 1.8, ...props }: { size?: number; strokeWidth?: number } & Omit<SVGProps<SVGSVGElement>, "width" | "height">) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {/* Outer ring, open at the upper right where the arrow leaves. */}
      <path d="M20.2 13.2A8.5 8.5 0 1 1 10.8 3.8" />
      {/* Inner ring. */}
      <path d="M16 12.6A4.2 4.2 0 1 1 11.4 8" />
      {/* Shaft from the center to the upper right, and the arrow head. */}
      <path d="m12 12 8-8" />
      <path d="M15.5 4H20v4.5" />
    </svg>
  );
}
