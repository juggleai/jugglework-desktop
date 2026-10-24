/** @jsxImportSource react */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import type { SessionFileArtifacts } from "@jugglework/types/file-artifacts";

let data: SessionFileArtifacts | undefined;
mock.module("../src/react-app/domains/session/artifacts/file-deliveries-provider", () => ({ useFileDeliveries: () => ({ data }) }));
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});
const { PresentationDeliveryCoordinator } = await import("../src/react-app/domains/session/presentation/presentation-delivery-coordinator");
const { resetPresentationDeliveryConsumptionForTest } = await import("../src/react-app/domains/session/presentation/presentation-delivery");
const { getPendingPresentationTurnIds, usePresentationPendingStore } = await import("../src/react-app/domains/session/presentation/presentation-pending-store");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let view: TestRenderer.ReactTestRenderer | undefined;

function ready(): SessionFileArtifacts {
  return {
    files: [{ artifactId: "artifact", workspaceId: "workspace", relativePath: "outputs/deck.pptx", name: "deck.pptx", kind: "file", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", sizeBytes: 10, updatedAt: 1, exists: true, editingOwner: "internal" }],
    turns: [{ sessionId: "session", turnId: "turn", runIds: ["run"], finishedRunIds: ["run"], status: "ready", targets: [], items: [{ sessionId: "session", turnId: "turn", artifactId: "artifact", snapshot: { name: "deck.pptx", sizeBytes: 10, updatedAt: 1 }, source: "runtime" }] }],
  };
}

beforeEach(() => {
  data = undefined;
  storage.clear();
  resetPresentationDeliveryConsumptionForTest();
  usePresentationPendingStore.setState({ turnsByWorkspaceId: {} });
});
afterEach(async () => { await act(async () => view?.unmount()); });

test("opens the exact ready PPTX once with presentation intent", async () => {
  const onOpenTarget = mock(() => undefined);
  usePresentationPendingStore.getState().add("workspace", "session", "turn");
  const node = () => <PresentationDeliveryCoordinator workspaceId="workspace" sessionId="session" onOpenTarget={onOpenTarget} />;
  await act(async () => { view = TestRenderer.create(node()); });
  data = ready();
  await act(async () => { view!.update(node()); });
  expect(onOpenTarget).toHaveBeenCalledTimes(1);
  expect(onOpenTarget.mock.calls[0]).toEqual([
    expect.objectContaining({ value: "outputs/deck.pptx", preview: "slides" }),
    { auto: true, intent: "presentation-creation" },
    "session",
  ]);
  expect(getPendingPresentationTurnIds(usePresentationPendingStore.getState(), "workspace", "session")).toEqual([]);
  await act(async () => { view!.update(node()); });
  expect(onOpenTarget).toHaveBeenCalledTimes(1);
});

test("does not consume ready delivery before an open handler exists", async () => {
  data = ready();
  usePresentationPendingStore.getState().add("workspace", "session", "turn");
  await act(async () => { view = TestRenderer.create(<PresentationDeliveryCoordinator workspaceId="workspace" sessionId="session" />); });
  expect(getPendingPresentationTurnIds(usePresentationPendingStore.getState(), "workspace", "session")).toEqual(["turn"]);
  const onOpenTarget = mock(() => undefined);
  await act(async () => { view!.update(<PresentationDeliveryCoordinator workspaceId="workspace" sessionId="session" onOpenTarget={onOpenTarget} />); });
  expect(onOpenTarget).toHaveBeenCalledTimes(1);
  expect(getPendingPresentationTurnIds(usePresentationPendingStore.getState(), "workspace", "session")).toEqual([]);
});

test("clears failed and partial terminal deliveries without opening", async () => {
  for (const status of ["failed", "partial"] as const) {
    data = ready();
    data.turns[0]!.status = status;
    const onOpenTarget = mock(() => undefined);
    usePresentationPendingStore.getState().add("workspace", "session", "turn");
    await act(async () => {
      view = TestRenderer.create(<PresentationDeliveryCoordinator workspaceId="workspace" sessionId="session" onOpenTarget={onOpenTarget} />);
    });
    expect(onOpenTarget).not.toHaveBeenCalled();
    expect(getPendingPresentationTurnIds(usePresentationPendingStore.getState(), "workspace", "session")).toEqual([]);
    await act(async () => view?.unmount());
    view = undefined;
  }
});
