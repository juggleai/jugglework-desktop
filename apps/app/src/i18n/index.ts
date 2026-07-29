import en from "./locales/en";
import ja from "./locales/ja";
import zh from "./locales/zh";
import vi from "./locales/vi";
import ptBR from "./locales/pt-BR";
import th from "./locales/th";
import fr from "./locales/fr";
import ca from "./locales/ca";
import es from "./locales/es";
import ru from "./locales/ru";
export const LANGUAGE_PREF_KEY = "jugglework.language";

/**
 * Supported languages
 */
export type Language = "en" | "ja" | "zh" | "vi" | "pt-BR" | "th" | "fr" | "ca" | "es" | "ru";
export type Locale = Language;

/**
 * All supported languages - single source of truth
 */
export const LANGUAGES: Language[] = ["en", "ja", "zh", "vi", "pt-BR", "th", "fr", "ca", "es", "ru"];

type LanguageOption = { value: Language; label: string; nativeName: string };

/**
 * 全部语言包对应的选项元数据
 *
 * TIPS: 这里保留所有语言，仅用于回显 —— 老用户 localStorage 里若存着 ja/ru 等，
 * 选择器仍能正确显示当前语言，而不是空白。新选择请只从 LANGUAGE_OPTIONS 取。
 */
export const ALL_LANGUAGE_OPTIONS: readonly LanguageOption[] = [
  { value: "en", label: "English", nativeName: "English" },
  { value: "ja", label: "Japanese", nativeName: "日本語" },
  { value: "zh", label: "Chinese (Simplified)", nativeName: "简体中文" },
  { value: "vi", label: "Vietnamese", nativeName: "Tiếng Việt" },
  { value: "pt-BR", label: "Portuguese (BR)", nativeName: "Português (BR)" },
  { value: "th", label: "Thai", nativeName: "ไทย" },
  { value: "fr", label: "French", nativeName: "Français" },
  { value: "ca", label: "Catalan", nativeName: "Català" },
  { value: "es", label: "Spanish", nativeName: "Español" },
  { value: "ru", label: "Russian", nativeName: "Русский" },
] as const;

/**
 * 界面上可供选择的语言
 *
 * 其余语言包并未删除，仍可正常加载与回退，只是不在选择器中提供。
 */
export const SELECTABLE_LANGUAGES: Language[] = ["en", "zh"];

/**
 * Language options for UI - single source of truth
 */
export const LANGUAGE_OPTIONS: readonly LanguageOption[] = ALL_LANGUAGE_OPTIONS.filter((option) =>
  SELECTABLE_LANGUAGES.includes(option.value),
);

const PLURAL_SUFFIX_EMPTY_LANGUAGES = new Set<Language>(["ja", "zh", "th"]);

/**
 * Current translation strings use an English-style plural suffix placeholder.
 * Some locales render the noun without a visible plural marker, so we keep
 * that suffix empty for them.
 */
export const pluralSuffix = (locale: Language, count: number): string => {
  if (PLURAL_SUFFIX_EMPTY_LANGUAGES.has(locale)) {
    return "";
  }

  return count === 1 ? "" : "s";
};

/**
 * Translation maps
 */
const TRANSLATIONS: Record<Language, Record<string, string>> = {
  en,
  ja,
  zh,
  vi,
  "pt-BR": ptBR,
  th,
  fr,
  ca,
  es,
  ru,
};

/**
 * Type guard to validate if a value is a Language
 * Replaces long chains like: value === "en" || value === "zh"
 */
export const isLanguage = (value: unknown): value is Language => {
  return typeof value === "string" && LANGUAGES.includes(value as Language);
};

let localeValue: Language = "en";

/**
 * Get current locale
 */
export const currentLocale = (): Language => locale();
function locale(): Language {
  return localeValue;
}

/**
 * TIPS: `t()` is a plain function reading module state, so React cannot observe
 * a language change on its own. This is the external-store half of the fix —
 * `setLocale` notifies subscribers, and `useLocale()` (see `./use-locale`)
 * turns that into a render. Without it the new strings only appear whenever
 * some unrelated state change happens to re-render the tree, which reads as
 * "switching the language does nothing / takes forever".
 */
const localeListeners = new Set<() => void>();

/**
 * 订阅语言变更（`useSyncExternalStore` 契约）
 * @param onStoreChange 语言变更时触发的回调
 * @returns 取消订阅函数
 */
export const subscribeLocale = (onStoreChange: () => void): (() => void) => {
  localeListeners.add(onStoreChange);
  return () => {
    localeListeners.delete(onStoreChange);
  };
};

/**
 * 读取当前语言快照（`useSyncExternalStore` 契约）
 * @returns 当前语言代码
 */
export const getLocaleSnapshot = (): Language => localeValue;

/**
 * Set locale and persist to localStorage
 */
export const setLocale = (newLocale: Language) => {
  if (!isLanguage(newLocale)) {
    console.warn(`Invalid locale: ${newLocale}, falling back to "en"`);
    newLocale = "en";
  }

  if (localeValue === newLocale) return;

  localeValue = newLocale;

  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("lang", newLocale);
  }

  // Persist to localStorage
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(LANGUAGE_PREF_KEY, newLocale);
    } catch (e) {
      console.warn("Failed to persist language preference:", e);
    }
  }

  for (const listener of localeListeners) listener();
};

