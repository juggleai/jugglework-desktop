/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ComposerDraft } from "../src/app/types";
import { t } from "../src/i18n";
import { QueuedMessagesPanel } from "../src/react-app/domains/session/modals/queued-messages-panel";

function draft(text: string): ComposerDraft {
  return {
    mode: "prompt",
    parts: [{ type: "text", text }],
    attachments: [],
    text,
    resolvedText: text,
    command: undefined,
  };
}

describe("queued messages panel", () => {
  test("renders queued drafts as compact single-line rows without a visible count heading", () => {
    const queuedLabel = t("composer.queued_count", { count: 2 });
    const firstText = "Confirm whether the long download URL points to the expected release artifact";
    const html = renderToStaticMarkup(
      <QueuedMessagesPanel
        drafts={[
          { id: "queued-1", draft: draft(firstText), enqueuedAt: 1 },
          { id: "queued-2", draft: draft("Run the final verification"), enqueuedAt: 2 },
        ]}
        onEdit={() => {}}
        onRemove={() => {}}
      />,
    );

    expect(html).toContain(`role="list" aria-label="${queuedLabel}"`);
    expect(html).not.toContain(`>${queuedLabel}<`);
    expect(html.match(/role="listitem"/g)).toHaveLength(2);
    expect(html).toContain("truncate whitespace-nowrap");
    expect(html).toContain(`title="${firstText}"`);
  });
});
