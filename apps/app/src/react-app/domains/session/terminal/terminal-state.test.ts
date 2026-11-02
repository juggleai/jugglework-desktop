declare const test: (name: string, fn: () => Promise<void>) => void;
declare const expect: (value: unknown) => {
  toBe(value: unknown): void;
  toContain(value: string): void;
  rejects: { toThrow(value: string): Promise<void> };
};
import { captureTerminalTarget, consumeTerminalOutput } from "./terminal-state";
test("open captures action pane and cannot follow subsequent focus/workspace changes", async () => {
  const action = { workspaceId: "w", sessionId: "split-right", isRemoteWorkspace: false };
  const captured = captureTerminalTarget(action);
  action.sessionId = "primary"; action.workspaceId = "other";
  expect(captured.sessionId).toBe("split-right"); expect(captured.workspaceId).toBe("w");
});
test("cursor advances only after renderer consumes output; gap resets with warning", async () => {
  const writes: string[] = [];
  let release!: () => void;
  let done = false;
  const pending = consumeTerminalOutput(0, { cursor: 10, data: "hello", gap: true }, async (text) => {
    writes.push(text);
    if (text === "hello") await new Promise<void>((resolve) => { release = resolve; });
  }).then((cursor) => { done = true; return cursor; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(done).toBe(false); expect(writes[0]).toContain("truncated");
  release(); expect(await pending).toBe(10);
  await expect(consumeTerminalOutput(10, { cursor: 5, data: "", gap: false }, async () => {})).rejects.toThrow("backwards");
});
