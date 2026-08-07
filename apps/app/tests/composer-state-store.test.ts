import { beforeEach, describe, expect, test } from "bun:test";

import type { ComposerDraft } from "../src/app/types";
import {
  getComposerQueuedDrafts,
  useComposerStateStore,
} from "../src/react-app/domains/session/surface/composer-state-store";

function reset() {
  useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, history: {} });
}

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

describe("composer state store", () => {
  beforeEach(reset);

  test("scopes queued drafts by session", () => {
    const { appendQueuedDraft } = useComposerStateStore.getState();
    appendQueuedDraft("session-a", draft("queued in A"));
    appendQueuedDraft("session-b", draft("queued in B"));

    const state = useComposerStateStore.getState();
    expect(getComposerQueuedDrafts(state, "session-a").map((item) => item.draft.text)).toEqual(["queued in A"]);
    expect(getComposerQueuedDrafts(state, "session-b").map((item) => item.draft.text)).toEqual(["queued in B"]);
  });

  test("clearing composer input does not clear queued drafts", () => {
    const { appendQueuedDraft, clearSession, setDraft } = useComposerStateStore.getState();
    setDraft("session-a", "in-progress draft");
    appendQueuedDraft("session-a", draft("queued follow-up"));

    clearSession("session-a");

    expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "session-a").map((item) => item.draft.text)).toEqual([
      "queued follow-up",
    ]);
  });

  test("remove and clear only affect the target session", () => {
    const { appendQueuedDraft, clearQueuedDrafts, removeQueuedDraft } = useComposerStateStore.getState();
    const first = appendQueuedDraft("session-a", draft("first A"));
    appendQueuedDraft("session-a", draft("second A"));
    appendQueuedDraft("session-b", draft("only B"));

    removeQueuedDraft("session-a", first.id);
    expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "session-a").map((item) => item.draft.text)).toEqual([
      "second A",
    ]);
    expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "session-b").map((item) => item.draft.text)).toEqual([
      "only B",
    ]);

    clearQueuedDrafts("session-a");
    expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "session-a")).toEqual([]);
    expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "session-b").map((item) => item.draft.text)).toEqual([
      "only B",
    ]);
  });

  test("edits a queued task by moving it back into an empty composer", () => {
    const queued = useComposerStateStore.getState().appendQueuedDraft("session-a", {
      ...draft("edit me"),
      parts: [
        { type: "text", text: "edit me" },
        { type: "agent", name: "reviewer" },
        { type: "paste", id: "paste-1", label: "Pasted text #1", text: "details", lines: 1 },
      ],
    });

    const edited = useComposerStateStore.getState().editQueuedDraft("session-a", queued.id);
    const state = useComposerStateStore.getState();

    expect(edited?.id).toBe(queued.id);
    expect(getComposerQueuedDrafts(state, "session-a")).toEqual([]);
    expect(state.sessions["session-a"]?.draft).toBe("edit me");
    expect(state.sessions["session-a"]?.mentions).toEqual({ reviewer: "agent" });
    expect(state.sessions["session-a"]?.pasteParts).toEqual([
      { id: "paste-1", label: "Pasted text #1", text: "details", lines: 1 },
    ]);
  });

  test("does not overwrite a non-empty composer when editing a queued task", () => {
    const { appendQueuedDraft, editQueuedDraft, setDraft } = useComposerStateStore.getState();
    const queued = appendQueuedDraft("session-a", draft("queued task"));
    setDraft("session-a", "current draft");

    expect(editQueuedDraft("session-a", queued.id)).toBeNull();
    expect(useComposerStateStore.getState().sessions["session-a"]?.draft).toBe("current draft");
    expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "session-a")).toHaveLength(1);
  });

  test("claims by stable id and restores a failed item to the head", () => {
    const { appendQueuedDraft, removeQueuedDraft, restoreQueuedDraft } = useComposerStateStore.getState();
    const first = appendQueuedDraft("session-a", draft("first"));
    const second = appendQueuedDraft("session-a", draft("second"));

    const claimed = removeQueuedDraft("session-a", first.id);
    expect(claimed?.draft.text).toBe("first");
    expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "session-a").map((item) => item.id)).toEqual([
      second.id,
    ]);

    if (claimed) restoreQueuedDraft("session-a", claimed);
    expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "session-a").map((item) => item.id)).toEqual([
      first.id,
      second.id,
    ]);
  });
});
