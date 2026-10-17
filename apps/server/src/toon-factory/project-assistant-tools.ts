import type { ToonAssistantCanvasProposal, ToonAssistantGenerationProposal } from "@jugglework/types/toon-assistant";
import { toonAssistantCanvasProposalSchema, toonAssistantGenerationProposalSchema } from "@jugglework/types/toon-assistant";
import type { ToonWorkspaceCommand } from "@jugglework/types/toon-workspace";
import { ApiError } from "../errors.js";

export type ToonToolRisk = "read-only" | "reversible-mutation" | "destructive-mutation" | "external-paid";

export const TOON_ASSISTANT_TOOLS = Object.freeze([
  { name: "toon_project_read", risk: "read-only", action: "project.read" },
  { name: "toon_catalogs_read", risk: "read-only", action: "catalogs.read" },
  { name: "toon_canvas_read", risk: "read-only", action: "canvas.read" },
  { name: "toon_document_read", risk: "read-only", action: "document.read" },
  { name: "toon_asset_read", risk: "read-only", action: "asset.read" },
  { name: "toon_canvas_add_nodes", risk: "reversible-mutation", action: "canvas.write" },
  { name: "toon_canvas_move_nodes", risk: "reversible-mutation", action: "canvas.write" },
  { name: "toon_canvas_connect", risk: "reversible-mutation", action: "canvas.write" },
  { name: "toon_canvas_disconnect", risk: "reversible-mutation", action: "canvas.write" },
  { name: "toon_canvas_fit", risk: "reversible-mutation", action: "canvas.write" },
  { name: "toon_canvas_delete", risk: "destructive-mutation", action: "canvas.delete" },
  { name: "toon_generation_prepare", risk: "external-paid", action: "generation.prepare" },
] as const satisfies ReadonlyArray<{ name: string; risk: ToonToolRisk; action: string }>);

const forbiddenToolFragments = ["shell", "bash", "path", "credential", "provider", "script", "code", "umd", "marketplace", "router"];

export function validateToonAssistantToolRegistry(): void {
  for (const tool of TOON_ASSISTANT_TOOLS) {
    if (forbiddenToolFragments.some((fragment) => tool.name.includes(fragment))) throw new Error(`Unsafe Toon assistant tool: ${tool.name}`);
  }
}

const protectedWorkflowKinds = new Set(["content.approve", "workflow.skip", "compute.authorize", "candidate.adopt", "delivery.publish"]);

export function parseCanvasProposal(value: unknown, identity?: { conversationId: string; turnId: string; toolCallId: string }): ToonAssistantCanvasProposal {
  const parsed = toonAssistantCanvasProposalSchema.parse(value);
  const proposal = identity ? {
    ...parsed,
    conversationId: identity.conversationId,
    turnId: identity.turnId,
    toolCallId: identity.toolCallId,
    command: { ...parsed.command, actor: { kind: "assistant" as const, id: identity.toolCallId }, origin: "assistant-tool" as const },
  } : parsed;
  if (protectedWorkflowKinds.has(proposal.command.kind)) throw new ApiError(400, "toon_protected_transition_required", "Protected workflow transitions require a dedicated human interaction");
  if (proposal.command.origin !== "assistant-tool" || proposal.command.actor.kind !== "assistant") throw new ApiError(400, "toon_canvas_proposal_origin_invalid", "Assistant canvas proposals require assistant-tool audit origin");
  if (proposal.command.actor.id !== proposal.toolCallId) throw new ApiError(400, "toon_canvas_proposal_origin_invalid", "Assistant canvas proposals must identify their originating tool call");
  if (proposal.risk === "destructive-mutation" && !proposal.requiresConfirmation) throw new ApiError(400, "toon_canvas_confirmation_required", "Destructive canvas proposals require explicit confirmation");
  const destructive = ["canvas.delete", "document.delete", "asset.delete"].includes(proposal.command.kind);
  if (destructive !== (proposal.risk === "destructive-mutation")) throw new ApiError(400, "toon_canvas_proposal_risk_invalid", "Canvas proposal risk does not match the semantic command");
  const expected = commandAffected(proposal.command);
  if (JSON.stringify(normalizeAffected(proposal.affected)) !== JSON.stringify(normalizeAffected(expected))) throw new ApiError(400, "toon_canvas_proposal_affected_invalid", "Canvas proposal affected IDs do not match the semantic command");
  return proposal;
}

export function isSafeAssistantCommand(command: ToonWorkspaceCommand): boolean {
  return ["canvas.rename", "canvas.move", "canvas.duplicate", "canvas.delete", "canvas.restore", "canvas.write"].includes(command.kind);
}

export function parseGenerationProposal(value: unknown): ToonAssistantGenerationProposal {
  return toonAssistantGenerationProposalSchema.parse(value);
}

function commandAffected(command: ToonWorkspaceCommand): ToonAssistantCanvasProposal["affected"] {
  if (command.kind === "canvas.create") return [{ kind: "canvas", id: command.canvas.id }];
  if (command.kind === "canvas.duplicate") return [{ kind: "canvas", id: command.newCanvasId }];
  if (command.kind === "document.create") return [{ kind: "document", id: command.document.id }];
  if ("canvasId" in command) return [{ kind: "canvas", id: command.canvasId }];
  if ("documentId" in command) return [{ kind: "document", id: command.documentId }];
  if ("assetId" in command) return [{ kind: "asset", id: command.assetId }];
  return [];
}

function normalizeAffected(affected: ToonAssistantCanvasProposal["affected"]): string[] {
  return affected.map((reference) => `${reference.kind}:${reference.id}:${reference.revision ?? ""}`).sort();
}

validateToonAssistantToolRegistry();
