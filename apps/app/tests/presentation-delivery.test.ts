import { beforeEach, describe, expect, test } from "bun:test";
import type { SessionFileArtifacts } from "@jugglework/types/file-artifacts";
import {
  consumePresentationDelivery,
  presentationDeliveryTerminal,
  resetPresentationDeliveryConsumptionForTest,
  resolvePresentationDelivery,
} from "../src/react-app/domains/session/presentation/presentation-delivery";
import { allowsAutomaticFileOpen } from "../src/lib/target-provider";

function deliveries(status: "collecting" | "ready" | "partial" | "failed", paths: string[]): SessionFileArtifacts {
  const files = paths.map((relativePath, index) => ({
    artifactId: `artifact-${index}`, workspaceId: "workspace", relativePath,
    name: relativePath.split("/").at(-1)!, kind: "file", mimeType: "application/octet-stream",
    sizeBytes: 100, updatedAt: 10, exists: true, editingOwner: "internal" as const,
  }));
  return {
    files,
    turns: [{
      sessionId: "session", turnId: "turn", runIds: ["run"], finishedRunIds: status === "collecting" ? [] : ["run"], status, targets: [],
      items: files.map((file) => ({ sessionId: "session", turnId: "turn", artifactId: file.artifactId, snapshot: { name: file.name, sizeBytes: 100, updatedAt: 10 }, source: "runtime" as const })),
    }],
  };
}

beforeEach(() => {
  resetPresentationDeliveryConsumptionForTest();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined },
  });
});

describe("presentation delivery", () => {
  test("resolves only the exact ready turn with one existing PPTX", () => {
    expect(resolvePresentationDelivery(deliveries("collecting", ["deck.pptx"]), "session", "turn")).toBeNull();
    expect(resolvePresentationDelivery(deliveries("partial", ["deck.pptx"]), "session", "turn")).toBeNull();
    expect(resolvePresentationDelivery(deliveries("ready", ["deck.pptx"]), "session", "other")).toBeNull();
    expect(resolvePresentationDelivery(deliveries("ready", ["one.pptx", "two.pptx"]), "session", "turn")).toBeNull();
    expect(resolvePresentationDelivery(deliveries("ready", ["notes.pdf"]), "session", "turn")).toBeNull();
    expect(resolvePresentationDelivery(deliveries("ready", ["deck.pptx", "notes.pdf"]), "session", "turn")).toMatchObject({
      artifactId: "artifact-0",
      target: { value: "deck.pptx", preview: "slides", reason: "presentation-creation" },
    });
  });

  test("recognizes terminal failure and consumes a result once", () => {
    expect(presentationDeliveryTerminal(deliveries("failed", []), "session", "turn")).toBe(true);
    expect(presentationDeliveryTerminal(deliveries("collecting", []), "session", "turn")).toBe(false);
    expect(consumePresentationDelivery("workspace", "session", "turn", "artifact")).toBe(true);
    expect(consumePresentationDelivery("workspace", "session", "turn", "artifact")).toBe(false);
    expect(consumePresentationDelivery("other-workspace", "session", "turn", "artifact")).toBe(true);
  });

  test("preserves no-auto-open except for explicit presentation creation", () => {
    expect(allowsAutomaticFileOpen(undefined)).toBe(true);
    expect(allowsAutomaticFileOpen({ auto: false })).toBe(true);
    expect(allowsAutomaticFileOpen({ auto: true })).toBe(false);
    expect(allowsAutomaticFileOpen({ auto: true, intent: "presentation-creation" })).toBe(true);
  });
});
