import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { ToonProjectAssistant } from "../src/react-app/domains/toon-factory/workspace/toon-project-assistant";

const model = { providerID: "provider", modelID: "text", providerName: "Provider", modelName: "Text", providerSource: "custom" as const };
const conversation = { id: "conversation-1", projectId: "project-1", title: "Project assistant", model: { kind: "text" as const, providerID: "provider", modelID: "text" }, visibility: "toon_project_assistant" as const, archived: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).window = { prompt: () => null };
  (globalThis as any).document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
});
afterEach(() => { delete (globalThis as any).window; delete (globalThis as any).document; delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });

function client(overrides: Record<string, unknown> = {}) {
  const calls = { sends: [] as any[], edits: [] as any[], warnings: [] as any[], events: 0, stops: 0 };
  return {
    calls,
    api: {
      baseUrl: "http://server-a",
      listToonAssistantConversations: async () => [conversation],
      getToonAssistantSnapshot: async () => ({ conversation, messages: [], interactions: [], canvasProposals: [], subagents: [], activeTurnId: null, cursor: null }),
      createToonAssistantConversation: async () => conversation,
      updateToonAssistantConversation: async () => conversation,
      deleteToonAssistantConversation: async () => ({ deleted: true as const }),
      sendToonAssistantMessage: async (...args: any[]) => { calls.sends.push(args); return { accepted: true as const, turnId: "turn-1", branchId: "branch-1", cursor: "1", contextDiagnostics: [] }; },
      stopToonAssistantTurn: async () => { calls.stops += 1; return { version: 1 as const, id: "stop", sequence: 1, workspaceId: "workspace-1", projectId: "project-1", conversationId: "conversation-1", type: "turn.status" as const, data: {}, createdAt: "2026-01-01T00:00:00.000Z" }; },
      acknowledgeToonAssistantRemoteWarning: async (...args: any[]) => { calls.warnings.push(args); return { acknowledged: true as const, turnId: args.at(-1).turnId }; },
      editResendToonAssistantMessage: async (...args: any[]) => { calls.edits.push(args); return { accepted: true as const, turnId: "turn-2", branchId: "branch-2", cursor: "2", contextDiagnostics: [] }; },
      listToonAssistantEvents: async () => { calls.events += 1; return { items: [], cursor: null, hasMore: false }; },
      listToonAssistantCompletions: async () => ({ items: [], limit: 50 as const, truncated: false }),
      replyToonAssistantInteraction: async () => ({ item: {} }),
      executeToonAssistantCanvasProposal: async () => { throw new Error("No proposal"); },
      ...overrides,
    },
  };
}

