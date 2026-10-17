import { expect, test } from "bun:test";
import { TOON_ASSISTANT_TOOLS, parseCanvasProposal, parseGenerationProposal, validateToonAssistantToolRegistry } from "./project-assistant-tools.js";

test("Toon assistant registry excludes arbitrary execution capabilities", () => {
  expect(() => validateToonAssistantToolRegistry()).not.toThrow();
  expect(TOON_ASSISTANT_TOOLS.map((tool) => tool.name).join(" ")).not.toMatch(/shell|bash|path|credential|dynamic|script|umd|provider/i);
});

test("assistant mutations are semantic proposals and destructive changes require confirmation", () => {
  const proposal = { id: "proposal-1", conversationId: "conversation-1", turnId: "turn-1", toolCallId: "tool-1", risk: "destructive-mutation", summary: "Delete canvas", affected: [{ kind: "canvas", id: "main" }], command: { operationId: "operation-1", actor: { kind: "assistant", id: "tool-1" }, origin: "assistant-tool", expectedRevisions: {}, kind: "canvas.delete", canvasId: "main" }, requiresConfirmation: false };
  expect(() => parseCanvasProposal(proposal)).toThrow("explicit confirmation");
  expect(parseCanvasProposal({ ...proposal, requiresConfirmation: true }).command.kind).toBe("canvas.delete");
});

test("paid tools prepare exact plans without submitting or authorizing them", () => {
  const proposal = parseGenerationProposal({ id: "generation-1", conversationId: "conversation-1", turnId: "turn-1", state: "awaiting-human-authorization", requestId: "request-1", episodeId: "episode-1", workflowRecordId: "video-clips", canvasId: "main", nodeId: "video-node", expectedRevisions: { "toon-project.json": "a".repeat(64), "catalogs/canvases.json": "b".repeat(64), "canvases/main.json": "c".repeat(64) }, plan: { kind: "video", model: { kind: "video", providerID: "provider", modelID: "video" }, object: "clip", quantity: 1, prompt: "Animate", references: [], parameters: { durationSeconds: 5, resolution: "720p" }, executionCount: 1, knownCost: null } });
  expect(proposal.state).toBe("awaiting-human-authorization");
  expect(JSON.stringify(proposal)).not.toMatch(/authorized|submitted|apiKey/i);
});
