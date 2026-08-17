/**
 * MCP 配置里键值对（环境变量 / 请求头）的校验与归一。
 *
 * TIPS: 表单侧用 `isValidEnvKey` 做提交前拦截，写入侧用 `sanitizeKeyValueMap` 兜底过滤——
 * 两处都做，是因为键值对也可能来自粘贴的 JSON 而非表单输入。
 */

/** 表单中的一行键值对。 */
export type KeyValueRow = {
  key: string;
  value: string;
};

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// HTTP 头名允许连字符，与环境变量名规则不同。
const HEADER_KEY_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * 校验环境变量名。
 * @param key 待校验的键
 */
export function isValidEnvKey(key: string): boolean {
  return ENV_KEY_PATTERN.test(key.trim());
}

/**
 * 校验 HTTP 请求头名。
 * @param key 待校验的键
 */
export function isValidHeaderKey(key: string): boolean {
  return HEADER_KEY_PATTERN.test(key.trim());
}

/**
 * 把表单行归一为配置对象，丢弃键或值为空的行。
 * @param rows 表单中的键值对行
 * @returns 键值对象；全部为空时返回空对象
 *
 * TIPS: 键重复时后者覆盖前者，与 JSON 对象的语义一致。
 */
export function keyValueRowsToRecord(rows: KeyValueRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    const value = row.value.trim();
    if (!value) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 过滤键值对象中的空键与空值。
 * @param source 原始键值对象
 * @returns 归一后的对象；无有效条目时返回空对象
 */
export function sanitizeKeyValueMap(source: Record<string, string> | undefined): Record<string, string> {
  if (!source) return {};
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(source)) {
    if (typeof rawKey !== "string" || typeof rawValue !== "string") continue;
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (!key || !value) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 找出第一个非法的键，用于表单提交前的错误提示。
 * @param rows 表单中的键值对行
 * @param kind 键的类型，决定校验规则
 * @returns 非法的键；全部合法时返回 null
 */
export function firstInvalidKey(rows: KeyValueRow[], kind: "env" | "header"): string | null {
  const validate = kind === "env" ? isValidEnvKey : isValidHeaderKey;
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    if (!validate(key)) return key;
  }
  return null;
}
