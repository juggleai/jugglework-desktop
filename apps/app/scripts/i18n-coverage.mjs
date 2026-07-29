#!/usr/bin/env node
/**
 * i18n 覆盖率检查
 *
 * 以 en 为基准，报告每个语言包的：
 * - missing：en 有、该语言没有的 key（运行时会回退到英文，界面显示为英文）
 * - untranslated：值与 en 完全相同且含英文单词的 key（大概率忘了翻译）
 * - extra：该语言有、en 没有的 key（多为改名后的残留，永远不会被读到）
 *
 * 用法：
 *   node scripts/i18n-coverage.mjs                 报告表格
 *   node scripts/i18n-coverage.mjs --json          输出 JSON
 *   node scripts/i18n-coverage.mjs --locale zh     只看某个语言，并列出全部 key
 *   node scripts/i18n-coverage.mjs --strict        存在 missing/extra 时以非 0 退出（用于 CI）
 *
 * TIPS: 语言包文件是严格的「一行一个 "key": "value",」结构，本脚本按行解析，
 * 不引入 TS 运行时。新增 key 请保持这一格式，否则解析会漏掉该行。
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "i18n", "locales");
const BASE_LOCALE = "en";
const ENTRY_RE = /^\s*"((?:[^"\\]|\\.)*)":\s*("(?:[^"\\]|\\.)*")\s*,?\s*$/;
/** 判定“看起来还是英文”的启发式：包含至少一个 3 字母以上的拉丁单词 */
const LOOKS_ENGLISH_RE = /[A-Za-z]{3}/;

/**
 * 解析单个语言包文件
 * @param {string} locale 语言代码（文件名去掉 .ts）
 * @returns {{map: Record<string,string>, duplicates: string[]}}
 */
function readLocale(locale) {
  const src = readFileSync(join(LOCALES_DIR, `${locale}.ts`), "utf8");
  const map = Object.create(null);
  const duplicates = [];
  for (const line of src.split("\n")) {
    const match = ENTRY_RE.exec(line);
    if (!match) continue;
    const key = match[1];
    if (key in map) duplicates.push(key);
    map[key] = JSON.parse(match[2]);
  }
  return { map, duplicates };
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const allLocales = readdirSync(LOCALES_DIR)
  .filter((file) => file.endsWith(".ts") && file !== "index.ts")
  .map((file) => file.slice(0, -3));

const base = readLocale(BASE_LOCALE);
const baseKeys = Object.keys(base.map);
const only = option("locale");
const targets = (only ? [only] : allLocales).filter((locale) => locale !== BASE_LOCALE);

const report = targets.map((locale) => {
  const { map, duplicates } = readLocale(locale);
  const missing = baseKeys.filter((key) => !(key in map));
  const untranslated = baseKeys.filter(
    (key) => key in map && map[key] === base.map[key] && LOOKS_ENGLISH_RE.test(base.map[key]),
  );
  const extra = Object.keys(map).filter((key) => !(key in base.map));
  const done = baseKeys.length - missing.length - untranslated.length;
  return {
    locale,
    keys: Object.keys(map).length,
    missing,
    untranslated,
    extra,
    duplicates,
    coverage: `${((done / baseKeys.length) * 100).toFixed(1)}%`,
  };
});

if (flag("json")) {
  console.log(JSON.stringify({ baseKeys: baseKeys.length, report }, null, 2));
} else {
  console.log(`base locale "${BASE_LOCALE}": ${baseKeys.length} keys`);
  if (base.duplicates.length) {
    console.log(`  duplicate keys in en: ${base.duplicates.join(", ")}`);
  }
  console.table(
    report.map((row) => ({
      locale: row.locale,
      keys: row.keys,
      missing: row.missing.length,
      untranslated: row.untranslated.length,
      extra: row.extra.length,
      duplicates: row.duplicates.length,
      coverage: row.coverage,
    })),
  );
  if (only) {
    for (const row of report) {
      for (const [label, list] of [
        ["missing", row.missing],
        ["untranslated", row.untranslated],
        ["extra", row.extra],
        ["duplicates", row.duplicates],
      ]) {
        if (!list.length) continue;
        console.log(`\n${row.locale} ${label} (${list.length}):`);
        for (const key of list) console.log(`  ${key}`);
      }
    }
  }
}

if (flag("strict")) {
  const broken = report.filter((row) => row.missing.length || row.extra.length || row.duplicates.length);
  if (broken.length) {
    console.error(
      `\ni18n check failed: ${broken.map((row) => `${row.locale}(-${row.missing.length}/+${row.extra.length})`).join(", ")}`,
    );
    process.exit(1);
  }
}
