/** @jsxImportSource react */
import type { SVGProps } from "react";

/**
 * 插件中心图标。
 *
 * 三段相扣的轨道既保留「扩展能力」的含义，也避免和系统设置常用的拼图图标混淆。
 */
export function PluginOrbitIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="8.25" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M7.35 8.25c1.1-1.62 3.04-2.55 5.02-2.2 2.77.49 4.62 3.13 4.13 5.9-.36 2.03-1.88 3.6-3.77 4.12"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M16.65 15.75c-1.1 1.62-3.04 2.55-5.02 2.2-2.77-.49-4.62-3.13-4.13-5.9.36-2.03 1.88-3.6 3.77-4.12"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <circle cx="12" cy="12" r="1.45" fill="currentColor" stroke="none" />
    </svg>
  );
}
