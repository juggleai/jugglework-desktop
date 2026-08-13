import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentRuntimeCapabilities,
  AgentRuntimeDescriptor,
  CanonicalAgentEvent,
  CanonicalAgentSession,
  CanonicalSessionSnapshot,
} from "@jugglework/types/agent-runtime";
import {
  agentRuntimeAdapterConfiguration,
  CLAUDE_ADVANCED_FEATURES,
  classifyAgentRuntimeDiagnostic,
  validateAgentRuntimeSessionConfiguration,
} from "@jugglework/types/agent-runtime";

import { createCanonicalAgentClient } from "../src/app/lib/agent-client";
import {
  canUseAgentRuntimeControl,
  getAgentRuntimeControlState,
  getAgentRuntimeControlStates,
} from "../src/react-app/domains/session/agent-capabilities";
import {
  canonicalAgentCacheKeys,
  reconcileCanonicalEvents,
} from "../src/react-app/domains/session/canonical-agent-cache";
import { createCanonicalAgentSync } from "../src/react-app/domains/session/canonical-agent-sync";
import {
  canonicalSnapshotToUIMessages,
  confirmAmbiguousRetry,
  latestCanonicalRunError,
  requiresAmbiguousRetryConfirmation,
} from "../src/react-app/domains/session/canonical-agent-ui";
import {
  describeAgentRuntimeUnavailable,
  readPermittedAgentRuntimeDefault,
  recordAgentRuntimeDiagnostic,
  sessionRuntimeIdentity,
  writePermittedAgentRuntimeDefault,
} from "../src/react-app/domains/session/agent-runtime-experience";
import {
  readSessionChoices,
  setSessionAgentProfileChoice,
  setSessionModelChoice,
  setSessionVariantChoice,
} from "../src/react-app/kernel/session-model-store";

const capabilities = Object.fromEntries([
  "models", "variants", "reasoning-stream", "commands", "shell", "compact", "resume", "fork",
  "steer", "enqueue", "permissions", "questions", "todos", "mcp", "subagents", "file-checkpointing",
  "usage-and-cost", "prewarm", "resident-session", "plan-mode", "rewind",
].map((name) => [name, false])) as AgentRuntimeCapabilities;

const APP_SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");
const OPENCODE_CANONICAL_DOMAIN_TYPES = new Set([
  "Session",
  "SessionStatus",
  "Message",
  "Part",
  "FilePart",
  "ToolPart",
  "PermissionRequest",
  "PermissionV2Request",
  "QuestionRequest",
  "QuestionInfo",
]);

function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const item = join(path, entry.name);
    if (entry.isDirectory()) return entry.name === "sync" ? [] : sourceFiles(item);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [item] : [];
  });
}

function session(status: CanonicalAgentSession["status"] = { type: "idle" }): CanonicalAgentSession {
  return {
    id: "session-1",
    workspaceId: "workspace one",
    runtimeId: "jugglework",
    backendSessionId: "backend-1",
    title: "Canonical session",
    canonicalCwd: "/workspace",
    status,
    configuration: {},
    createdAt: 10,
    updatedAt: 10,
    lastError: null,
  };
}

function snapshot(): CanonicalSessionSnapshot {
  return {
    schemaVersion: 1,
    session: session(),
    messages: [],
    todos: [],
    interactions: [],
    latestSequence: 0,
  };
}

function event(sequence: number, data: CanonicalAgentEvent["data"]): CanonicalAgentEvent {
  return {
    schemaVersion: 1,
    id: `event-${sequence}`,
    workspaceId: "workspace one",
    sessionId: "session-1",
    runtimeId: "jugglework",
    sequence,
    occurredAt: 10 + sequence,
    data,
  };
}

