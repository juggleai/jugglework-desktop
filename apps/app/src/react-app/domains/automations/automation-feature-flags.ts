function enabled(value: unknown, fallback: boolean): boolean {
  return typeof value === "string" ? /^(1|true|yes|on)$/i.test(value.trim()) : fallback;
}

/** 是否启用本机自动化任务入口、调度与同步协调器。 */
export const LOCAL_AUTOMATION_ENABLED = enabled(import.meta.env.VITE_LOCAL_AUTOMATION_ENABLED, true);

/** 是否向自动化创建页开放需要服务端运行级 scope 的云连接器。 */
export const AUTOMATION_CLOUD_CONNECTOR_SCOPE_ENABLED = enabled(
  import.meta.env.VITE_AUTOMATION_CLOUD_CONNECTOR_SCOPE_ENABLED,
  false,
);
