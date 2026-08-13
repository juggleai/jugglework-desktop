import { expect } from "bun:test";
import {
  agentRuntimeDescriptorSchema,
  canonicalAgentSessionSchema,
  canonicalSessionSnapshotSchema,
} from "@jugglework/types/agent-runtime";

import type { AgentEnginePort } from "./port.js";

export interface AgentEngineContractHarness {
  engine: AgentEnginePort;
  context: { workspaceId: string; directory: string };
  expectedRuntimeId: string;
  expectedBackendSessionId: string | null;
  afterStart?: () => Promise<void>;
}

export async function verifyCommonAgentEngineContract(harness: AgentEngineContractHarness): Promise<void> {
  const { engine, context } = harness;
  const descriptor = agentRuntimeDescriptorSchema.parse(await engine.descriptor());
  expect(descriptor.id).toBe(harness.expectedRuntimeId);
  expect(descriptor.health.status === "healthy" || descriptor.health.status === "degraded").toBe(true);

  const created = canonicalAgentSessionSchema.parse(await engine.createSession({
    ...context,
    sessionId: "public-session",
    title: "Contract session",
    configuration: { model: "contract-model" },
  }));
  expect(created).toMatchObject({
    id: "public-session",
    workspaceId: context.workspaceId,
    runtimeId: harness.expectedRuntimeId,
  });
  expect((await engine.listSessions(context)).some(({ id }) => id === created.id)).toBe(true);
  expect(await engine.readSession({ ...context, sessionId: created.id })).toMatchObject({ id: created.id });
  expect(canonicalSessionSnapshotSchema.parse(await engine.readSnapshot({
    ...context,
    sessionId: created.id,
  }))).toMatchObject({ session: { id: created.id } });

  await engine.startRun({
    ...context,
    sessionId: created.id,
    backendSessionId: created.backendSessionId,
    runId: "run-one",
    prompt: { parts: [{ type: "text", text: "hello" }] },
    delivery: "start",
  });
  await harness.afterStart?.();
  expect(await engine.readSession({ ...context, sessionId: created.id })).toMatchObject({
    backendSessionId: harness.expectedBackendSessionId,
  });
  await engine.abortRun({
    ...context,
    sessionId: created.id,
    backendSessionId: harness.expectedBackendSessionId,
    runId: "run-one",
  });
}
