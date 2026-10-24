/** @jsxImportSource react */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import type { SessionFileArtifacts } from "@jugglework/types/file-artifacts";

let data: SessionFileArtifacts | undefined;
mock.module("../src/react-app/domains/session/artifacts/file-deliveries-provider", () => ({ useFileDeliveries: () => ({ data }) }));
const { PresentationDeliveryCoordinator } = await import("../src/react-app/domains/session/presentation/presentation-delivery-coordinator");
const { resetPresentationDeliveryConsumptionForTest } = await import("../src/react-app/domains/session/presentation/presentation-delivery");
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
  resetPresentationDeliveryConsumptionForTest();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined } });
});
afterEach(async () => { await act(async () => view?.unmount()); });

test("opens the exact ready PPTX once with presentation intent", async () => {
  const onOpenTarget = mock(() => undefined);
  const onFinished = mock(() => undefined);
  const node = () => <PresentationDeliveryCoordinator sessionId="session" turnId="turn" onOpenTarget={onOpenTarget} onFinished={onFinished} />;
  await act(async () => { view = TestRenderer.create(node()); });
  data = ready();
  await act(async () => { view!.update(node()); });
  expect(onOpenTarget).toHaveBeenCalledTimes(1);
  expect(onOpenTarget.mock.calls[0]).toEqual([
    expect.objectContaining({ value: "outputs/deck.pptx", preview: "slides" }),
    { auto: true, intent: "presentation-creation" },
    "session",
  ]);
  expect(onFinished).toHaveBeenCalledWith("turn");
  await act(async () => { view!.update(node()); });
  expect(onOpenTarget).toHaveBeenCalledTimes(1);
});

test("does not consume ready delivery before an open handler exists", async () => {
  data = ready();
  const onFinished = mock(() => undefined);
  await act(async () => { view = TestRenderer.create(<PresentationDeliveryCoordinator sessionId="session" turnId="turn" onFinished={onFinished} />); });
  expect(onFinished).not.toHaveBeenCalled();
  const onOpenTarget = mock(() => undefined);
  await act(async () => { view!.update(<PresentationDeliveryCoordinator sessionId="session" turnId="turn" onOpenTarget={onOpenTarget} onFinished={onFinished} />); });
  expect(onOpenTarget).toHaveBeenCalledTimes(1);
});

test("finishes failed or ambiguous terminal delivery without opening", async () => {
  data = ready();
  data.turns[0]!.status = "failed";
  const onOpenTarget = mock(() => undefined);
  const onFinished = mock(() => undefined);
  await act(async () => { view = TestRenderer.create(<PresentationDeliveryCoordinator sessionId="session" turnId="turn" onOpenTarget={onOpenTarget} onFinished={onFinished} />); });
  expect(onOpenTarget).not.toHaveBeenCalled();
  expect(onFinished).toHaveBeenCalledWith("turn");
});
