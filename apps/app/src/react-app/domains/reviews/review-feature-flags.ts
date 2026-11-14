function enabled(value: unknown, fallback: boolean): boolean {
  return typeof value === "string" ? /^(1|true|yes|on)$/i.test(value.trim()) : fallback;
}

/**
 * 是否显示「代码审查」模块（导航入口、置顶按钮与 /reviews 路由）。
 * 北数Work 默认隐藏；构建时设置 VITE_CODE_REVIEW_ENABLED=1 可重新开启。
 */
export const CODE_REVIEW_ENABLED = enabled(import.meta.env.VITE_CODE_REVIEW_ENABLED, false);
