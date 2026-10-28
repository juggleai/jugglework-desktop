import { expect, test } from "bun:test";
import { latestRoot, sortedRoots, sessionTreeIds, reconcilePetTaskConnection, selectPetTaskPresentation } from "../src/react-app/domains/pet/pet-model";
import type { PetTask } from "../src/app/lib/desktop-pet-types";
import { sessionTaskPresentation } from "../src/react-app/domains/session/status/task-presentation";
import type { UIMessage } from "ai";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";
import { seedSessionState, transcriptKey } from "../src/react-app/domains/session/sync/session-sync";
import { getReactQueryClient } from "../src/react-app/infra/query-client";

const connectionTask = (state: PetTask["state"]): PetTask => ({ key: "w:root", workspaceId: "w", sessionId: "root", project: "项目", title: "任务", turnKey: "turn", state, statusText: "已有状态", progressText: "已有进度", canStop: state === "running" });

test("a disconnected unfinished task stays reconciling until authoritative recovery", () => {
  const previous = connectionTask("running");
  const result = reconcilePetTaskConnection(connectionTask("completed"), previous, true, "连接中断，正在确认任务状态");
  expect(result).toMatchObject({ key: previous.key, turnKey: previous.turnKey, state: "reconciling", statusText: "连接中断，正在确认任务状态", progressText: undefined });
  expect(reconcilePetTaskConnection(connectionTask("completed"), result, false, "断线").state).toBe("completed");
});

test("unrelated unavailable sources do not replace known completion or pending questions", () => {
  const completed = connectionTask("completed");
  expect(reconcilePetTaskConnection(completed, completed, true, "断线")).toBe(completed);
  const waiting = connectionTask("waiting");
  expect(reconcilePetTaskConnection(waiting, waiting, true, "断线")).toBe(waiting);
  expect(reconcilePetTaskConnection(connectionTask("completed"), { ...completed, turnKey: "previous-turn" }, true, "断线").state).toBe("reconciling");
});

test("authoritative idle snapshots recover completed or resumable cards after a provider disconnect", () => {
  const workspaceId = "pet-recovered-workspace", sessionId = "pet-recovered-root";
  const store = useSessionActivityStore.getState(), query = getReactQueryClient();
  try {
    for (const finish of ["stop", "error"]) {
      store.setCompletionDiagnostic(workspaceId, sessionId, true, "provider_disconnected");
      seedSessionState(workspaceId, {
        session: { id: sessionId, title: "恢复任务", version: "0", time: { created: 1, updated: 3 } },
        status: { type: "idle" }, todos: [],
        messages: [
          { info: { id: "u", role: "user", sessionID: sessionId, time: { created: 1 } }, parts: [{ id: "u-text", messageID: "u", sessionID: sessionId, type: "text", text: "work" }] },
          { info: { id: "a", role: "assistant", sessionID: sessionId, finish, time: { created: 2, completed: 3 } }, parts: [{ id: "a-text", messageID: "a", sessionID: sessionId, type: "text", text: "result" }] },
        ],
      } as Parameters<typeof seedSessionState>[1]);
      const activity = useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]![sessionId]!;
      const result = sessionTaskPresentation(query.getQueryData<UIMessage[]>(transcriptKey(workspaceId, sessionId))!, [], activity);
      expect(activity.finishReason).not.toBe("provider_disconnected");
      expect(result).toMatchObject({ completed: finish === "stop", resumable: finish !== "stop" });
      const state = result.completed ? "completed" : "resumable";
      expect(reconcilePetTaskConnection(connectionTask(state), connectionTask("reconciling"), false, "断线").state).toBe(state);
      query.removeQueries({ queryKey: transcriptKey(workspaceId, sessionId) });
    }
  } finally { store.removeSession(workspaceId, sessionId); query.clear(); }
});

test("a recovered busy snapshot resumes activity on its first read after disconnection", () => {
  const workspaceId = "pet-recovered-busy", sessionId = "pet-busy-root";
  const store = useSessionActivityStore.getState();
  try {
    store.setCompletionDiagnostic(workspaceId, sessionId, true, "provider_disconnected");
    seedSessionState(workspaceId, {
      session: { id: sessionId, title: "执行中", version: "0", time: { created: 1, updated: 2 } },
      status: { type: "busy" }, messages: [], todos: [],
    } as Parameters<typeof seedSessionState>[1]);
    expect(useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[sessionId]).toMatchObject({ runActive: true, completionBlocked: false, finishReason: null });
  } finally { store.removeSession(workspaceId, sessionId); getReactQueryClient().clear(); }
});