/**
 * Resolve a translation entry with the locale → English → null fallback chain.
 */
const lookupEntry = (loc: Language, candidateKey: string): string | null => {
  if (TRANSLATIONS[loc]?.[candidateKey]) return TRANSLATIONS[loc][candidateKey];
  if (loc !== "en" && TRANSLATIONS.en?.[candidateKey]) return TRANSLATIONS.en[candidateKey];
  return null;
};

const pluralRulesByLanguage: Record<Language, Intl.PluralRules> = {
  en: new Intl.PluralRules("en"),
  ja: new Intl.PluralRules("ja"),
  zh: new Intl.PluralRules("zh"),
  vi: new Intl.PluralRules("vi"),
  "pt-BR": new Intl.PluralRules("pt-BR"),
  th: new Intl.PluralRules("th"),
  fr: new Intl.PluralRules("fr"),
  ca: new Intl.PluralRules("ca"),
  es: new Intl.PluralRules("es"),
  ru: new Intl.PluralRules("ru"),
};
const pluralRule = (loc: Language, count: number): Intl.LDMLPluralRule => {
  return pluralRulesByLanguage[loc].select(count);
};

/**
 * Pick the right key variant for a count. Tries `${key}_zero` (only when count === 0),
 * then `${key}_${rule}` (e.g. `_one` / `_other`), then `${key}_other`, then the bare
 * key. Asian locales (no grammatical plural) define only the bare key and hit the
 * final step. Each candidate runs through the locale → English fallback so an
 * untranslated key still resolves to the English `_one` / `_other` variant.
 */
const resolvePluralKey = (loc: Language, key: string, count: number): string => {
  const candidates: string[] = [];
  if (count === 0) candidates.push(`${key}_zero`);
  candidates.push(`${key}_${pluralRule(loc, count)}`, `${key}_other`, key);

  for (const candidate of candidates) {
    if (lookupEntry(loc, candidate) !== null) return candidate;
  }
  return key;
};

/**
 * Translation function with fallback behavior.
 * - Locale fallback: target language → English → key itself.
 * - Plural fallback: when params include a numeric `count`, the lookup picks
 *   `${key}_one` / `${key}_other` (or `${key}_zero` when count === 0) per
 *   `Intl.PluralRules`, and falls back to the bare key when no variants exist.
 */
type TranslationParams = Record<string, string | number> & { lng?: Language };

export const t = (
  key: string,
  paramsOrLocale?: TranslationParams | Language,
  legacyParams?: Record<string, string | number>,
): string => {
  const params = legacyParams ?? (typeof paramsOrLocale === "string" ? undefined : paramsOrLocale);
  const loc: Language = typeof paramsOrLocale === "string"
    ? paramsOrLocale
    : isLanguage(params?.lng)
      ? params.lng
      : locale();

  const lookupKey =
    typeof params?.count === "number" ? resolvePluralKey(loc, key, params.count) : key;

  const result = lookupEntry(loc, lookupKey);
  if (result === null) return key;

  if (!params) return result;

  let out = result;
  for (const [k, v] of Object.entries(params)) {
    if (k === "lng") continue;
    out = out.replace(`{${k}}`, String(v));
  }
  return out;
};

/**
 * 跟随系统语言
 *
 * 按 `navigator.languages` 的优先级依次匹配，命中第一个可选语言即返回。
 * 只解析到「可选语言」（中/英）：系统若是日文等未提供选项的语言，
 * 落到英文，避免用户被置于一个在选择器里无法切换回来的状态。
 *
 * TIPS: 中文按语言子标签匹配（zh-CN / zh-Hans / zh-TW …统一归到 zh），
 * 因为当前只有简体中文一份语言包。
 *
 * @returns 与系统语言最匹配的界面语言
 */
export const detectSystemLanguage = (): Language => {
  if (typeof navigator === "undefined") return "en";

  const tags = navigator.languages?.length
    ? navigator.languages
    : [navigator.language].filter(Boolean);

  for (const tag of tags) {
    const primary = String(tag).toLowerCase().split("-")[0];
    const match = SELECTABLE_LANGUAGES.find(
      (language) => language.toLowerCase().split("-")[0] === primary,
    );
    if (match) return match;
  }

  return "en";
};

/**
 * Initialize locale from localStorage
 * Call this during app initialization
 *
 * 优先级：用户显式选择（localStorage） → 系统语言 → 英文。
 * 系统语言的结果不写回 localStorage，这样在用户主动选择之前会一直跟随系统。
 */
export const initLocale = (): Language => {
  if (typeof window === "undefined") {
    return "en";
  }

  let resolved: Language | null = null;

  try {
    const stored = window.localStorage.getItem(LANGUAGE_PREF_KEY);
    if (isLanguage(stored)) {
      resolved = stored;
    }
  } catch (e) {
    console.warn("Failed to read language preference:", e);
  }

  if (!resolved) {
    resolved = detectSystemLanguage();
  }

  localeValue = resolved;

  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("lang", resolved);
  }

  return resolved;
};
