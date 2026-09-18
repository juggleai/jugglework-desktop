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
    const entriesIndex = source.indexOf("const plusMenuEntries");
    const fileIndex = source.indexOf('kind: "file"', entriesIndex);
    const sketchIndex = source.indexOf('kind: "sketch"', entriesIndex);
    const agentIndex = source.indexOf('kind: "agent" as const');

    expect(fileIndex).toBeGreaterThan(-1);
    expect(sketchIndex).toBeGreaterThan(fileIndex);
    expect(agentIndex).toBeGreaterThan(sketchIndex);
    expect(source).toContain('findIndex((entry) => entry.kind === "tools")');
    expect(source).toContain("const plusMenuAddEntries = plusMenuEntries.slice(0, plusMenuToolStartIndex)");
    expect(source).toContain("const plusMenuToolEntries = plusMenuEntries.slice(plusMenuToolStartIndex)");
  });

  test("keeps the default agent implicit in the add menu", () => {
    const source = readFileSync(composerPath, "utf8");
    const agentEntries = source.slice(
      source.indexOf("const plusMenuAgents"),
      source.indexOf("const plusMenuEntries"),
    );

    expect(agentEntries).toContain("isNonDefaultAgent(agent)");
    expect(agentEntries).not.toContain('t("composer.default_agent")');
    expect(agentEntries).toContain('agent.name.trim().toLowerCase() !== "build"');
  });

  test("uses a dedicated plan affordance without horizontal overflow", () => {
    const source = readFileSync(composerPath, "utf8");

    expect(source).toContain('normalizedName === "plan"');
    expect(source).toContain("return <Lightbulb");
    expect(source).toContain('t("composer.agent_plan_mode")');
    expect(source).toContain('t("composer.plus_menu_draw")');
    expect(source).toContain("overflow-x-hidden overflow-y-auto");
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