test("latest input destination spans projects but excludes children and archived roots", () => {
  const item = (key: string, updated: number, parentID?: string, archived?: number) => ({ key, session: { parentID, time: { created: 1, updated, archived } } });
  const fixed = latestRoot([item("projectA:old", 10), item("projectB:latest", 20), item("projectB:child", 100, "latest"), item("projectA:archived", 200, undefined, 5)]);
  expect(fixed?.key).toBe("projectB:latest");
  expect(latestRoot([item("projectA:new", 30), fixed!])?.key).toBe("projectA:new");
  expect(fixed?.key).toBe("projectB:latest");
});
test("stopping a root includes nested children even when the root itself is idle", () => {
  const tree = sessionTreeIds([{ id: "root" }, { id: "child", parentID: "root" }, { id: "nested", parentID: "child" }, { id: "unrelated" }], "root");
  expect([...tree]).toEqual(["root", "child", "nested"]);
});
test("conversation choices include historical roots across projects with stable ordering", () => {
  const items = [
    { key: "b:history", session: { time: { created: 10 } } },
    { key: "a:history", session: { time: { created: 10 } } },
    { key: "a:recent", session: { time: { created: 1, updated: 20 } } },
    { key: "a:child", session: { parentID: "recent", time: { created: 30 } } },
    { key: "a:archived", session: { time: { created: 40, archived: 50 } } },
  ];
  expect(sortedRoots(items).map((item) => item.key)).toEqual(["a:recent", "a:history", "b:history"]);
  expect(items[0]?.key).toBe("b:history");
});
test("current-turn classification preserves no-todo interruptions and removes older failures", () => {
  const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "work" }] }, { id: "a1", role: "assistant", metadata: { opencode: { stopped: true } }, parts: [] }];
  expect(sessionTaskPresentation(messages, [])).toMatchObject({ turnKey: "u1", resumable: true, active: false, stopped: true });
  messages.push({ id: "u2", role: "user", parts: [{ type: "text", text: "continue" }] }, { id: "a2", role: "assistant", metadata: { opencode: { finish: "stop" } }, parts: [{ type: "text", text: "done" }] });
  expect(sessionTaskPresentation(messages, [])).toMatchObject({ turnKey: "u2", resumable: false, active: false, stopped: false });
});

test("completed notifications use the conversation reply and require explicit terminal evidence", () => {
  const messages: UIMessage[] = [
    { id: "u", role: "user", parts: [{ type: "text", text: "hello" }] },
    { id: "a", role: "assistant", parts: [{ type: "text", text: "Hi，我在。要继续处理 PR 吗？" }] },
  ];
  expect(sessionTaskPresentation(messages, []).completed).toBe(false);
  messages[1]!.metadata = { opencode: { finish: "stop" } };
  expect(sessionTaskPresentation(messages, [])).toMatchObject({ completed: true, responseText: "Hi，我在。要继续处理 PR 吗？" });
  expect(sessionTaskPresentation(messages, [{ id: "t", content: "unfinished", status: "pending", priority: "high" }])).toMatchObject({ completed: false, resumable: true, responseText: undefined });
  messages[1]!.metadata = { opencode: { finish: "stop", stopped: true } };
  expect(sessionTaskPresentation(messages, [])).toMatchObject({ completed: false, resumable: true });
});

test("task previews omit reasoning and fall back to observable progress", () => {
  const messages: UIMessage[] = [
    { id: "u", role: "user", parts: [{ type: "text", text: "work" }] },
    { id: "a", role: "assistant", parts: [{ type: "reasoning", text: "private plan\ninternal details" }] },
  ];
  const activity = useSessionActivityStore.getState();
  activity.setRunStatus("preview-workspace", "preview-root", { type: "busy" });
  const record = useSessionActivityStore.getState().recordsByWorkspaceId["preview-workspace"]!["preview-root"]!;
  try {
    expect(sessionTaskPresentation(messages, [], record).progressText).toBeUndefined();
    expect(sessionTaskPresentation(messages, [{ id: "todo", content: "正在检查代码", status: "in_progress", priority: "high" }], record).progressText).toBe("正在检查代码");
    messages[1]!.parts.unshift({ type: "text", text: "正在读取配置\n更多说明" });
    expect(sessionTaskPresentation(messages, [], record).progressText).toBe("正在读取配置");
  } finally { activity.removeSession("preview-workspace", "preview-root"); }
});

