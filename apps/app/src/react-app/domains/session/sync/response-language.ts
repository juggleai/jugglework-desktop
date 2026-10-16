import {
  detectResponseLanguageFromText,
  type ResponseLanguage,
} from "@jugglework/types/response-language";

import type { ComposerDraft } from "@/app/types";

function naturalLanguageText(draft: Pick<ComposerDraft, "parts">): string {
  return draft.parts
    .flatMap((part) => part.type === "text" ? [part.text] : [])
    .join("\n");
}

/**
 * Detect zh/en from genuine composer prose only. Generated capability text,
 * attachments, file mentions, and pasted code/log payloads cannot change the
 * session language. `null` means the server should retain the session's last
 * confidently detected language.
 */
export function detectResponseLanguage(
  draft: Pick<ComposerDraft, "parts">,
): ResponseLanguage | null {
  return detectResponseLanguageFromText(naturalLanguageText(draft));
}
