/**
 * `disabled_providers` 列表的纯操作。
 *
 * 该列表存在多个来源：用户全局 `opencode.jsonc`、工作区项目配置、以及服务端按
 * 工作区维护的运行时层。这里只负责单项增删与比较，"以哪一层为基准"由调用方决定。
 */

/** 归一化停用列表：去空白、去空项、去重，保留原始大小写与顺序。 */
export function normalizeDisabledProviders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

/** 停用项的比较口径：不区分大小写。 */
export function disabledProviderKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 在停用列表上增删单个 provider
 * @param list 基准停用列表
 * @param providerId 被操作的 provider ID
 * @param disabled true 表示加入停用，false 表示移出停用
 * @returns 新的停用列表，不修改入参
 *
 * TIPS: 匹配一律按小写归一 —— 列表渲染早已用小写判断条目是否停用，写入若按精确
 * 大小写增删，就会出现「显示已断开但重新连接无变化」。重新加入时保留列表中已记录
 * 的原始大小写，避免同一 provider 在配置里留下两种写法。
 */
export function applyDisabledProviderEntry(
  list: string[],
  providerId: string,
  disabled: boolean,
): string[] {
  const key = disabledProviderKey(providerId);
  if (!key) return [...list];
  const without = list.filter((entry) => disabledProviderKey(entry) !== key);
  if (!disabled) return without;
  const existing = list.find((entry) => disabledProviderKey(entry) === key);
  return [...without, existing ?? providerId.trim()];
}

/** 两份停用列表是否完全一致（顺序敏感，用于判断写入是否为空操作）。 */
export function sameDisabledProviderList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}
