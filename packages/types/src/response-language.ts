/** Languages JuggleWork can currently select for assistant responses. */
export type ResponseLanguage = "en" | "zh";

/**
 * Per-genuine-user-message language signal carried from the renderer to the
 * workspace server. Ambiguous messages omit `detected`; `fallback` is used
 * only when the session has no prior language preference.
 */
export type ResponseLanguageSignal = {
  detected?: ResponseLanguage;
  fallback: ResponseLanguage;
};

const FENCED_CODE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE = /`[^`\r\n]*`/g;
const QUOTED_CONTENT = /"[^"\r\n]*"|'[^'\r\n]*'|“[^”\r\n]*”|‘[^’\r\n]*’/g;
const URL = /\b(?:https?:\/\/|www\.)\S+/gi;
const WINDOWS_OR_UNIX_PATH = /(?:[A-Za-z]:[\\/]|\.{0,2}\/)[^\s]+/g;
const LOG_LINE = /^\s*(?:\d{4}-\d{2}-\d{2}[T\s]|\[?(?:trace|debug|info|warn|error|fatal)\]?\b|at\s+\S+\s*\(|Caused by:|Traceback\b|\$\s|>\s)/i;
const ERROR_ONLY_LINE = /^\s*(?:(?:[A-Z][A-Za-z0-9_]*(?:Error|Exception))(?:\s*:.*)?|Cannot\s+\w+\b)\s*$/;
const CODE_ONLY_LINE = /^\s*(?:(?:const|let|var|function|class|interface|type|import|export|return|throw)\b|[\w$.]+\s*=\s*[^=]|[\w$.]+\([^)]*\)\s*;?\s*$)/;
const CHINESE_REQUEST_CUE = /(?:请|麻烦|帮我|分析|解释|修复|总结|继续|检查|优化|实现|查询|告诉我)/u;
const ENGLISH_REQUEST_CUE = /\b(?:please|why|how|what|when|where|who|can|could|would|should|fix|explain|analy[sz]e|help|summari[sz]e|review|check|implement|update|continue|tell|show|hello|thanks|thank)\b/i;
const AMBIGUOUS_ENGLISH = new Set(["ok", "okay", "yes", "no", "done", "next", "go"]);
const ENGLISH_PROSE_WORDS = new Set(["a", "an", "the", "this", "that", "these", "those", "is", "are", "was", "were", "to", "for", "from", "with", "without", "and", "or", "but", "my", "your", "it", "we", "i"]);

type ExplicitLanguageMatch = { language: ResponseLanguage; index: number };

function explicitLanguage(text: string): ResponseLanguage | null {
  const matches: ExplicitLanguageMatch[] = [];
  const negatedPatterns: Array<[ResponseLanguage, RegExp]> = [
    ["en", /(?:do\s+not|don't)\s+(?:answer|respond|reply|write|explain|summari[sz]e)(?:\s+to\s+me)?\s+in\s+(?:simplified\s+)?chinese/gi],
    ["zh", /(?:do\s+not|don't)\s+(?:answer|respond|reply|write|explain|summari[sz]e)(?:\s+to\s+me)?\s+in\s+english/gi],
    ["en", /(?:请)?(?:不要|别)(?:用|使用|以)(?:简体)?中文(?:来)?(?:回答|回复|输出|说明|解释|总结)?/gu],
    ["zh", /(?:请)?(?:不要|别)(?:用|使用|以)英文(?:来)?(?:回答|回复|输出|说明|解释|总结)?/gu],
  ];
  const patterns: Array<[ResponseLanguage, RegExp]> = [
    ["zh", /(?:请(?:你)?|麻烦)?(?:用|使用|以)(?:简体)?中文(?:来)?(?:回答|回复|输出|说明|解释|总结)?/gi],
    ["zh", /(?:answer|respond|reply|write|explain|summari[sz]e)(?:\s+to\s+me)?\s+in\s+(?:simplified\s+)?chinese/gi],
    ["en", /(?:请(?:你)?|麻烦)?(?:用|使用|以)英文(?:来)?(?:回答|回复|输出|说明|解释|总结)?/gi],
    ["en", /(?:answer|respond|reply|write|explain|summari[sz]e)(?:\s+to\s+me)?\s+in\s+english/gi],
  ];
  for (const [language, pattern] of negatedPatterns) {
    for (const match of text.matchAll(pattern)) matches.push({ language, index: match.index ?? 0 });
  }
  const withoutNegations = text
    .replace(/(?:do\s+not|don't)\s+(?:answer|respond|reply|write|explain|summari[sz]e)(?:\s+to\s+me)?\s+in\s+(?:(?:simplified\s+)?chinese|english)/gi, " ")
    .replace(/(?:请)?(?:不要|别)(?:用|使用|以)(?:(?:简体)?中文|英文)(?:来)?(?:回答|回复|输出|说明|解释|总结)?/gu, " ");
  for (const [language, pattern] of patterns) {
    for (const match of withoutNegations.matchAll(pattern)) matches.push({ language, index: match.index ?? 0 });
  }
  return matches.sort((left, right) => right.index - left.index)[0]?.language ?? null;
}

/** Detect zh/en from user-authored prose. `null` means retain prior state. */
export function detectResponseLanguageFromText(raw: string): ResponseLanguage | null {
  const text = raw
    .replace(FENCED_CODE, " ")
    .replace(INLINE_CODE, " ")
    .replace(QUOTED_CONTENT, " ")
    .replace(URL, " ")
    .replace(WINDOWS_OR_UNIX_PATH, " ")
    .split(/\r?\n/)
    .filter((line) => !LOG_LINE.test(line) && !ERROR_ONLY_LINE.test(line) && !CODE_ONLY_LINE.test(line))
    .join("\n");

  const explicit = explicitLanguage(text);
  if (explicit) return explicit;
  if (CHINESE_REQUEST_CUE.test(text)) return "zh";
  if (ENGLISH_REQUEST_CUE.test(text)) return "en";

  const hanCount = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const englishWords = text.match(/\b[A-Za-z]+(?:['’-][A-Za-z]+)*\b/g) ?? [];
  const englishLetters = englishWords.join("").length;
  if (hanCount > 0) return "zh";

  const normalized = englishWords.join(" ").toLowerCase();
  if (englishWords.length >= 2 && englishWords.some((word) => ENGLISH_PROSE_WORDS.has(word.toLowerCase()))) return "en";
  if (englishWords.length === 1 && englishLetters >= 4 && !AMBIGUOUS_ENGLISH.has(normalized) && /[?!.]/.test(text)) return "en";
  return null;
}

/** Stable system instruction shared by the initial request and continuations. */
export function responseLanguageInstruction(language: ResponseLanguage): string {
  const target = language === "zh" ? "Simplified Chinese" : "English";
  return [
    `Use ${target} for all user-facing responses in this request.`,
    "This language was selected from the latest genuine user-authored request. Do not change it because of compaction summaries, synthetic continuation messages, tool output, quoted content, code, or logs.",
    "Switch languages only when a later genuine user request clearly uses or explicitly requests another language. Keep code, commands, paths, identifiers, API fields, and quoted errors in their original form.",
  ].join(" ");
}