describe("canonical agent client", () => {
  test("keeps OpenCode session domain types inside legacy adapter boundaries", () => {
    const productFiles = [
      join(APP_SRC, "app/types.ts"),
      ...sourceFiles(join(APP_SRC, "components/chat")),
      ...sourceFiles(join(APP_SRC, "react-app/domains/session")),
      ...sourceFiles(join(APP_SRC, "react-app/shell")),
    ];
    const violations = productFiles.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const imports = source.matchAll(/import(?:\s+type)?\s*\{([^}]*)\}\s*from\s*["']@opencode-ai\/sdk[^"']*["']/g);
      return [...imports].flatMap((match) => {
        const names = (match[1] ?? "").split(",").map((name) => name.trim().split(/\s+as\s+/)[0]);
        const forbidden = names.filter((name) => OPENCODE_CANONICAL_DOMAIN_TYPES.has(name));
        return forbidden.length ? [`${file.replace(`${APP_SRC}/`, "")}: ${forbidden.join(", ")}`] : [];
      });
    });

    expect(violations).toEqual([]);
  });

  test("validates the redacted support diagnostics envelope", async () => {
    const distribution = { count: 0, total: 0, max: 0 };
    const diagnostics = {
      schemaVersion: 1 as const,
      capturedAt: 1,
      windowStartedAt: 1,
      worker: { status: "healthy" as const, statusChanges: 1, starts: 1, restarts: 0, crashes: 0, circuitOpens: 0 },
      query: { active: 0, started: 0, completed: 0, failed: 0, aborted: 0, durationMs: distribution },
      mcp: { events: 0, initializing: 0, pending: 0, connected: 0, failed: 0, needsAuth: 0, expired: 0, removed: 0, outputTruncated: 0 },
      interaction: { requested: 0, resolved: 0, allowed: 0, denied: 0, answered: 0, rejected: 0, timedOut: 0, cancelled: 0, failed: 0, durationMs: distribution },
      event: { observed: 0, persisted: 0, duplicates: 0, streamErrors: 0, lagMs: distribution },
      queue: { created: 0, pending: 0, dispatching: 0, admitted: 0, completed: 0, failed: 0, cancelled: 0, waitMs: distribution },
      advancedRollout: { features: CLAUDE_ADVANCED_FEATURES.map((feature) => ({
        feature,
        enabled: false,
        attempts: 0,
        used: 0,
        fallbacks: 0,
        flagDisabled: 0,
        policyDenied: 0,
        killed: 0,
        capabilityMissing: 0,
      })) },
      usage: { samples: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, durationMs: 0, estimatedCostUsd: 0 },
      crash: { total: 0, worker: 0, query: 0, eventStream: 0, lastAt: null, lastReason: null },
    };
    const client = createCanonicalAgentClient({
      baseUrl: "http://localhost:8787",
      workspaceId: "workspace one",
      fetch: async () => Response.json({ diagnostics }),
    });
    await expect(client.getSupportDiagnostics()).resolves.toEqual(diagnostics);
  });

  test("uses the versioned workspace URL and validates canonical sessions", async () => {
    let request: Request | null = null;
    const client = createCanonicalAgentClient({
      baseUrl: "http://localhost:8787/",
      workspaceId: "workspace one",
      token: "secret",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ items: [session({ type: "running" })] });
      },
    });

    const sessions = await client.listSessions({ limit: 25, search: "active" });

    expect(sessions[0]?.status.type).toBe("running");
    expect(request?.url).toBe("http://localhost:8787/workspace/workspace%20one/agent/v1/sessions?search=active&limit=25");
    expect(request?.headers.get("Authorization")).toBe("Bearer secret");
  });

  test("previews continuation without creating history when review is cancelled", async () => {
    const requests: Request[] = [];
    const preview = {
      sourceSessionId: "session-1",
      sourceTitle: "Canonical session",
      sourceRuntimeId: "jugglework",
      targetRuntimeId: "claude-agent",
      context: { summary: "Review this", transcript: [{ sourceMessageId: "message-1", role: "user", text: "Work" }] },
      omissions: { secretBearingText: 0, oversizedText: 0, attachments: 0, tools: 0, hiddenOrReasoning: 0, pendingInteractions: 0 },
      selectedCharacters: 4,
      maxCharacters: 120_000,
    } as const;
    const client = createCanonicalAgentClient({
      baseUrl: "http://localhost:8787",
      workspaceId: "workspace one",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ preview });
      },
    });

    expect(await client.previewContinuation("session-1", "claude-agent")).toEqual(preview);
    // Cancelling the review dialog intentionally performs no confirm request.
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/workspace/workspace%20one/agent/v1/sessions/session-1/continuations/preview",
    ]);
  });

  test("confirms edited continuation context through the linked-session endpoint", async () => {
    const requests: Request[] = [];
    const target = { ...session(), id: "session-claude", runtimeId: "claude-agent", backendSessionId: null, title: "Continue with Claude Agent" };
    const context = { summary: "Edited summary", transcript: [{ sourceMessageId: "message-1", role: "user" as const, text: "Reviewed text" }] };
    const link = { sourceSessionId: "session-1", targetSessionId: "session-claude", type: "migration" as const, contextDigest: "c".repeat(64), createdAt: 20 };
    const client = createCanonicalAgentClient({
      baseUrl: "http://localhost:8787",
      workspaceId: "workspace one",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ continuation: { session: target, link, context } });
      },
    });

    expect(await client.continueSession("session-1", "claude-agent", context)).toEqual({ session: target, link, context });
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toContain("/sessions/session-1/continuations");
    expect(await requests[0]?.json()).toEqual({ targetRuntimeId: "claude-agent", context });
  });

  test("sends the canonical run, abort and interaction envelopes required by Server", async () => {
    const requests: Request[] = [];
    const client = createCanonicalAgentClient({
      baseUrl: "http://localhost:8787",
      workspaceId: "workspace one",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.endsWith("/runs")) return Response.json({ disposition: "started", run: { runId: "run-1", status: "running" } });
        return Response.json({ ok: true });
      },
    });

    await client.startRun("session-1", { prompt: { parts: [{ type: "text", text: "hello" }] } });
    await client.abortRun("session-1", "run-1");
    await client.resolveInteraction("session-1", "interaction-1", { outcome: "allow" });

    expect(await requests[0]!.json()).toEqual({
      origin: "local-renderer",
      startCommandCorrelationId: null,
      prompt: { parts: [{ type: "text", text: "hello" }] },
      whenBusy: "reject",
    });
    expect(await requests[1]!.json()).toEqual({ abortCommandCorrelationId: null });
    expect(await requests[2]!.json()).toEqual({
      origin: "local-renderer",
      commandCorrelationId: null,
      resolution: { outcome: "allow" },
    });
  });

  test("updates session titles through the canonical route", async () => {
    let request: Request | null = null;
    const renamed = { ...session(), title: "Renamed" };
    const client = createCanonicalAgentClient({
      baseUrl: "http://localhost:8787",
      workspaceId: "workspace one",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ session: renamed });
      },
    });

    await expect(client.updateSession("session-1", { title: "Renamed" })).resolves.toEqual(renamed);
    expect(request?.method).toBe("PATCH");
    expect(await request?.json()).toEqual({ title: "Renamed" });
  });

  test("unwraps Server detail and snapshot response envelopes", async () => {
    const client = createCanonicalAgentClient({
      baseUrl: "http://localhost:8787",
      workspaceId: "workspace one",
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/snapshot")) return Response.json({ snapshot: snapshot() });
        return Response.json({ session: session() });
      },
    });
    await expect(client.getSession("session-1")).resolves.toMatchObject({ id: "session-1" });
    await expect(client.getSessionSnapshot("session-1")).resolves.toMatchObject({
      session: { id: "session-1" },
      latestSequence: 0,
    });
  });

  test("requires explicit UI confirmation and sends the durable retry proof", async () => {
    const interrupted = {
      ...snapshot(),
      session: session({
        type: "interrupted",
        ambiguous: true,
        message: "A tool may have changed external state.",
      }),
    };
    expect(requiresAmbiguousRetryConfirmation(interrupted)).toBe(true);
    expect(confirmAmbiguousRetry(interrupted, () => false)).toBe(false);
    expect(confirmAmbiguousRetry(interrupted, () => true)).toBe(true);

    let request: Request | null = null;
    const client = createCanonicalAgentClient({
      baseUrl: "http://localhost:8787",
      workspaceId: "workspace one",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ disposition: "started", run: { runId: "retry-run", status: "running" } });
      },
    });
    await client.startRun("session-1", {
      prompt: { parts: [{ type: "text", text: "retry" }] },
      confirmAmbiguousRetry: true,
    });
    expect(await request!.json()).toMatchObject({ confirmAmbiguousRetry: true });
  });
});