test("current tools replace old commentary while waiting, idle and terminal replies retain their authority", () => {
  const store = useSessionActivityStore.getState(), workspace = "pet-tool-detail", session = "root";
  const messages: UIMessage[] = [
    { id: "u", role: "user", parts: [{ type: "text", text: "work" }] },
    { id: "a", role: "assistant", parts: [
      { type: "text", text: "Old commentary" },
      { type: "dynamic-tool", toolName: "task", toolCallId: "task", state: "input-available", input: { description: "Inspect implementation" } },
      { type: "dynamic-tool", toolName: "bash", toolCallId: "bash", state: "input-available", input: { command: "bun test --isolate", description: "Checks" } },
    ] },
  ];
  const present = () => sessionTaskPresentation(messages, [], useSessionActivityStore.getState().recordsByWorkspaceId[workspace]?.[session]);
  try {
    store.setRunStatus(workspace, session, { type: "busy" });
    expect(present()).toMatchObject({ active: true, currentToolName: "bash" });
    expect(present().progressText).toStartWith("bun test --isolate · ");
    messages[1]!.parts.push({ type: "dynamic-tool", toolName: "bash", toolCallId: "bash", state: "output-available", input: { command: "bun test --isolate" }, output: "done" });
    expect(present()).toMatchObject({ currentToolName: "task" });
    expect(present().progressText).toStartWith("Agent: Inspect implementation · ");
    store.setWaitingRequest(workspace, session, "permission", "approval", true);
    expect(present()).toMatchObject({ waiting: true, currentToolName: undefined });
    expect(present().progressText).toBe("Old commentary");
    store.setWaitingRequest(workspace, session, "permission", "approval", false);
    store.setRunStatus(workspace, session, { type: "idle" });
    expect(present()).toMatchObject({ active: false, currentToolName: undefined });
    messages[1]!.parts = [{ type: "text", text: "Final user-facing reply" }];
    messages[1]!.metadata = { opencode: { finish: "stop", completed: 3 } };
    expect(present()).toMatchObject({ completed: true, responseText: "Final user-facing reply", currentToolName: undefined });
  } finally { store.removeSession(workspace, session); }
});

test("a new root turn cannot surface tools still marked in flight in older history", () => {
  const store = useSessionActivityStore.getState(), workspace = "pet-current-turn", session = "root";
  const messages: UIMessage[] = [
    { id: "old-user", role: "user", parts: [{ type: "text", text: "old work" }] },
    { id: "old-tool", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "bash", toolCallId: "old-command", state: "input-available", input: { command: "old command" } }] },
    { id: "new-user", role: "user", parts: [{ type: "text", text: "new work" }] },
    { id: "new-reply", role: "assistant", parts: [{ type: "text", text: "Current commentary" }] },
  ];
  try {
    store.setRunStatus(workspace, session, { type: "busy" });
    expect(sessionTaskPresentation(messages, [], useSessionActivityStore.getState().recordsByWorkspaceId[workspace]?.[session])).toMatchObject({
      turnKey: "new-user", currentToolName: undefined, progressText: "Current commentary",
    });
  } finally { store.removeSession(workspace, session); }
});

test("pet display prefers current descendant execution over root delegation, with waiting first", () => {
  const base = sessionTaskPresentation([], []);
  const root = { ...base, active: true, currentToolName: "task", progressText: "Agent: Delegate" };
  const latest = { ...base, active: true, currentToolName: "bash", progressText: "bun test --isolate" };
  const older = { ...latest, progressText: "old command" };
  expect(selectPetTaskPresentation(root, [latest, older])).toBe(latest);
  const waiting = { ...base, waiting: true };
  expect(selectPetTaskPresentation(root, [latest, waiting])).toBe(waiting);
  expect(selectPetTaskPresentation({ ...root, waiting: true }, [latest]).waiting).toBe(true);
  expect(selectPetTaskPresentation(root, [{ ...latest, active: false }])).toBe(root);
  expect(selectPetTaskPresentation(base, [{ ...latest, active: false }])).toBe(base);
});
