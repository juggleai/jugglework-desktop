import { describe, expect, test } from "bun:test";
import type {
  AgentRuntimeCapabilities,
  AgentRuntimeDescriptor,
  AgentRuntimeHealth,
} from "@jugglework/types/agent-runtime";

import { AgentEngineError } from "./errors.js";
import type { AgentEnginePort } from "./port.js";
import { AgentRuntimeRegistry, DEFAULT_AGENT_RUNTIME_ID } from "./registry.js";

const noCapabilities: AgentRuntimeCapabilities = {
  models: false,
  variants: false,
  "reasoning-stream": false,
  commands: false,
  shell: false,
  compact: false,
  resume: false,
  fork: false,
  steer: false,
  enqueue: false,
  permissions: false,
  questions: false,
  todos: false,
  mcp: false,
  subagents: false,
  "file-checkpointing": false,
  "usage-and-cost": false,
  prewarm: false,
  "resident-session": false,
  "plan-mode": false,
  rewind: false,
  "dynamic-model": false,
  "dynamic-effort": false,
  "dynamic-permission-mode": false,
};

function fakeEngine(runtimeId: string, health: AgentRuntimeHealth = {
  status: "healthy",
  checkedAt: 1,
  reasonCode: null,
  message: null,
}): AgentEnginePort {
  const descriptor: AgentRuntimeDescriptor = {
    schemaVersion: 1,
    id: runtimeId,
    engine: "test",
    label: runtimeId,
    isDefault: false,
    capabilities: noCapabilities,
    health,
    models: [],
  };
  const unsupported = async () => { throw new Error("not used"); };
  return {
    runtimeId,
    descriptor: async () => descriptor,
    health: async () => health,
    listModels: async () => [],
    createSession: unsupported,
    listSessions: async () => [],
    readSession: unsupported,
    readMessages: async () => [],
    readSnapshot: unsupported,
    startRun: async () => undefined,
    abortRun: async () => undefined,
    subscribeEvents: async function* () {},
    resolveInteraction: async () => undefined,
    reloadConfiguration: async () => undefined,
    registerMcp: async () => undefined,
    disconnectMcp: async () => undefined,
    dispose: async () => undefined,
  };
}

describe("AgentRuntimeRegistry", () => {
  test("uses jugglework as the compatibility default", () => {
    const engine = fakeEngine(DEFAULT_AGENT_RUNTIME_ID);
    const registry = new AgentRuntimeRegistry({ engines: [engine] });
    expect(registry.resolve()).toBe(engine);
  });

  test("rejects duplicate registration with a stable error", () => {
    const engine = fakeEngine("jugglework");
    const registry = new AgentRuntimeRegistry({ engines: [engine] });
    expect(() => registry.register(engine)).toThrow(AgentEngineError);
    try {
      registry.register(engine);
    } catch (error) {
      expect(error).toMatchObject({ code: "runtime_duplicate" });
    }
  });

  test("returns stable errors for missing and unavailable runtimes", async () => {
    const registry = new AgentRuntimeRegistry({
      engines: [fakeEngine("claude-agent", {
        status: "unavailable",
        checkedAt: 1,
        reasonCode: "missing_credentials",
        message: "Configure credentials",
      })],
    });
    expect(() => registry.resolve("missing")).toThrow(AgentEngineError);
    await expect(registry.requireAvailable("claude-agent")).rejects.toMatchObject({
      code: "runtime_unavailable",
      details: { reasonCode: "missing_credentials" },
    });
  });

  test("normalizes advertised default without mutating adapter descriptors", async () => {
    const jugglework = fakeEngine("jugglework");
    const claude = fakeEngine("claude-agent");
    const registry = new AgentRuntimeRegistry({ defaultRuntimeId: "claude-agent", engines: [jugglework, claude] });
    const descriptors = await registry.descriptors();
    expect(descriptors.find(({ id }) => id === "claude-agent")?.isDefault).toBe(true);
    expect(descriptors.find(({ id }) => id === "jugglework")?.isDefault).toBe(false);
    expect((await jugglework.descriptor()).isDefault).toBe(false);
  });
});