describe("canonical agent cache reconciliation", () => {
  test("uses stable domain-specific keys", () => {
    expect(canonicalAgentCacheKeys.snapshot("workspace", "session")).toEqual([
      "canonical-agent", "snapshot", "workspace", "session",
    ]);
    expect(canonicalAgentCacheKeys.interactions("workspace", "session")[1]).toBe("interactions");
  });

  test("applies a contiguous range, suppresses duplicates, and detects gaps", () => {
    const running = event(1, { type: "session.status", status: { type: "running" } });
    const todo = event(2, {
      type: "todo.updated",
      todos: [{ id: "todo-1", content: "Verify", status: "in_progress", priority: "high" }],
    });
    const gap = event(4, { type: "session.status", status: { type: "idle" } });

    const result = reconcileCanonicalEvents(snapshot(), [todo, running, running, gap]);

    expect(result.applied).toBe(2);
    expect(result.ignored).toBe(1);
    expect(result.needsSnapshot).toBe(true);
    expect(result.nextSequence).toBe(3);
    expect(result.snapshot.session.status.type).toBe("running");
    expect(result.snapshot.todos[0]?.id).toBe("todo-1");
  });
});

describe("canonical agent stream sync", () => {
  test("resumes with the latest cursor and suppresses duplicate event frames", async () => {
    const snapshots: CanonicalSessionSnapshot[] = [];
    const cursors: Array<string | null> = [];
    let calls = 0;
    const sync = createCanonicalAgentSync({
      initialSnapshots: [snapshot()],
      reconnectDelayMs: 1,
      staleAfterMs: 1_000,
      client: {
        openWorkspaceEventStream: async (cursor, signal) => {
          cursors.push(cursor);
          calls += 1;
          if (calls > 1) return abortablePendingStream(signal);
          const running = event(1, { type: "session.status", status: { type: "running" } });
          return sseResponse([
            frame("event", running, "cursor-one"),
            frame("event", running, "cursor-one"),
          ]);
        },
      },
      onSnapshot: (value) => snapshots.push(value),
    });
    sync.start();
    await waitUntil(() => cursors.length === 2);
    expect(cursors).toEqual([null, "cursor-one"]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.session.status.type).toBe("running");
    sync.stop();
    await sync.completed();
  });

  test("recovers from a sequence gap with a fresh snapshot", async () => {
    const recovered = { ...snapshot(), session: session({ type: "running" }), latestSequence: 4 };
    const cursors: Array<string | null> = [];
    const sync = createCanonicalAgentSync({
      initialSnapshots: [snapshot()],
      reconnectDelayMs: 1,
      staleAfterMs: 1_000,
      client: {
        openWorkspaceEventStream: async (cursor, signal) => {
          cursors.push(cursor);
          if (cursors.length === 1) return sseResponse([frame("event", event(4, { type: "session.status", status: { type: "idle" } }), "gap")]);
          if (cursors.length === 2) return sseResponse([frame("snapshot", {
            schemaVersion: 1,
            workspaceId: "workspace one",
            events: [],
            cursor: { "session-1": 4 },
            cursorToken: "recovered",
            requiresSnapshot: true,
            snapshots: [recovered],
          })]);
          return abortablePendingStream(signal);
        },
      },
    });
    sync.start();
    await waitUntil(() => sync.cursor() === "recovered");
    expect(cursors.slice(0, 2)).toEqual([null, null]);
    expect(sync.snapshot("session-1")?.latestSequence).toBe(4);
    sync.stop();
    await sync.completed();
  });

  test("watchdog reconnects a stream that produces no heartbeat or event", async () => {
    const cursors: Array<string | null> = [];
    const sync = createCanonicalAgentSync({
      initialSnapshots: [snapshot()],
      reconnectDelayMs: 1,
      staleAfterMs: 10,
      client: {
        openWorkspaceEventStream: async (cursor, signal) => {
          cursors.push(cursor);
          return abortablePendingStream(signal);
        },
      },
    });
    sync.start();
    await waitUntil(() => cursors.length >= 2);
    expect(cursors[0]).toBeNull();
    sync.stop();
    await sync.completed();
  });
});

