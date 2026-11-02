import { afterEach, expect, mock, test } from "bun:test";
import type { ComposerDraft } from "../src/app/types";
import { currentLocale, setLocale, t } from "../src/i18n";
import { createSessionDraftSender } from "../src/react-app/domains/session/sync/session-draft-sender";

const originalLocale = currentLocale();
afterEach(() => setLocale(originalLocale));

test.each(["en", "zh"] as const)("file sender localizes rejected operations and mentions before preparing or sending (%s)", async (locale) => {
  setLocale(locale);
  const prepare = mock(), captureContext = mock();
  const sender = createSessionDraftSender({
    sessionId: "bound-session", workspaceId: "workspace", workspaceRoot: "/project", hostKind: "file", endpoint: null,
    client: {} as never, host: {} as never, canSubmit: () => true, prepare, captureContext,
    cloudSubmit: mock(),
  });
  const draft: ComposerDraft = { mode: "prompt", text: "keep this draft", parts: [{ type: "text", text: "keep this draft" }], attachments: [] };
  // Cross-session rejection happens before context capture.
  await expect(sender(draft, "other-session")).rejects.toThrow(t("file_window.operation_unavailable"));
  captureContext.mockImplementation(() => ({ isCurrent: () => true, validateGeneration: () => true }));
  await expect(sender({ ...draft, mode: "shell" }, "bound-session")).rejects.toThrow(t("file_window.operation_unavailable"));
  await expect(sender({ ...draft, parts: [{ type: "agent", name: "reviewer" }] }, "bound-session")).rejects.toThrow(t("file_window.mentions_unavailable"));
  expect(prepare).not.toHaveBeenCalled();
});
