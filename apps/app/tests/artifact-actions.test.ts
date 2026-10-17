import { afterEach, describe, expect, mock, test } from "bun:test";
import type { JuggleWorkServerClient } from "../src/app/lib/jugglework-server";
import {
  addArtifactToComposer,
  prepareArtifactFileOperation,
} from "../src/react-app/domains/session/artifacts/artifact-actions-provider";
import { useFilesPanelStore } from "../src/react-app/domains/session/files/files-panel-store";
import {
  getComposerDraft,
  getComposerMentions,
  useComposerStateStore,
} from "../src/react-app/domains/session/surface/composer-state-store";

afterEach(() => {
  useFilesPanelStore.setState({ sessions: {} });
  useComposerStateStore.setState({ sessions: {} });
});

describe("artifact file actions", () => {
  test("adds a space-containing file reference once to its own conversation without sending", () => {
    const store = useComposerStateStore.getState();
    store.setDraft("current", "Please update");
    store.setDraft("other", "Unchanged");
    addArtifactToComposer("current", "报告 Q1.docx");
    addArtifactToComposer("current", "报告 Q1.docx");
    const state = useComposerStateStore.getState();
    expect(getComposerDraft(state, "current")).toBe(
      "Please update @报告%20Q1.docx ",
    );
    expect(getComposerMentions(state, "current")["报告 Q1.docx"]).toBe("file");
    expect(getComposerDraft(state, "other")).toBe("Unchanged");
    expect(state.sessions.current?.attachments).toEqual([]);
    expect(state.queuedDrafts.current).toBeUndefined();
  });

  test("cancel and save failures preserve the original draft and stop the action", async () => {
    const draft = { content: "unsaved", baseUpdatedAt: 1 };
    useFilesPanelStore.getState().setDraft("current", "report.md", draft);
    const write = mock(async () => {
      throw new Error("Save failed");
    });
    const client = {
      writeWorkspaceBinaryFile: write,
    } as unknown as JuggleWorkServerClient;
    expect(
      await prepareArtifactFileOperation(
        client,
        "ws",
        "current",
        "report.md",
        () => false,
      ),
    ).toBe(false);
    expect(write).not.toHaveBeenCalled();
    await expect(
      prepareArtifactFileOperation(
        client,
        "ws",
        "current",
        "report.md",
        () => true,
      ),
    ).rejects.toThrow("Save failed");
    expect(
      useFilesPanelStore.getState().sessions.current?.drafts["report.md"],
    ).toBe(draft);
  });

  test("saves the draft before proceeding, but does not erase newer edits made during saving", async () => {
    const store = useFilesPanelStore.getState();
    store.setDraft("current", "report.md", {
      content: "saved",
      baseUpdatedAt: 1,
    });
    const write = mock(async () => ({
      ok: true,
      path: "report.md",
      updatedAt: 2,
    }));
    const client = {
      writeWorkspaceBinaryFile: write,
    } as unknown as JuggleWorkServerClient;
    expect(
      await prepareArtifactFileOperation(
        client,
        "ws",
        "current",
        "report.md",
        () => true,
      ),
    ).toBe(true);
    expect(write.mock.calls[0]?.[1]).toMatchObject({
      path: "report.md",
      baseUpdatedAt: 1,
    });
    expect(
      useFilesPanelStore.getState().sessions.current?.drafts["report.md"],
    ).toBeUndefined();
    store.setDraft("current", "report.md", {
      content: "old",
      baseUpdatedAt: 2,
    });
    const newer = { content: "newer", baseUpdatedAt: 2 };
    const changingClient = {
      writeWorkspaceBinaryFile: async () => {
        store.setDraft("current", "report.md", newer);
        return { updatedAt: 3 };
      },
    } as unknown as JuggleWorkServerClient;
    await expect(
      prepareArtifactFileOperation(
        changingClient,
        "ws",
        "current",
        "report.md",
        () => true,
      ),
    ).rejects.toThrow();
    expect(
      useFilesPanelStore.getState().sessions.current?.drafts["report.md"],
    ).toBe(newer);
  });
});
