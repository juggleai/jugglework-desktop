/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import type { ResolvedWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import type { JuggleWorkSessionMessage } from "../src/app/lib/jugglework-server";
import type { ReactSessionComposer } from "../src/react-app/domains/session/surface/composer/composer";

type ComposerProps = ComponentProps<typeof ReactSessionComposer>;
function Composer(props: ComposerProps) { return <div>{props.topAccessory}</div>; }
mock.module("../src/react-app/domains/session/surface/composer/composer", () => ({ ReactSessionComposer: Composer }));
mock.module("../src/react-app/domains/session/surface/composer/permission-mode-select", () => ({ PermissionModeSelect: () => null }));
mock.module("../src/react-app/domains/session/sync/use-session-permission-mode", () => ({ useSessionPermissionMode: () => ({ grants: [], supported: false }) }));
mock.module("../src/react-app/domains/cloud/desktop-config-provider", () => ({ useOrgRestrictions: () => ({}) }));
mock.module("../src/react-app/shell/workspace-provider", () => ({ WorkspaceProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("../src/app/lib/opencode", () => ({ createClient: () => ({}) }));
mock.module("../src/react-app/kernel/model-config", () => ({ readStoredDefaultModel: () => ({ providerID: "test", modelID: "model" }), writeStoredDefaultModel: () => {} }));
mock.module("../src/react-app/kernel/session-model-store", () => ({ readSessionChoices: () => ({}), setSessionModelChoice: () => {}, setSessionVariantChoice: () => {} }));
const i18n = await import("../src/i18n");
mock.module("../src/i18n", () => ({ ...i18n, currentLocale: () => "en" }));

const { ReviewSessionComposer } = await import("../src/react-app/domains/reviews/review-session-composer");
type Props = ComponentProps<typeof ReviewSessionComposer>;
type Request = Parameters<ResolvedWorkspaceEndpoint["client"]["startSessionRun"]>[2];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const start = mock(async (_workspace: string, _session: string, _request: Request): Promise<unknown> => ({}));
const messages = mock(async (_workspace: string, _session: string): Promise<{ items: JuggleWorkSessionMessage[] }> => ({ items: [] }));
const submitted = mock(async () => {});
const endpoint = {
  workspaceId: "source-workspace", opencodeBaseUrl: "http://localhost:1234",
  client: { startSessionRun: start, getSessionMessages: messages, listAutomationDependencies: async () => ({ models: [] }) },
} as unknown as ResolvedWorkspaceEndpoint;
let view: TestRenderer.ReactTestRenderer;
let props: Props;
const composer = () => view.root.findByType(Composer).props as ComposerProps;
const retry = () => view.root.findByType("button");
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function render(strict = false) {
  props = { endpoint, workspaceId: "review-workspace", sessionId: "review-session", systemPrompt: "PR context", messages: [], busy: true, onSubmitted: submitted };
  await act(async () => { view = TestRenderer.create(strict ? <StrictMode><ReviewSessionComposer {...props} /></StrictMode> : <ReviewSessionComposer {...props} />); });
}
async function update(next: Partial<Props> = {}, strict = false) {
  props = { ...props, ...next };
  await act(async () => { view.update(strict ? <StrictMode><ReviewSessionComposer {...props} /></StrictMode> : <ReviewSessionComposer {...props} />); });
}
async function queue(text: string, files: File[] = []) {
  await act(async () => { composer().onDraftChange(text); composer().onAttachFiles(files); });
  await act(async () => { composer().onQueue(); });
}
async function failQueued() {
  start.mockImplementation(async () => { throw new Error("Network response lost"); });
  await render();
  await queue("first");
  await update({ busy: false });
}
beforeEach(() => {
  start.mockReset(); start.mockImplementation(async () => ({}));
  messages.mockReset(); messages.mockImplementation(async () => ({ items: [] }));
  submitted.mockReset(); submitted.mockImplementation(async () => {});
});
afterEach(async () => { await act(async () => { view?.unmount(); }); });

test("a failed head stays queued and paused across rerenders, busy transitions and new drafts", async () => {
  await failQueued();
  expect(start).toHaveBeenCalledTimes(1);
  expect(composer().queuedCount).toBe(1);
  expect(JSON.stringify(view.toJSON())).toContain("Queue paused");
  for (let i = 0; i < 3; i++) {
    await update({ busy: true });
    await update({ busy: false });
  }
  await queue("second");
  expect(start).toHaveBeenCalledTimes(1);
  expect(composer().queuedCount).toBe(2);
});

test("explicit retries preserve the exact request, text, files and identities despite model changes", async () => {
  start.mockImplementation(async () => { throw new Error("Failed to fetch"); });
  await render();
  await queue("inspect [attachment review-att-placeholder] this", [new File(["file contents"], "notes.txt", { type: "text/plain" })]);
  expect(composer().draft).toBe("");
  expect(composer().attachments).toEqual([]);
  await update({ busy: false });
  const request = start.mock.calls[0]![2];
  expect(start.mock.calls[0]!.slice(0, 2)).toEqual(["review-workspace", "review-session"]);
  expect(request.prompt.parts).toEqual([{ type: "text", text: "inspect  this" }, { type: "file", filename: "notes.txt", mime: "text/plain", url: "data:text/plain;base64,ZmlsZSBjb250ZW50cw==" }]);
  expect(request.prompt.messageID).toStartWith("msg_review_");
  expect(request.startCommandCorrelationId).toBeTruthy();
  await act(async () => { composer().onModelChange({ providerID: "other", modelID: "other" }); });
  await act(async () => { retry().props.onClick(); });
  expect(start).toHaveBeenCalledTimes(2);
  expect(start.mock.calls[1]![2]).toBe(request);
  expect(messages).toHaveBeenCalledWith("review-workspace", "review-session");
  expect(composer().queuedCount).toBe(1);
  await update();
  expect(start).toHaveBeenCalledTimes(2);
});

test("an acknowledged turn discovered after a lost response is consumed without another POST", async () => {
  await failQueued();
  const messageID = start.mock.calls[0]![2].prompt.messageID!;
  messages.mockImplementation(async () => ({ items: [{ info: { id: messageID, role: "user" }, parts: [] }] as unknown as JuggleWorkSessionMessage[] }));
  await act(async () => { retry().props.onClick(); });
  expect(start).toHaveBeenCalledTimes(1);
  expect(composer().queuedCount).toBe(0);
  expect(submitted).toHaveBeenCalledTimes(1);
});

test("attachment preparation failure preserves its file and preview until an explicit retry succeeds", async () => {
  const createUrl = spyOn(URL, "createObjectURL").mockReturnValue("blob:queued-preview");
  const revokeUrl = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const file = new File(["image contents"], "image.png", { type: "image/png" });
  const readFile = spyOn(file, "arrayBuffer").mockRejectedValueOnce(new Error("File read failed"));
  try {
    await render();
    await queue("inspect the image", [file]);
    await update({ busy: false });
    expect(start).not.toHaveBeenCalled();
    expect(composer().queuedCount).toBe(1);
    expect(revokeUrl).not.toHaveBeenCalled();
    readFile.mockRestore();
    await act(async () => { retry().props.onClick(); });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![2].prompt.parts).toContainEqual(expect.objectContaining({ type: "file", filename: "image.png", mime: "image/png" }));
    expect(messages).not.toHaveBeenCalled();
    expect(revokeUrl).toHaveBeenCalledTimes(1);
    expect(revokeUrl).toHaveBeenCalledWith("blob:queued-preview");
    expect(composer().queuedCount).toBe(0);
  } finally {
    readFile.mockRestore(); createUrl.mockRestore(); revokeUrl.mockRestore();
  }
});

test("failed reconciliation does not risk another POST or lose the draft", async () => {
  await failQueued();
  messages.mockImplementation(async () => { throw new Error("Snapshot unavailable"); });
  await act(async () => { retry().props.onClick(); });
  expect(start).toHaveBeenCalledTimes(1);
  expect(composer().queuedCount).toBe(1);
  expect(JSON.stringify(view.toJSON())).toContain("Snapshot unavailable");
});

test("rapid retry clicks claim the head once; successful retry drains remaining drafts in FIFO order", async () => {
  await failQueued();
  await queue("second");
  const held = deferred();
  start.mockImplementationOnce(() => held.promise);
  start.mockImplementation(async () => ({}));
  await act(async () => { const click = retry().props.onClick; click(); click(); });
  expect(start).toHaveBeenCalledTimes(2);
  expect(composer().queuedCount).toBe(2);
  await act(async () => { held.resolve(); });
  expect(start).toHaveBeenCalledTimes(3);
  expect(start.mock.calls[2]![2].prompt.parts).toEqual([{ type: "text", text: "second" }]);
  expect(start.mock.calls[2]![2].prompt.messageID).not.toBe(start.mock.calls[0]![2].prompt.messageID);
  expect(composer().queuedCount).toBe(0);
});

test("refresh failure after server acknowledgement never requeues or retries the accepted turn", async () => {
  submitted.mockImplementation(async () => { throw new Error("Refresh failed"); });
  await render();
  await queue("first");
  await update({ busy: false });
  await update();
  expect(start).toHaveBeenCalledTimes(1);
  expect(composer().queuedCount).toBe(0);
  expect(JSON.stringify(view.toJSON())).toContain("Refresh failed");
  expect(view.root.findAllByType("button")).toHaveLength(0);
});

test("retrying the queue leaves newly composed unsent text and files untouched", async () => {
  await failQueued();
  const file = new File(["new contents"], "new.txt", { type: "text/plain" });
  await act(async () => { composer().onDraftChange("still editing"); composer().onAttachFiles([file]); });
  start.mockImplementation(async () => ({}));
  await act(async () => { retry().props.onClick(); });
  expect(composer().queuedCount).toBe(0);
  expect(composer().draft).toBe("still editing");
  expect(composer().attachments[0]?.file).toBe(file);
  expect(start).toHaveBeenCalledTimes(2);
});

test("disabled composers neither drain nor retry until allowed, and enabling does not resume a failed queue", async () => {
  await render();
  await queue("first");
  await update({ busy: false, disabled: true });
  expect(start).not.toHaveBeenCalled();
  start.mockImplementation(async () => { throw new Error("Unavailable"); });
  await update({ disabled: false });
  await update({ disabled: true });
  expect(retry().props.disabled).toBe(true);
  await act(async () => { retry().props.onClick(); });
  await update({ disabled: false });
  expect(start).toHaveBeenCalledTimes(1);
});

test("late failure from another session cannot restore its queue or pause the new session", async () => {
  const held = deferred();
  start.mockImplementationOnce(() => held.promise);
  await render();
  await queue("old session");
  await update({ busy: false });
  await update({ sessionId: "new-session", busy: true });
  await queue("new session");
  await act(async () => { held.reject(new Error("Old failure")); });
  expect(composer().queuedCount).toBe(1);
  expect(view.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  await update({ busy: false });
  expect(start.mock.calls[1]![1]).toBe("new-session");
  expect(composer().queuedCount).toBe(0);
});

test("switching directly to an idle session cannot drain the previous session's queued draft", async () => {
  await render();
  await queue("old session");
  await update({ sessionId: "new-session", busy: false });
  expect(start).not.toHaveBeenCalled();
  expect(composer().queuedCount).toBe(0);
  expect(view.root.findAllByProps({ role: "alert" })).toHaveLength(0);
});

test("StrictMode and rerenders while sending cannot dispatch the head twice", async () => {
  const held = deferred();
  start.mockImplementationOnce(() => held.promise);
  await render(true);
  await queue("first");
  await update({ busy: false }, true);
  await update({ systemPrompt: "updated context" }, true);
  expect(start).toHaveBeenCalledTimes(1);
  expect(composer().queuedCount).toBe(1);
  await act(async () => { held.resolve(); });
  expect(start).toHaveBeenCalledTimes(1);
  expect(composer().queuedCount).toBe(0);
});
