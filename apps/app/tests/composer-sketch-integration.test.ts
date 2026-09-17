import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const composerPath = fileURLToPath(
  new URL("../src/react-app/domains/session/surface/composer/composer.tsx", import.meta.url),
);
const sessionSurfacePath = fileURLToPath(
  new URL("../src/react-app/domains/session/surface/session-surface.tsx", import.meta.url),
);

describe("composer sketch integration", () => {
  test("places sketch directly below file and derives menu offsets from both entries", () => {
    const source = readFileSync(composerPath, "utf8");
    const fileIndex = source.indexOf('{ kind: "file", id: "file"');
    const sketchIndex = source.indexOf('{ kind: "sketch", id: "sketch"');
    const agentIndex = source.indexOf('kind: "agent" as const');

    expect(fileIndex).toBeGreaterThan(-1);
    expect(sketchIndex).toBeGreaterThan(fileIndex);
    expect(agentIndex).toBeGreaterThan(sketchIndex);
    expect(source).toContain('findIndex((entry) => entry.kind === "tools")');
    expect(source).toContain("const plusMenuAddEntries = plusMenuEntries.slice(0, plusMenuToolStartIndex)");
    expect(source).toContain("const plusMenuToolEntries = plusMenuEntries.slice(plusMenuToolStartIndex)");
  });

  test("opens the editor only when attachments are enabled", () => {
    const source = readFileSync(composerPath, "utf8");
    const sketchBranch = source.slice(
      source.indexOf('if (entry.kind === "sketch")'),
      source.indexOf('if (entry.kind === "agent")'),
    );

    expect(sketchBranch).toContain("if (!props.attachmentsEnabled)");
    expect(sketchBranch).toContain("setPlusMenuOpen(false)");
    expect(sketchBranch).toContain("setSketchOpen(true)");
  });

  test("uses the same ordered entry for pointer, arrow, Enter, and Tab activation", () => {
    const source = readFileSync(composerPath, "utf8");
    expect(source).toContain('if (event.key === "ArrowDown")');
    expect(source).toContain('if (event.key === "ArrowUp")');
    expect(source).toContain('if (event.key === "Enter" || event.key === "Tab")');
    expect(source).toContain("const entry = plusMenuEntries[plusMenuIndex]");
    expect(source).toContain("onClick={() => activatePlusEntry(entry)}");
    expect(source).toContain("disabled={disabled}");
    expect(source).toContain("props.attachmentsDisabledReason ?? t(\"composer.attachments_unavailable\")");
  });

  test("routes completion through attachment preprocessing without submitting", () => {
    const source = readFileSync(composerPath, "utf8");
    const dialog = source.slice(source.indexOf("<SketchDialog"), source.indexOf("/>\n", source.indexOf("<SketchDialog")) + 2);

    expect(dialog).toContain("await addAttachments([file])");
    expect(dialog).toContain("if (!attached) throw");
    expect(dialog).not.toContain("props.onSend");
    expect(dialog).not.toContain("props.onQueue");
    expect(dialog).not.toContain("props.onSteer");
    expect(dialog).not.toContain("props.onDraftChange");
  });

  test("keeps the existing attachment-aware send, queue, steer, and removal lifecycle", () => {
    const source = readFileSync(composerPath, "utf8");
    const sessionSurface = readFileSync(sessionSurfacePath, "utf8");
    expect(source).toContain("props.draft.trim().length > 0 || props.attachments.length > 0");
    expect(source).toContain('resolveComposerSubmitAction(props.busy) === "queue"');
    expect(source).toContain("void props.onQueue()");
    expect(source).toContain("props.onRemoveAttachment(attachment.id)");
    expect(sessionSurface).toContain("appendQueuedDraft(props.sessionId, buildDraft(text, attachments))");
    expect(sessionSurface).toContain('sendDraft(claimed.draft, { delivery: "steer", admissionId: claimed.id })');
    expect(sessionSurface).toContain("claimed.draft.attachments.forEach(revokeAttachmentPreview)");
  });
});