describe("runtime capability helpers", () => {
  const descriptor: AgentRuntimeDescriptor = {
    schemaVersion: 1,
    id: "jugglework",
    engine: "opencode",
    label: "JuggleWork",
    isDefault: true,
    capabilities: { ...capabilities, compact: true, models: true },
    health: { status: "healthy", checkedAt: 1, reasonCode: null, message: null },
    models: [],
  };

  test("derives controls from descriptors and policy without runtime-name checks", () => {
    expect(canUseAgentRuntimeControl(descriptor, "compact")).toBe(true);
    expect(getAgentRuntimeControlState(descriptor, "steer").reason).toBe("unsupported");
    expect(getAgentRuntimeControlState(descriptor, "model", { allowed: false }).reason).toBe("policy-disabled");
    expect(getAgentRuntimeControlState({
      ...descriptor,
      health: { status: "failed", checkedAt: 2, reasonCode: "worker_crash", message: "Unavailable" },
    }, "compact").reason).toBe("runtime-unavailable");
  });

  test("derives the full control matrix from descriptor and policy", () => {
    const states = getAgentRuntimeControlStates(descriptor, { model: false, compact: false });
    expect(states.model.reason).toBe("policy-disabled");
    expect(states.compact.reason).toBe("policy-disabled");
    expect(states.command.reason).toBe("unsupported");
    expect(states.plan.reason).toBe("unsupported");
    expect(states.checkpoint.reason).toBe("unsupported");
    expect(states.rewind.reason).toBe("unsupported");
    expect(states.subagent.reason).toBe("unsupported");
  });
});

