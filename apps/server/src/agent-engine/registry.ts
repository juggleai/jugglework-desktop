import type { AgentRuntimeDescriptor } from "@jugglework/types/agent-runtime";

import { AgentEngineError } from "./errors.js";
import type { AgentEnginePort } from "./port.js";

export const DEFAULT_AGENT_RUNTIME_ID = "jugglework";

export interface AgentRuntimeRegistryOptions {
  defaultRuntimeId?: string;
  engines?: Iterable<AgentEnginePort>;
}

export class AgentRuntimeRegistry {
  readonly defaultRuntimeId: string;
  readonly #engines = new Map<string, AgentEnginePort>();

  constructor(options: AgentRuntimeRegistryOptions = {}) {
    this.defaultRuntimeId = options.defaultRuntimeId?.trim() || DEFAULT_AGENT_RUNTIME_ID;
    for (const engine of options.engines ?? []) this.register(engine);
  }

  register(engine: AgentEnginePort): void {
    if (this.#engines.has(engine.runtimeId)) {
      throw new AgentEngineError("runtime_duplicate", `Agent runtime ${engine.runtimeId} is already registered`, {
        runtimeId: engine.runtimeId,
      });
    }
    this.#engines.set(engine.runtimeId, engine);
  }

  unregister(runtimeId: string): AgentEnginePort | null {
    const engine = this.#engines.get(runtimeId) ?? null;
    if (engine) this.#engines.delete(runtimeId);
    return engine;
  }

  resolve(runtimeId?: string | null): AgentEnginePort {
    const resolvedRuntimeId = runtimeId?.trim() || this.defaultRuntimeId;
    const engine = this.#engines.get(resolvedRuntimeId);
    if (!engine) {
      throw new AgentEngineError("runtime_not_found", `Agent runtime ${resolvedRuntimeId} is not registered`, {
        runtimeId: resolvedRuntimeId,
      });
    }
    return engine;
  }

  async requireAvailable(runtimeId?: string | null): Promise<AgentEnginePort> {
    const engine = this.resolve(runtimeId);
    const health = await engine.health();
    if (health.status !== "healthy" && health.status !== "degraded") {
      throw new AgentEngineError("runtime_unavailable", `Agent runtime ${engine.runtimeId} is ${health.status}`, {
        runtimeId: engine.runtimeId,
        status: health.status,
        reasonCode: health.reasonCode,
      });
    }
    return engine;
  }

  list(): AgentEnginePort[] {
    return [...this.#engines.values()];
  }

  async descriptors(): Promise<AgentRuntimeDescriptor[]> {
    const descriptors = await Promise.all(this.list().map((engine) => engine.descriptor()));
    return descriptors.map((descriptor) => ({
      ...descriptor,
      isDefault: descriptor.id === this.defaultRuntimeId,
    }));
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.list().map((engine) => engine.dispose()));
    this.#engines.clear();
  }
}
