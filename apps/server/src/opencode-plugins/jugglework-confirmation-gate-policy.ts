const BLOCKING_CONFIRMATION_PATTERNS = [
  /(?:你|您)确认后.{0,120}(?:我(?:会|将|再)|再(?:继续|开始|执行|实施|修改)|才(?:会|能))/su,
  /(?:等|等待|待)(?:你|您)(?:回复|确认|决定|选择)(?:后|再)/su,
  /(?:请|需要)(?:你|您)(?:明确)?(?:确认|选择|决定|告诉我).{0,120}(?:后|再|才能)/su,
  /\b(?:once|after|when)\s+you\s+(?:have\s+)?(?:confirm(?:ed)?|decide|choose|reply).{0,120}\b(?:i(?:'ll| will)|we(?:'ll| will)|continue|proceed|start|implement)\b/isu,
  /\bno answer came back.{0,160}\bgoing ahead\b/isu,
];

function proseOnly(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
}

export function declaresBlockingConfirmation(text: string): boolean {
  const prose = proseOnly(text);
  return BLOCKING_CONFIRMATION_PATTERNS.some((pattern) => pattern.test(prose));
}
