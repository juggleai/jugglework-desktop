import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { Session } from "@opencode-ai/sdk/v2/client";
import type { JuggleWorkSessionMessage } from "../src/app/lib/jugglework-server";
import { submittedTaskModelNotices } from "../src/components/chat/model-switch-notices";
import { snapshotToUIMessages } from "../src/react-app/domains/session/sync/usechat-adapter";
import {
  __applySessionSyncEventForTest, __createWorkspaceSessionSyncForTest,
  trackWorkspaceSessionSync, transcriptKey,
} from "../src/react-app/domains/session/sync/session-sync";
import { getReactQueryClient } from "../src/react-app/infra/query-client";

const sessionID = "switch-notices";
const astra = "gpt-6.2-astra";
const luna = "gpt-6-luna";
function prompt(id: string, modelID: string, providerID = "openai"): JuggleWorkSessionMessage {
  return {
    info: { id, sessionID, role: "user", time: { created: 1 }, agent: "build", model: { modelID, providerID } },
    parts: [{ type: "text", text: "task", id: id + "-text", sessionID, messageID: id }],
  };
}
function replay(messages: JuggleWorkSessionMessage[]) {
  return snapshotToUIMessages({ session: { id: sessionID } as Session, messages, status: { type: "idle" }, todos: [] });
}

test("only models used to send consecutive tasks produce a notice before the new prompt", () => {
  const first = prompt("first", astra);
  const second = prompt("second", luna);
  // Intermediate picker choices never become prompts. Finishing the first task alone adds nothing.
  expect(submittedTaskModelNotices(replay([first])).size).toBe(0);
  expect([...submittedTaskModelNotices(replay([first, second, prompt("third", luna)]))]).toEqual([
    ["second", { from: "GPT-6.2 Astra", to: "GPT-6 Luna" }],
  ]);
  // Switching away and back before sending uses the original model again.
  expect(submittedTaskModelNotices(replay([first, prompt("second", astra)])).size).toBe(0);
});

test("transparent engine messages do not consume a change and missing model data does not invent one", () => {
  const [first, next] = replay([prompt("first", astra), prompt("next", luna)]);
  const internal = { ...next!, id: "internal", parts: [] };
  expect([...submittedTaskModelNotices([first!, internal, next!]).keys()]).toEqual(["next"]);
  const unknown = { ...first!, id: "legacy", metadata: undefined };
  expect(submittedTaskModelNotices([first!, unknown, next!]).size).toBe(0);
});

test("live messages and reopened history attach the same notice, including a provider-only switch", () => {
  const input = { workspaceId: "switch-test", baseUrl: "http://localhost:1234", juggleworkToken: "token" };
  const cleanup = __createWorkspaceSessionSyncForTest(input);
  const release = trackWorkspaceSessionSync(input, sessionID);
  const key = transcriptKey(input.workspaceId, sessionID);
  try {
    const messages = [prompt("p1", astra), prompt("p2", astra, "local")];
    for (const { info, parts } of messages) {
      __applySessionSyncEventForTest(input, { type: "message.updated", properties: { info } });
      for (const part of parts) {
        __applySessionSyncEventForTest(input, { type: "message.part.updated", properties: { part, time: 1 } });
      }
    }
    const live = getReactQueryClient().getQueryData<UIMessage[]>(key) ?? [];
    const notices = [...submittedTaskModelNotices(live)];
    expect(notices).toEqual([["p2", { from: "openai/gpt-6.2-astra", to: "local/gpt-6.2-astra" }]]);
    expect([...submittedTaskModelNotices(replay(messages))]).toEqual(notices);
  } finally {
    release();
    cleanup();
    getReactQueryClient().removeQueries({ queryKey: key, exact: true });
  }
});