describe("canonical session UI projection", () => {
  test.each([
    ["default OpenCode", "jugglework"],
    ["Claude Agent", "claude-agent"],
  ] as const)("renders %s sessions from the same canonical product types", (_label, runtimeId) => {
    const value: CanonicalSessionSnapshot = {
      ...snapshot(),
      session: { ...session(), runtimeId },
      messages: [{
        id: `${runtimeId}-message`,
        sessionId: "session-1",
        role: "assistant",
        parentId: null,
        createdAt: 10,
        completedAt: 11,
        parts: [{
          id: `${runtimeId}-text`,
          messageId: `${runtimeId}-message`,
          sessionId: "session-1",
          ordinal: 0,
          createdAt: 10,
          updatedAt: 11,
          type: "text",
          text: `Rendered by ${runtimeId}`,
          state: "complete",
        }],
      }],
    };

    expect(canonicalSnapshotToUIMessages(value)).toMatchObject([{
      role: "assistant",
      parts: [{ type: "text", text: `Rendered by ${runtimeId}`, state: "done" }],
    }]);
  });

  test("projects Claude subagents with parent attribution, progress usage, and stop metadata", () => {
    const messages = canonicalSnapshotToUIMessages({
      ...snapshot(),
      messages: [{
        id: "subagent-message",
        sessionId: "session-1",
        role: "assistant",
        parentId: null,
        createdAt: 10,
        completedAt: null,
        parts: [{
          id: "subagent-part",
          messageId: "subagent-message",
          sessionId: "session-1",
          ordinal: 0,
          createdAt: 10,
          updatedAt: 11,
          type: "agent",
          agentId: "agent-1",
          parentToolCallId: "tool-parent",
          label: "Explore",
          state: "running",
          metadata: {
            backendTaskId: "task-1",
            description: "Inspect auth",
            summary: "Tracing login",
            usage: { totalTokens: 120, toolUses: 3, durationMs: 1500 },
            runId: "run-1",
            stoppable: true,
          },
        }],
      }],
    });
    expect(messages[0]?.parts[0]).toMatchObject({
      type: "dynamic-tool",
      toolName: "claude_subagent",
      state: "input-streaming",
      input: { label: "Explore", description: "Inspect auth", parentToolCallId: "tool-parent" },
      callProviderMetadata: { canonical: {
        backendTaskId: "task-1",
        parentToolCallId: "tool-parent",
        usage: { totalTokens: 120, toolUses: 3, durationMs: 1500 },
        stoppable: true,
      } },
    });
  });

  test("projects streaming text, tools, status and recoverable errors into shared UI shapes", () => {
    const value: CanonicalSessionSnapshot = {
      ...snapshot(),
      session: {
        ...session({ type: "retrying", attempt: 2, message: "Retrying provider", nextAt: 50 }),
        lastError: { code: "provider_failed", message: "Reconnect the provider" },
      },
      messages: [{
        id: "message-1",
        sessionId: "session-1",
        role: "assistant",
        parentId: null,
        createdAt: 10,
        completedAt: null,
        parts: [{
          id: "text-1",
          messageId: "message-1",
          sessionId: "session-1",
          ordinal: 0,
          createdAt: 10,
          updatedAt: 11,
          type: "text",
          text: "Working",
          state: "streaming",
        }, {
          id: "tool-1",
          messageId: "message-1",
          sessionId: "session-1",
          ordinal: 1,
          createdAt: 10,
          updatedAt: 11,
          type: "tool",
          toolCallId: "call-1",
          toolName: "read",
          state: "completed",
          input: { path: "README.md" },
          output: "ok",
        }],
      }],
    };

    const messages = canonicalSnapshotToUIMessages(value);
    expect(messages[0]?.parts).toMatchObject([
      { type: "text", text: "Working", state: "streaming" },
      { type: "dynamic-tool", toolName: "read", state: "output-available", output: "ok" },
    ]);
    expect(messages.at(-1)?.id).toStartWith("canonical-error:");
    expect(value.session.status).toMatchObject({ type: "retrying", attempt: 2, nextAt: 50 });
    expect(latestCanonicalRunError(value)).toBe("Reconnect the provider");
  });

  test("links one pending interaction to one tool item and updates that item in place", () => {
    const base = snapshot();
    const tool = {
      id: "tool-part-1",
      messageId: "message-1",
      sessionId: "session-1",
      ordinal: 0,
      createdAt: 10,
      updatedAt: 11,
      type: "tool" as const,
      toolCallId: "tool-call-1",
      toolName: "Read",
      state: "waiting" as const,
      input: { path: "README.md" },
    };
    const interaction = {
      id: "interaction-1",
      sessionId: "session-1",
      runId: "run-1",
      kind: "permission" as const,
      state: "pending" as const,
      title: "Allow Read?",
      toolName: "Read",
      input: { path: "README.md" },
      requestedAt: 11,
      deadlineAt: 100,
      resolvedAt: null,
      resolution: null,
      metadata: { toolCallId: "tool-call-1", toolPartId: "tool-part-1" },
    };
    const pending = canonicalSnapshotToUIMessages({
      ...base,
      messages: [{
        id: "message-1",
        sessionId: "session-1",
        role: "assistant",
        parentId: null,
        createdAt: 10,
        completedAt: null,
        parts: [tool],
      }],
      interactions: [interaction],
    });
    expect(pending[0]?.parts).toHaveLength(1);
    expect(pending[0]?.parts[0]).toMatchObject({
      type: "dynamic-tool",
      toolCallId: "tool-call-1",
      state: "input-available",
      callProviderMetadata: { canonical: { interactionId: "interaction-1", interactionState: "pending" } },
    });

    const resolved = canonicalSnapshotToUIMessages({
      ...base,
      messages: [{
        id: "message-1",
        sessionId: "session-1",
        role: "assistant",
        parentId: null,
        createdAt: 10,
        completedAt: null,
        parts: [{ ...tool, state: "running", updatedAt: 12 }],
      }],
      interactions: [{
        ...interaction,
        state: "resolved",
        resolvedAt: 12,
        resolution: { outcome: "allow" },
      }],
    });
    expect(resolved[0]?.parts).toHaveLength(1);
    expect(resolved[0]?.parts[0]).toMatchObject({
      toolCallId: "tool-call-1",
      state: "input-streaming",
      callProviderMetadata: { canonical: { interactionId: "interaction-1", interactionState: "resolved", outcome: "allow" } },
    });
  });
});