describe("Toon project assistant UI", () => {
  test("sends the home intent as the first persistent user message", async () => {
    const fake = client();
    let consumed = 0;
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<ToonProjectAssistant client={fake.api as any} workspaceId="workspace-1" projectId="project-1" visible textModels={[model]} defaultModel={{ kind: "text", providerID: "provider", modelID: "text" }} initialPrompt="Create a moonlit story" onInitialPromptConsumed={() => { consumed += 1; }} onClose={() => {}} />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fake.calls.sends).toHaveLength(1);
    expect(fake.calls.sends[0]?.[3]).toMatchObject({ text: "Create a moonlit story", model: { kind: "text", providerID: "provider", modelID: "text" } });
    expect(consumed).toBe(1);
    await act(async () => { renderer.unmount(); });
  });

  test("hidden retained assistant pauses polling without stopping the server turn", async () => {
    const fake = client();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<ToonProjectAssistant client={fake.api as any} workspaceId="workspace-1" projectId="project-1" visible={false} textModels={[model]} defaultModel={{ kind: "text", providerID: "provider", modelID: "text" }} onClose={() => {}} />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(fake.calls.events).toBe(0);
    expect(fake.calls.stops).toBe(0);
    await act(async () => { renderer.unmount(); });
  });

  test("edit-and-resend displays the accepted pending replacement state", async () => {
    const userMessage = { id: "message-old", conversationId: conversation.id, turnId: "turn-old", branchId: "branch-old", role: "user" as const, status: "completed" as const, parts: [{ type: "text" as const, text: "Original" }], attachments: [], mentions: [], contextDiagnostics: [], createdAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:00.000Z" };
    (globalThis as any).window.prompt = () => "Edited";
    const fake = client({
      getToonAssistantSnapshot: async () => ({ conversation, messages: [userMessage], interactions: [], canvasProposals: [], subagents: [], activeTurnId: "turn-old", cursor: null }),
      editResendToonAssistantMessage: async (...args: any[]) => { fake.calls.edits.push(args); return { accepted: true as const, pending: true, turnId: "turn-new", branchId: "branch-new", cursor: "2", contextDiagnostics: [] }; },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<ToonProjectAssistant client={fake.api as any} workspaceId="workspace-1" projectId="project-1" visible textModels={[model]} defaultModel={conversation.model} onClose={() => {}} />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const edit = renderer.root.findAllByType("button").find((button) => button.props.title === "Edit and resend")!;
    await act(async () => { await edit.props.onClick(); });
    expect(fake.calls.edits).toHaveLength(1);
    expect(renderer.root.findAllByProps({ role: "status" }).some((item) => item.children.some((child: unknown) => child === "Stopping the current turn before starting the edited replacement..."))).toBe(true);
    await act(async () => { renderer.unmount(); });
  });

  test("renders archived branches and keeps remote continuation warning until explicit acknowledgement", async () => {
    let acknowledged = false;
    const branchSnapshot = () => ({
      conversation, messages: [], interactions: [], canvasProposals: [], subagents: [], activeTurnId: null, activeBranchId: "branch-new", cursor: null,
      branches: [
        { id: "branch-old", fromMessageId: null, turnIds: ["turn-old"], remoteMayContinue: true, active: false, createdAt: conversation.createdAt },
        { id: "branch-new", fromMessageId: "message-old", turnIds: ["turn-new"], remoteMayContinue: false, active: true, createdAt: conversation.createdAt },
      ],
      remoteContinueWarnings: acknowledged ? [] : [{ turnId: "turn-old", branchId: "branch-old", status: "interrupted" as const, remoteMayContinue: true as const, createdAt: conversation.createdAt }],
    });
    const fake = client({
      getToonAssistantSnapshot: async () => branchSnapshot(),
      acknowledgeToonAssistantRemoteWarning: async (...args: any[]) => { fake.calls.warnings.push(args); acknowledged = true; return { acknowledged: true as const, turnId: "turn-old" }; },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<ToonProjectAssistant client={fake.api as any} workspaceId="workspace-1" projectId="project-1" visible textModels={[model]} defaultModel={conversation.model} onClose={() => {}} />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(renderer.root.findByProps({ "data-testid": "toon-assistant-remote-warning" })).toBeTruthy();
    expect(renderer.root.findByProps({ "data-testid": "toon-assistant-branches" })).toBeTruthy();
    const acknowledge = renderer.root.findAllByType("button").find((button) => button.children.includes("Acknowledge"))!;
    await act(async () => { await acknowledge.props.onClick(); });
    expect(fake.calls.warnings[0]?.slice(0, 3)).toEqual(["workspace-1", "project-1", "conversation-1"]);
    expect(renderer.root.findAllByProps({ "data-testid": "toon-assistant-remote-warning" })).toHaveLength(0);
    await act(async () => { renderer.unmount(); });
  });

  test("narrow layout exposes an accessible modal sheet and history controls", async () => {
    const fake = client();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<ToonProjectAssistant client={fake.api as any} workspaceId="workspace-1" projectId="project-1" visible textModels={[model]} narrow defaultModel={{ kind: "text", providerID: "provider", modelID: "text" }} onClose={() => {}} />); });
    const dialog = renderer.root.findByProps({ "data-testid": "toon-project-assistant-ui" });
    expect(dialog.props.role).toBe("dialog");
    expect(dialog.props["aria-modal"]).toBe(true);
    const history = renderer.root.findAllByProps({ title: "Conversation history" })[0]!;
    await act(async () => { history.props.onClick(); });
    expect(renderer.root.findByProps({ "data-testid": "toon-assistant-history" })).toBeTruthy();
    await act(async () => { renderer.unmount(); });
  });

  test("shows deleting cleanup pending, retries it, and disables new sends", async () => {
    const deleting = { ...conversation, state: "deleting" as const, cleanup: { pending: true as const, totalSessions: 3, completedSessions: 1, lastError: "temporary delete failure", updatedAt: conversation.updatedAt } };
    let deletes = 0;
    const fake = client({
      listToonAssistantConversations: async () => [deleting],
      getToonAssistantSnapshot: async () => ({ conversation: deleting, messages: [], interactions: [], canvasProposals: [], subagents: [], branches: [], remoteContinueWarnings: [], activeTurnId: null, activeBranchId: null, cursor: null }),
      deleteToonAssistantConversation: async () => { deletes += 1; return { deleted: false as const, cleanupPending: true as const }; },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<ToonProjectAssistant client={fake.api as any} workspaceId="workspace-cleanup" projectId="project-cleanup" visible textModels={[model]} defaultModel={conversation.model} onClose={() => {}} />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const pending = renderer.root.findByProps({ "data-testid": "toon-assistant-cleanup-pending" });
    expect(pending.findAllByType("p").some((item) => item.children.includes("temporary delete failure"))).toBe(true);
    expect(renderer.root.findByType("textarea").props.disabled).toBe(true);
    const retry = pending.findAllByType("button").find((button) => button.children.includes("Retry cleanup"))!;
    await act(async () => { await retry.props.onClick(); });
    expect(deletes).toBe(1);
    expect(fake.calls.sends).toHaveLength(0);
    await act(async () => { renderer.unmount(); });
  });

  test("requires an explicit canvas proposal decision and reports the committed outcome", async () => {
    const proposal = {
      id: "proposal-1", conversationId: conversation.id, turnId: "turn-1", toolCallId: "tool-1", risk: "reversible-mutation" as const, summary: "Add a scene", affected: [{ kind: "canvas" as const, id: "main" }], requiresConfirmation: true,
      command: { operationId: "operation-1", actor: { kind: "assistant" as const, id: "tool-1" }, origin: "assistant-tool" as const, expectedRevisions: { "canvases/main.json": "a".repeat(64) }, kind: "canvas.write" as const, canvasId: "main", body: { schemaVersion: 2 as const, id: "main", nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } },
    };
    const outcome = { operationId: "operation-1", payloadHash: "b".repeat(64), status: "committed" as const, origin: "assistant-tool" as const, actor: { kind: "assistant" as const, id: "tool-1" }, affected: proposal.affected, revisions: { "canvases/main.json": "c".repeat(64) }, committedAt: "2026-01-01T00:00:00.000Z" };
    let executions = 0;
    let committed = 0;
    const fake = client({
      getToonAssistantSnapshot: async () => ({ conversation, messages: [], interactions: [], canvasProposals: [{ proposal, state: executions ? "committed" as const : "proposed" as const, ...(executions ? { outcome } : {}) }], subagents: [], activeTurnId: null, cursor: null }),
      executeToonAssistantCanvasProposal: async (...args: any[]) => { executions += 1; expect(args.at(-1)).toEqual({ decision: "approve" }); return { proposal, outcome, decision: "approve" as const }; },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<ToonProjectAssistant client={fake.api as any} workspaceId="workspace-1" projectId="project-1" visible textModels={[model]} defaultModel={{ kind: "text", providerID: "provider", modelID: "text" }} beforeCanvasProposalExecute={async () => true} onCanvasProposalCommitted={() => { committed += 1; }} onClose={() => {}} />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const card = renderer.root.findByProps({ "data-testid": "toon-assistant-canvas-proposal" });
    const apply = card.findAllByType("button").find((button) => button.children.includes("Apply"))!;
    expect(executions).toBe(0);
    await act(async () => { await apply.props.onClick(); });
    expect(executions).toBe(1);
    expect(committed).toBe(1);
    await act(async () => { renderer.unmount(); });
  });

  test("deny is an explicit terminal decision and never reports a committed mutation", async () => {
    const proposal = {
      id: "proposal-deny", conversationId: conversation.id, turnId: "turn-1", toolCallId: "tool-deny", risk: "reversible-mutation" as const, summary: "Move a scene", affected: [{ kind: "canvas" as const, id: "main" }], requiresConfirmation: true,
      command: { operationId: "operation-deny", actor: { kind: "assistant" as const, id: "tool-deny" }, origin: "assistant-tool" as const, expectedRevisions: { "canvases/main.json": "a".repeat(64) }, kind: "canvas.write" as const, canvasId: "main", body: { schemaVersion: 2 as const, id: "main", nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } },
    };
    let decision: string | null = null;
    let committed = 0;
    const fake = client({
      getToonAssistantSnapshot: async () => ({ conversation, messages: [], interactions: [], canvasProposals: [{ proposal, state: decision ? "denied" as const : "proposed" as const }], subagents: [], activeTurnId: null, cursor: null }),
      executeToonAssistantCanvasProposal: async (...args: any[]) => { decision = args.at(-1).decision; return { proposal, decision: "deny" as const }; },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<ToonProjectAssistant client={fake.api as any} workspaceId="workspace-1" projectId="project-1" visible textModels={[model]} defaultModel={{ kind: "text", providerID: "provider", modelID: "text" }} onCanvasProposalCommitted={() => { committed += 1; }} onClose={() => {}} />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const card = renderer.root.findByProps({ "data-testid": "toon-assistant-canvas-proposal" });
    const deny = card.findAllByType("button").find((button) => button.children.includes("Deny"))!;
    await act(async () => { await deny.props.onClick(); });
    expect(decision).toBe("deny");
    expect(committed).toBe(0);
    await act(async () => { renderer.unmount(); });
  });

  test("drops a retained conversation that is absent from the scoped list", async () => {
    const first = client();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<ToonProjectAssistant client={first.api as any} workspaceId="workspace-membership" projectId="project-membership" visible textModels={[model]} defaultModel={{ kind: "text", providerID: "provider", modelID: "text" }} onClose={() => {}} />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); renderer.unmount(); });
    let snapshots = 0;
    const second = client({ baseUrl: "http://server-a", listToonAssistantConversations: async () => [], getToonAssistantSnapshot: async () => { snapshots += 1; throw new Error("must not address a foreign conversation"); } });
    await act(async () => { renderer = TestRenderer.create(<ToonProjectAssistant client={second.api as any} workspaceId="workspace-membership" projectId="project-membership" visible textModels={[model]} defaultModel={{ kind: "text", providerID: "provider", modelID: "text" }} onClose={() => {}} />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(snapshots).toBe(0);
    await act(async () => { renderer.unmount(); });
  });

  test("keeps the existing conversation model immutable in the selector", async () => {
    const fixedConversation = { ...conversation, model: { kind: "text" as const, providerID: "provider", modelID: "text" } };
    const fake = client({ listToonAssistantConversations: async () => [fixedConversation], getToonAssistantSnapshot: async () => ({ conversation: fixedConversation, messages: [], interactions: [], canvasProposals: [], subagents: [], activeTurnId: null, cursor: null }) });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<ToonProjectAssistant client={fake.api as any} workspaceId="workspace-model" projectId="project-model" visible textModels={[model]} defaultModel={{ kind: "text", providerID: "other", modelID: "other" }} onClose={() => {}} />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const selector = renderer.root.findByType("select");
    expect(selector.props.disabled).toBe(true);
    expect(selector.props.value).toBe("provider\u0000text");
    await act(async () => { renderer.unmount(); });
  });

  test("keeps exact generation authorization and paid submission as separate UI actions", async () => {
    const proposal = { id: "generation-1", conversationId: conversation.id, turnId: "turn-1", state: "awaiting-human-authorization" as const, requestId: "request-1", episodeId: "episode-1", workflowRecordId: "images", canvasId: "main", nodeId: "image-node", plan: { kind: "image" as const, model: { kind: "image" as const, providerID: "images", modelID: "model" }, object: "frame", quantity: 1, prompt: "Draw", references: [], parameters: { mode: "text-to-image", size: "1024x1024" }, executionCount: 1, knownCost: null } };
    const interaction = { id: "compute-generation-1", conversationId: conversation.id, turnId: "turn-1", sessionId: "session-1", kind: "compute-authorization" as const, state: "pending" as const, payload: { proposal }, createdAt: "2026-01-01T00:00:00.000Z" };
    const planSummary = { kind: "image" as const, model: proposal.plan.model, object: "frame", quantity: 1, prompt: "Draw", referencePaths: [], referenceScope: "project" as const, executionCount: 1, knownCost: null, mode: "text-to-image" as const, size: "1024x1024" };
    let authorizations = 0; let submissions = 0; let authorization: { authorizationId: string; requestId: string; planFingerprint: string; planSummary: typeof planSummary; expiresAt: string; consumedAt: null; state: "valid" } | null = null;
    const generation = { ...proposal, source: "assistant" as const, requestHash: "a".repeat(64), revision: "b".repeat(64), status: "awaiting-human-authorization" as const, dependencyLinks: [], candidates: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const fake = client({
      getToonAssistantSnapshot: async () => ({ conversation, messages: [], interactions: [interaction], canvasProposals: [], subagents: [], activeTurnId: null, cursor: null }),
      authorizeToonWorkspaceGeneration: async () => { authorizations += 1; authorization = { authorizationId: "authorization-1", requestId: proposal.requestId, planFingerprint: generation.requestHash, planSummary, expiresAt: "2026-01-01T00:05:00.000Z", consumedAt: null, state: "valid" }; return { authorizationId: "authorization-1", requestHash: generation.requestHash, planFingerprint: generation.requestHash, planSummary, requestSnapshot: { requestId: proposal.requestId }, expiresAt: authorization.expiresAt }; },
      submitToonWorkspaceGeneration: async (_workspaceId: string, _projectId: string, _generationId: string, input: Record<string, unknown>) => { submissions += 1; expect(input).toEqual({ authorizationId: "authorization-1", expectedPlanFingerprint: generation.requestHash }); return { job: { id: "job-1", status: "submitted", candidates: [] } }; },
      getToonWorkspaceGeneration: async () => ({ generation, job: null, authorization }),
      queryToonWorkspace: async () => { throw new Error("No references expected"); },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<ToonProjectAssistant client={fake.api as any} workspaceId="workspace-1" projectId="project-1" visible textModels={[model]} defaultModel={conversation.model} onClose={() => {}} />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const authorize = renderer.root.findAllByType("button").find((button) => button.children.includes("Authorize batch"))!;
    await act(async () => { await authorize.props.onClick(); });
    expect(authorizations).toBe(1); expect(submissions).toBe(0);
    const submit = renderer.root.findAllByType("button").find((button) => button.children.includes("Submit generation"))!;
    await act(async () => { await submit.props.onClick(); });
    expect(submissions).toBe(1);
    await act(async () => { renderer.unmount(); });
  });

  test("restores a valid authorization after reload and does not resubmit a consumed authorization", async () => {
    const proposal = { id: "generation-reload", conversationId: conversation.id, turnId: "turn-reload", state: "awaiting-human-authorization" as const, requestId: "request-reload", episodeId: "episode-1", workflowRecordId: "images", canvasId: "main", nodeId: "image-node", plan: { kind: "image" as const, model: { kind: "image" as const, providerID: "images", modelID: "model" }, object: "frame", quantity: 1, prompt: "Draw", references: [], parameters: { mode: "text-to-image", size: "1024x1024" }, executionCount: 1, knownCost: null } };
    const interaction = { id: "compute-generation-reload", conversationId: conversation.id, turnId: "turn-reload", sessionId: "session-1", kind: "compute-authorization" as const, state: "resolved" as const, payload: { proposal }, answer: { authorizationId: "authorization-reload" }, createdAt: "2026-01-01T00:00:00.000Z", resolvedAt: "2026-01-01T00:00:01.000Z" };
    const generation = { ...proposal, source: "assistant" as const, requestHash: "a".repeat(64), revision: "b".repeat(64), status: "awaiting-human-authorization" as const, dependencyLinks: [], candidates: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const planSummary = { kind: "image" as const, model: proposal.plan.model, object: "frame", quantity: 1, prompt: "Draw", referencePaths: [], referenceScope: "project" as const, executionCount: 1, knownCost: null, mode: "text-to-image" as const, size: "1024x1024" };
    let consumed = false; let submissions = 0;
    const fake = client({
      getToonAssistantSnapshot: async () => ({ conversation, messages: [], interactions: [interaction], canvasProposals: [], subagents: [], activeTurnId: null, cursor: null }),
      getToonWorkspaceGeneration: async () => ({ generation, job: consumed ? { id: "job-reload", status: "submitted", candidates: [] } : null, authorization: { authorizationId: "authorization-reload", requestId: proposal.requestId, planFingerprint: generation.requestHash, planSummary, expiresAt: "2026-01-01T00:05:00.000Z", consumedAt: consumed ? "2026-01-01T00:00:02.000Z" : null, state: consumed ? "consumed" as const : "valid" as const } }),
      submitToonWorkspaceGeneration: async () => { submissions += 1; consumed = true; return { job: { id: "job-reload", status: "submitted", candidates: [] } }; },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<ToonProjectAssistant client={fake.api as any} workspaceId="workspace-1" projectId="project-1" visible textModels={[model]} defaultModel={conversation.model} onClose={() => {}} />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const submit = renderer.root.findAllByType("button").find((button) => button.children.includes("Submit generation"))!;
    expect(submit).toBeTruthy();
    await act(async () => { await submit.props.onClick(); });
    expect(submissions).toBe(1);
    expect(renderer.root.findAllByType("button").some((button) => button.children.includes("Submit generation"))).toBe(false);
    expect(renderer.root.findByProps({ "data-testid": "toon-generation-authorization-state" }).children).toContain("consumed");
    await act(async () => { renderer.unmount(); });
  });

  test("recovers submit after the authorize response is lost", async () => {
    const proposal = { id: "generation-lost", conversationId: conversation.id, turnId: "turn-lost", state: "awaiting-human-authorization" as const, requestId: "request-lost", episodeId: "episode-1", workflowRecordId: "images", canvasId: "main", nodeId: "image-node", plan: { kind: "image" as const, model: { kind: "image" as const, providerID: "images", modelID: "model" }, object: "frame", quantity: 1, prompt: "Draw", references: [], parameters: { mode: "text-to-image", size: "1024x1024" }, executionCount: 1, knownCost: null } };
    const interaction = { id: "compute-generation-lost", conversationId: conversation.id, turnId: "turn-lost", sessionId: "session-1", kind: "compute-authorization" as const, state: "pending" as const, payload: { proposal }, createdAt: "2026-01-01T00:00:00.000Z" };
    const generation = { ...proposal, source: "assistant" as const, requestHash: "a".repeat(64), revision: "b".repeat(64), status: "awaiting-human-authorization" as const, dependencyLinks: [], candidates: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const planSummary = { kind: "image" as const, model: proposal.plan.model, object: "frame", quantity: 1, prompt: "Draw", referencePaths: [], referenceScope: "project" as const, executionCount: 1, knownCost: null, mode: "text-to-image" as const, size: "1024x1024" };
    let authorized = false;
    const fake = client({
      getToonAssistantSnapshot: async () => ({ conversation, messages: [], interactions: [interaction], canvasProposals: [], subagents: [], activeTurnId: null, cursor: null }),
      authorizeToonWorkspaceGeneration: async () => { authorized = true; throw new Error("response lost"); },
      getToonWorkspaceGeneration: async () => ({ generation, job: null, authorization: authorized ? { authorizationId: "authorization-lost", requestId: proposal.requestId, planFingerprint: generation.requestHash, planSummary, expiresAt: "2026-01-01T00:05:00.000Z", consumedAt: null, state: "valid" as const } : null }),
      queryToonWorkspace: async () => { throw new Error("No references expected"); },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<ToonProjectAssistant client={fake.api as any} workspaceId="workspace-1" projectId="project-1" visible textModels={[model]} defaultModel={conversation.model} onClose={() => {}} />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const authorize = renderer.root.findAllByType("button").find((button) => button.children.includes("Authorize batch"))!;
    await act(async () => { await authorize.props.onClick(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_600)); });
    expect(renderer.root.findAllByType("button").some((button) => button.children.includes("Submit generation"))).toBe(true);
    await act(async () => { renderer.unmount(); });
  });

  test("offers re-authorization after expiry instead of leaving generation stuck", async () => {
    const proposal = { id: "generation-expired", conversationId: conversation.id, turnId: "turn-expired", state: "awaiting-human-authorization" as const, requestId: "request-expired", episodeId: "episode-1", workflowRecordId: "images", canvasId: "main", nodeId: "image-node", plan: { kind: "image" as const, model: { kind: "image" as const, providerID: "images", modelID: "model" }, object: "frame", quantity: 1, prompt: "Draw", references: [], parameters: { mode: "text-to-image", size: "1024x1024" }, executionCount: 1, knownCost: null } };
    const interaction = { id: "compute-generation-expired", conversationId: conversation.id, turnId: "turn-expired", sessionId: "session-1", kind: "compute-authorization" as const, state: "resolved" as const, payload: { proposal }, createdAt: "2026-01-01T00:00:00.000Z", resolvedAt: "2026-01-01T00:00:01.000Z" };
    const generation = { ...proposal, source: "assistant" as const, requestHash: "a".repeat(64), revision: "b".repeat(64), status: "awaiting-human-authorization" as const, dependencyLinks: [], candidates: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const planSummary = { kind: "image" as const, model: proposal.plan.model, object: "frame", quantity: 1, prompt: "Draw", referencePaths: [], referenceScope: "project" as const, executionCount: 1, knownCost: null, mode: "text-to-image" as const, size: "1024x1024" };
    const fake = client({
      getToonAssistantSnapshot: async () => ({ conversation, messages: [], interactions: [interaction], canvasProposals: [], subagents: [], activeTurnId: null, cursor: null }),
      getToonWorkspaceGeneration: async () => ({ generation, job: null, authorization: { authorizationId: "authorization-expired", requestId: proposal.requestId, planFingerprint: generation.requestHash, planSummary, expiresAt: "2026-01-01T00:00:00.000Z", consumedAt: null, state: "expired" as const } }),
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<ToonProjectAssistant client={fake.api as any} workspaceId="workspace-1" projectId="project-1" visible textModels={[model]} defaultModel={conversation.model} onClose={() => {}} />); });
    for (let attempt = 0; attempt < 20 && !renderer.root.findAllByProps({ "data-testid": "toon-generation-authorization-state" }).length; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    expect(renderer.root.findByProps({ "data-testid": "toon-generation-authorization-state" }).children).toContain("expired");
    expect(renderer.root.findByProps({ "data-testid": "toon-generation-reauthorize" })).toBeTruthy();
    expect(renderer.root.findAllByType("button").some((button) => button.children.includes("Submit generation"))).toBe(false);
    await act(async () => { renderer.unmount(); });
  });
});
