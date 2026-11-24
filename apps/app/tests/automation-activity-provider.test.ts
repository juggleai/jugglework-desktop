import { describe, expect, test } from "bun:test";
import type { AutomationRun } from "@jugglework/types/automation";

import { fetchActiveAutomationRuns, hasUnreadAutomationCompletion } from "../src/react-app/domains/automations/automation-activity-provider";

const run = (id: string, state: AutomationRun["state"]): AutomationRun => ({
  schema: "automation-run/v1",
  id,
  automationId: `automation-${id}`,
  automationName: id,
  definitionRevision: 1,
  triggerSource: "scheduled",
  state,
  scheduledFor: 1,
  workspaceId: "workspace",
  workspaceName: "Workspace",
  queuedAt: 1,
  connectorIds: [],
  revision: 1,
  syncState: "synced",
});

describe("global automation activity", () => {
  test("collects queued and running tasks across every result page", async () => {
    const cursors: Array<string | undefined> = [];
    const client = {
      listAutomationRuns: async ({ cursor }: { cursor?: string }) => {
        cursors.push(cursor);
        return cursor
          ? { items: [run("running", "running")], nextCursor: undefined }
          : { items: [run("queued", "queued"), run("stale", "succeeded")], nextCursor: "next" };
      },
    };

    const result = await fetchActiveAutomationRuns(client as never);
    expect(cursors).toEqual([undefined, "next"]);
    expect(result.map((item) => item.id)).toEqual(["queued", "running"]);
  });
});

test("only successful unread results light the rail, including results beyond the first page", async () => {
  let unread = true;
  const client = {
    listAutomations: async ({ cursor }: { cursor?: string }) => cursor
      ? { items: [{ hasUnreadResult: unread, latestResultRun: run("success", "succeeded") }] }
      : { items: [{ hasUnreadResult: true, latestResultRun: run("failure", "failed") }], nextCursor: "page2" },
  };
  expect(await hasUnreadAutomationCompletion(client as never)).toBe(true);
  unread = false;
  expect(await hasUnreadAutomationCompletion(client as never)).toBe(false);
});