describe("runtime-aware session experience", () => {
  const descriptor: AgentRuntimeDescriptor = {
    schemaVersion: 1,
    id: "claude-agent",
    engine: "claude-agent-sdk",
    label: "Claude Agent",
    isDefault: false,
    capabilities: { ...capabilities, models: true, variants: true, "usage-and-cost": true },
    health: { status: "healthy", checkedAt: 1, reasonCode: null, message: null },
    models: [{
      id: "sonnet",
      providerId: "anthropic",
      label: "Sonnet",
      isDefault: true,
      capabilities: ["effort:low", "effort:high"],
    }],
  };

  test("persists only defaults permitted by the current catalog", () => {
    const values = new Map<string, string>();
    const previousWindow = globalThis.window;
    Object.assign(globalThis, {
      window: {
        ...previousWindow,
        localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
      },
    });
    try {
      const catalog = { schemaVersion: 1 as const, runtimes: [
        { ...descriptor, id: "jugglework", engine: "opencode", label: "JuggleWork", isDefault: true },
        descriptor,
      ] };
      expect(writePermittedAgentRuntimeDefault("workspace", "claude-agent", catalog)).toBe(true);
      expect(readPermittedAgentRuntimeDefault("workspace", catalog)).toBe("claude-agent");
      expect(writePermittedAgentRuntimeDefault("workspace", "unknown", catalog)).toBe(false);
    } finally {
      Object.assign(globalThis, { window: previousWindow });
    }
  });

  test("persists profile, model and effort independently for a legacy session", () => {
    const values = new Map<string, string>();
    const previousWindow = globalThis.window;
    Object.assign(globalThis, {
      window: {
        ...previousWindow,
        localStorage: {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => values.set(key, value),
        },
      },
    });
    try {
      setSessionAgentProfileChoice("workspace", "legacy-session", "reviewer");
      setSessionModelChoice("workspace", "legacy-session", { providerID: "anthropic", modelID: "sonnet" });
      setSessionVariantChoice("workspace", "legacy-session", "high");
      expect(readSessionChoices("workspace")["legacy-session"]).toEqual({
        agentProfile: "reviewer",
        model: { providerID: "anthropic", modelID: "sonnet" },
        variant: "high",
      });
    } finally {
      Object.assign(globalThis, { window: previousWindow });
    }
  });

  test("validates model, effort and budget before adapting configuration", () => {
    const valid = validateAgentRuntimeSessionConfiguration(descriptor, {
      agentProfile: "reviewer",
      model: { providerId: "anthropic", modelId: "sonnet" },
      execution: { effort: "high", budget: { maxTurns: 12, maxCostUsd: 5 } },
    });
    expect(valid.success).toBe(true);
    expect(validateAgentRuntimeSessionConfiguration(descriptor, {
      model: { providerId: "other", modelId: "sonnet" },
    })).toMatchObject({ success: false, code: "model_unavailable" });
    expect(validateAgentRuntimeSessionConfiguration(descriptor, {
      model: { providerId: "anthropic", modelId: "sonnet" }, execution: { effort: "extreme" },
    })).toMatchObject({ success: false, code: "effort_unavailable" });
    expect(agentRuntimeAdapterConfiguration({ ...descriptor, engine: "opencode" }, {
      agentProfile: "reviewer",
      model: { providerId: "anthropic", modelId: "sonnet" },
    })).toEqual({
      agentProfile: "reviewer",
      model: { providerId: "anthropic", modelId: "sonnet" },
    });
  });

  test("shows independent identity fields and actionable unavailable reasons", () => {
    expect(sessionRuntimeIdentity({
      id: "one",
      title: "One",
      runtimeId: "claude-agent",
      agentProfile: "reviewer",
      runtimeModel: { providerId: "anthropic", modelId: "sonnet" },
      runtimeExecution: { effort: "high", budget: { maxTurns: 12 } },
    })).toEqual({
      runtime: "Claude Agent",
      profile: "reviewer",
      model: "anthropic/sonnet",
      execution: "high · 12 turns",
    });
    expect(describeAgentRuntimeUnavailable({
      ...descriptor,
      health: { status: "unavailable", checkedAt: 1, reasonCode: "worker_not_provisioned", message: null },
    })).toContain("worker not provisioned");
  });

  test("diagnostics use stable categories and omit private messages", () => {
    expect([
      classifyAgentRuntimeDiagnostic(null),
      classifyAgentRuntimeDiagnostic("runtime_disabled"),
      classifyAgentRuntimeDiagnostic("worker_startup_failed"),
      classifyAgentRuntimeDiagnostic("provider_auth_failed"),
      classifyAgentRuntimeDiagnostic("policy_denied"),
      classifyAgentRuntimeDiagnostic("mcp_initialization_failed"),
      classifyAgentRuntimeDiagnostic("worker_startup_timeout"),
      classifyAgentRuntimeDiagnostic("worker_crash"),
    ]).toEqual([
      "runtime_selection",
      "availability",
      "startup",
      "provider",
      "policy",
      "mcp",
      "timeout",
      "crash",
    ]);
    const category = recordAgentRuntimeDiagnostic({
      event: "creation_failed",
      runtimeId: "claude-agent",
      reasonCode: "mcp_initialization_failed",
      workspaceRemote: true,
    });
    expect(category).toBe("mcp");
    const privateCategory = recordAgentRuntimeDiagnostic({
      event: "creation_failed",
      runtimeId: "claude-agent",
      reasonCode: "failed reading /private/path with user prompt",
      workspaceRemote: false,
    });
    expect(privateCategory).toBe("runtime_selection");
  });
});

function frame(name: string, data: unknown, id?: string): string {
  return `${id ? `id: ${id}\n` : ""}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseResponse(frames: string[]): Response {
  return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
}

function abortablePendingStream(signal: AbortSignal): Response {
  return new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for condition");
}
