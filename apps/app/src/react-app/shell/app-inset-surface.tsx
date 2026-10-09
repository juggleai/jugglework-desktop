/** @jsxImportSource react */
import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";

export function AppInsetSurface(props: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  testId?: string;
}) {
  return (
    <main
      className={cn(
        "mb-1.5 ml-1 mr-1.5 mt-11 flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-[18px] border border-dls-border bg-background shadow-[0_1px_2px_rgba(0,0,0,0.04)] mac:titlebar-no-drag",
        props.className,
      )}
      style={props.style}
      data-app-inset-surface
      data-testid={props.testId}
    >
      {props.children}
    </main>
  );
}
