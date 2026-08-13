import type {
  AgentRuntimeCapabilities,
  AgentRuntimeDescriptor,
  AgentRuntimeHealth,
  AgentRuntimeModel,
  CanonicalAgentEvent,
  CanonicalAgentEventData,
  CanonicalAgentMessage,
  CanonicalAgentPart,
  CanonicalAgentSession,
  CanonicalAgentTodo,
  CanonicalInteraction,
  CanonicalInteractionResolution,
  CanonicalSessionSnapshot,
  CanonicalSessionStatus,
} from "@jugglework/types/agent-runtime";

import { AgentEngineError } from "./errors.js";
import type {
  AbortAgentRunInput,
  DeleteAgentSessionInput,
  ForkAgentSessionInput,
  ForkAgentSessionResult,
  AgentEngineContext,
  AgentEnginePort,
  CreateAgentSessionInput,
  ListAgentSessionsInput,
  ResolveAgentInteractionInput,
  StartAgentRunInput,
  UpdateAgentSessionInput,
} from "./port.js";

const RUNTIME_ID = "jugglework";

const capabilities: AgentRuntimeCapabilities = {
  models: true,
  variants: true,
  "reasoning-stream": true,
  commands: true,
  shell: true,
  compact: true,
  resume: true,
  fork: true,
  steer: true,
  enqueue: true,
  permissions: true,
  questions: true,
  todos: true,
  mcp: true,
  subagents: true,
  "file-checkpointing": false,
  "usage-and-cost": true,
  prewarm: false,
  "resident-session": true,
  "plan-mode": true,
  rewind: false,
  "dynamic-model": false,
  "dynamic-effort": false,
  "dynamic-permission-mode": false,
};

type JsonObject = CanonicalAgentSession["configuration"];
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type OpenCodeMethod = (...args: unknown[]) => Promise<unknown>;

interface OpenCodeClientShape {
  global?: { health?: OpenCodeMethod; dispose?: OpenCodeMethod };
  instance?: { dispose?: OpenCodeMethod };
  event?: { subscribe?: OpenCodeMethod };
  app?: { agents?: OpenCodeMethod; skills?: OpenCodeMethod };
  tool?: { ids?: OpenCodeMethod };
  provider?: { list?: OpenCodeMethod };
  session?: {
    create?: OpenCodeMethod;
    list?: OpenCodeMethod;
    get?: OpenCodeMethod;
    messages?: OpenCodeMethod;
    todo?: OpenCodeMethod;
    status?: OpenCodeMethod;
    promptAsync?: OpenCodeMethod;
    abort?: OpenCodeMethod;
    delete?: OpenCodeMethod;
    update?: OpenCodeMethod;
    fork?: OpenCodeMethod;
  };
  permission?: { list?: OpenCodeMethod; reply?: OpenCodeMethod };
  question?: { list?: OpenCodeMethod; reply?: OpenCodeMethod; reject?: OpenCodeMethod };
  mcp?: { add?: OpenCodeMethod; disconnect?: OpenCodeMethod; status?: OpenCodeMethod };
  v2?: {
    session?: {
      permission?: { list?: OpenCodeMethod; reply?: OpenCodeMethod };
      question?: { list?: OpenCodeMethod; reply?: OpenCodeMethod; reject?: OpenCodeMethod };
      prompt?: OpenCodeMethod;
    };
  };
}

export interface OpenCodeAgentEngineAdapterOptions {
  createClient: (context: AgentEngineContext) => unknown;
  now?: () => number;
  health?: () => Promise<AgentRuntimeHealth>;
  startRun?: (client: unknown, input: StartAgentRunInput, backendSessionId: string) => Promise<void>;
  abortRun?: (client: unknown, input: AbortAgentRunInput, backendSessionId: string) => Promise<void>;
  reloadConfiguration?: (client: unknown, context: AgentEngineContext) => Promise<void>;
  registerMcp?: (
    client: unknown,
    context: AgentEngineContext,
    name: string,
    configuration: Record<string, unknown>,
  ) => Promise<void>;
  disconnectMcp?: (client: unknown, context: AgentEngineContext, name: string) => Promise<void>;
  dispose?: () => Promise<void>;
}

interface OpenCodeEvent {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function decimalValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function jsonValue(value: unknown, fallback: JsonObject = {}): JsonValue {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? fallback : JSON.parse(serialized);
  } catch {
    return fallback;
  }
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    const direct = stringValue(value.message);
    if (direct) return direct;
    if (isRecord(value.data) && stringValue(value.data.message)) return value.data.message as string;
    if (stringValue(value.name)) return value.name as string;
  }
  return "OpenCode request failed";
}

function questionAnswers(interaction: CanonicalInteraction | undefined, values: string[]): string[][] {
  if (!interaction?.questions?.length) return values.map((value) => [value]);
  const answers: string[][] = [];
  let offset = 0;
  interaction.questions.forEach((question, index) => {
    const remainingQuestions = interaction.questions!.length - index - 1;
    const take = question.multiple ? Math.max(1, values.length - offset - remainingQuestions) : 1;
    answers.push(values.slice(offset, offset + take));
    offset += take;
  });
  return answers;
}

function requestError(path: string, result: unknown): AgentEngineError {
  const response = isRecord(result) && result.response instanceof Response ? result.response : null;
  const upstream = isRecord(result) ? result.error : result;
  return new AgentEngineError(
    "runtime_request_failed",
    `OpenCode request failed for ${path}`,
    { runtimeId: RUNTIME_ID, path, status: response?.status ?? null, message: errorMessage(upstream) },
  );
}

function unwrapData(result: unknown, path: string): unknown {
  if (!isRecord(result)) throw requestError(path, result);
  if (result.error !== undefined) throw requestError(path, result);
  if (result.data === undefined || result.data === null) throw requestError(path, result);
  return result.data;
}

function assertAccepted(result: unknown, path: string): void {
  if (isRecord(result) && result.error === undefined) return;
  throw requestError(path, result);
}

function requireMethod(owner: object | undefined, value: OpenCodeMethod | undefined, path: string): OpenCodeMethod {
  if (owner && value) return value.bind(owner);
  throw new AgentEngineError("runtime_request_failed", `OpenCode client does not implement ${path}`, {
    runtimeId: RUNTIME_ID,
    path,
  });
}

function openCodeEvent(value: unknown): OpenCodeEvent | null {
  const candidate = isRecord(value) && isRecord(value.payload) ? value.payload : value;
  if (!isRecord(candidate) || typeof candidate.type !== "string" || !isRecord(candidate.properties)) return null;
  return {
    ...(typeof candidate.id === "string" ? { id: candidate.id } : {}),
    type: candidate.type,
    properties: candidate.properties,
  };
}

function statusFromOpenCode(value: unknown): CanonicalSessionStatus {
  if (!isRecord(value) || typeof value.type !== "string") return { type: "idle" };
  if (value.type === "busy" || value.type === "running") return { type: "running" };
  if (value.type === "waiting") return { type: "waiting" };
  if (value.type === "retry" || value.type === "retrying") {
    return {
      type: "retrying",
      attempt: Math.max(1, numberValue(value.attempt) ?? 1),
      message: stringValue(value.message) ?? "OpenCode is retrying",
      nextAt: numberValue(value.next) ?? Date.now(),
    };
  }
  return { type: "idle" };
}

function todoStatus(value: unknown): CanonicalAgentTodo["status"] {
  return value === "in_progress" || value === "completed" || value === "cancelled" ? value : "pending";
}

function todoPriority(value: unknown): CanonicalAgentTodo["priority"] {
  return value === "high" || value === "low" ? value : "medium";
}

function modelCapabilities(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const result: string[] = [];
  for (const [name, enabled] of Object.entries(value)) {
    if (enabled === true) result.push(name);
    if (isRecord(enabled) && Object.values(enabled).some(Boolean)) result.push(name);
  }
  return result;
}

/**
 * Runtime-neutral wrapper over the existing OpenCode SDK and Server operations.
 * Dependencies are injected so routes can pass their established reload/MCP
 * functions instead of introducing a second OpenCode lifecycle path.
 */
export class OpenCodeAgentEngineAdapter implements AgentEnginePort {
  readonly runtimeId = RUNTIME_ID;

  readonly #now: () => number;
  readonly #clients = new Map<string, OpenCodeClientShape>();
  readonly #publicToBackend = new Map<string, string>();
  readonly #backendToPublic = new Map<string, string>();
  readonly #sessionWorkspace = new Map<string, string>();
  readonly #sessionConfiguration = new Map<string, JsonObject>();
  readonly #statuses = new Map<string, CanonicalSessionStatus>();
  readonly #messages = new Map<string, Map<string, CanonicalAgentMessage>>();
  readonly #pendingDeltas = new Map<string, string>();
  readonly #interactions = new Map<string, CanonicalInteraction>();
  readonly #activeRuns = new Map<string, string>();
  readonly #sequences = new Map<string, number>();
  #models: AgentRuntimeModel[] = [];
  #disposed = false;

  constructor(private readonly options: OpenCodeAgentEngineAdapterOptions) {
    this.#now = options.now ?? Date.now;
  }

  async descriptor(): Promise<AgentRuntimeDescriptor> {
    return {
      schemaVersion: 1,
      id: this.runtimeId,
      engine: "opencode",
      label: "JuggleWork",
      description: "The existing JuggleWork agent powered by OpenCode",
      isDefault: true,
      capabilities,
      health: await this.health(),
      models: this.#models,
    };
  }

  async health(): Promise<AgentRuntimeHealth> {
    if (this.#disposed) {
      return {
        status: "stopping",
        checkedAt: this.#now(),
        reasonCode: null,
        message: null,
      };
    }
    if (this.options.health) return this.options.health();
    return { status: "healthy", checkedAt: this.#now(), reasonCode: null, message: null };
  }

  async listModels(context: AgentEngineContext): Promise<AgentRuntimeModel[]> {
    const client = this.#client(context);
    const data = unwrapData(
      await requireMethod(client.provider, client.provider?.list, "provider.list")(),
      "/provider",
    );
    if (!isRecord(data) || !Array.isArray(data.all)) throw requestError("/provider", data);
    const defaults = isRecord(data.default) ? data.default : {};
    const models: AgentRuntimeModel[] = [];
    for (const providerValue of data.all) {
      if (!isRecord(providerValue) || !stringValue(providerValue.id) || !isRecord(providerValue.models)) continue;
      const providerId = providerValue.id as string;
      for (const [modelId, modelValue] of Object.entries(providerValue.models)) {
        if (!isRecord(modelValue)) continue;
        models.push({
          id: stringValue(modelValue.id) ?? modelId,
          providerId,
          label: stringValue(modelValue.name) ?? modelId,
          isDefault: false,
          capabilities: modelCapabilities(modelValue.capabilities),
        });
      }
    }
    const defaultIndex = models.findIndex((model) => defaults[model.providerId] === model.id);
    if (defaultIndex >= 0) models[defaultIndex] = { ...models[defaultIndex]!, isDefault: true };
    this.#models = models;
    return models;
  }

  async listAgentProfiles(context: AgentEngineContext) {
    const client = this.#client(context);
    const data = unwrapData(await requireMethod(client.app, client.app?.agents, "app.agents")(), "/agent");
    if (!Array.isArray(data)) throw requestError("/agent", data);
    return data.flatMap((value) => isRecord(value) && stringValue(value.name) && value.hidden !== true && value.mode !== "subagent"
      ? [{ id: value.name as string, label: value.name as string, ...(stringValue(value.description) ? { description: value.description as string } : {}) }]
      : []);
  }

  async listSkills(context: AgentEngineContext) {
    const client = this.#client(context);
    const data = unwrapData(await requireMethod(client.app, client.app?.skills, "app.skills")(), "/skill");
    if (!Array.isArray(data)) throw requestError("/skill", data);
    return data.flatMap((value) => isRecord(value) && stringValue(value.name)
      ? [{ id: value.name as string, label: value.name as string, ...(stringValue(value.description) ? { description: value.description as string } : {}) }]
      : []);
  }

  async listTools(context: AgentEngineContext) {
    const client = this.#client(context);
    const [idsValue, statusValue] = await Promise.all([
      requireMethod(client.tool, client.tool?.ids, "tool.ids")().then((result) => unwrapData(result, "/experimental/tool/ids")),
      requireMethod(client.mcp, client.mcp?.status, "mcp.status")().then((result) => unwrapData(result, "/mcp")),
    ]);
    if (!Array.isArray(idsValue) || !isRecord(statusValue)) throw requestError("/experimental/tool/ids", idsValue);
    const sources = Object.keys(statusValue).sort((left, right) => right.length - left.length);
    return idsValue.flatMap((value) => typeof value === "string" && value
      ? [{
          id: value,
          source: sources.find((source) => value.startsWith(`${source}_`)) ?? null,
          available: !sources.some((source) => value.startsWith(`${source}_`))
            || isRecord(statusValue[sources.find((source) => value.startsWith(`${source}_`))!])
              && (statusValue[sources.find((source) => value.startsWith(`${source}_`))!] as Record<string, unknown>).status === "connected",
        }]
      : []);
  }

  async createSession(input: CreateAgentSessionInput): Promise<CanonicalAgentSession> {
    const client = this.#client(input);
    const agentProfile = stringValue(input.configuration.agentProfile) ?? stringValue(input.configuration.agent);
    const result = unwrapData(
      await requireMethod(client.session, client.session?.create, "session.create")({
        ...(agentProfile ? { agent: agentProfile } : {}),
        title: input.title,
      }),
      "/session",
    );
    if (!isRecord(result) || !stringValue(result.id)) throw requestError("/session", result);
    this.#bind(input.sessionId, result.id as string, input.workspaceId, input.configuration as JsonObject);
    return this.#mapSession(result, input, input.sessionId);
  }

  async listSessions(context: ListAgentSessionsInput): Promise<CanonicalAgentSession[]> {
    const client = this.#client(context);
    const data = unwrapData(await requireMethod(client.session, client.session?.list, "session.list")({
      ...(context.roots === undefined ? {} : { roots: context.roots }),
      ...(context.start === undefined ? {} : { start: context.start }),
      ...(context.search === undefined ? {} : { search: context.search }),
      ...(context.limit === undefined ? {} : { limit: context.limit }),
    }), "/session");
    if (!Array.isArray(data)) throw requestError("/session", data);
    const statuses = await this.#readStatuses(client);
    return data.flatMap((value) => {
      if (!isRecord(value) || !stringValue(value.id)) return [];
      const publicId = this.#publicId(value.id as string);
      this.#bind(publicId, value.id as string, context.workspaceId);
      return [this.#mapSession(value, context, publicId, statuses[value.id as string])];
    });
  }

  async readSession(context: AgentEngineContext & { sessionId: string }): Promise<CanonicalAgentSession> {
    const client = this.#client(context);
    const backendId = this.#readBackendId(context);
    const [session, statuses] = await Promise.all([
      requireMethod(client.session, client.session?.get, "session.get")({ sessionID: backendId }).then((result) => unwrapData(result, `/session/${backendId}`)),
      this.#readStatuses(client),
    ]);
    if (!isRecord(session)) throw requestError(`/session/${backendId}`, session);
    this.#bind(context.sessionId, backendId, context.workspaceId);
    return this.#mapSession(session, context, context.sessionId, statuses[backendId]);
  }

  async readMessages(
    context: AgentEngineContext & { sessionId: string; backendSessionId?: string | null; limit?: number },
  ): Promise<CanonicalAgentMessage[]> {
    const client = this.#client(context);
    const backendId = this.#readBackendId(context);
    const data = unwrapData(
      await requireMethod(client.session, client.session?.messages, "session.messages")({
        sessionID: backendId,
        ...(context.limit === undefined ? {} : { limit: context.limit }),
      }),
      `/session/${backendId}/message`,
    );
    if (!Array.isArray(data)) throw requestError(`/session/${backendId}/message`, data);
    const messages = data.flatMap((value) => {
      const mapped = this.#mapMessageEnvelope(value, context.sessionId);
      return mapped ? [mapped] : [];
    });
    this.#messages.set(context.sessionId, new Map(messages.map((message) => [message.id, message])));
    return messages;
  }

  async readSnapshot(
    context: AgentEngineContext & { sessionId: string; backendSessionId?: string | null; limit?: number },
  ): Promise<CanonicalSessionSnapshot> {
    const client = this.#client(context);
    const backendId = this.#readBackendId(context);
    const [
      sessionValue,
      messageValue,
      todoValue,
      statuses,
      permissionLists,
      questionLists,
    ] = await Promise.all([
      requireMethod(client.session, client.session?.get, "session.get")({ sessionID: backendId }).then((result) => unwrapData(result, `/session/${backendId}`)),
      requireMethod(client.session, client.session?.messages, "session.messages")({
        sessionID: backendId,
        ...(context.limit === undefined ? {} : { limit: context.limit }),
      }).then((result) => unwrapData(result, `/session/${backendId}/message`)),
      requireMethod(client.session, client.session?.todo, "session.todo")({ sessionID: backendId }).then((result) => unwrapData(result, `/session/${backendId}/todo`)),
      this.#readStatuses(client),
      this.#readInteractionLists(
        client.permission,
        client.permission?.list,
        client.v2?.session?.permission,
        client.v2?.session?.permission?.list,
        backendId,
        "permission",
      ),
      this.#readInteractionLists(
        client.question,
        client.question?.list,
        client.v2?.session?.question,
        client.v2?.session?.question?.list,
        backendId,
        "question",
      ),
    ]);
    if (!isRecord(sessionValue) || !Array.isArray(messageValue) || !Array.isArray(todoValue)) {
      throw requestError(`/session/${backendId}/snapshot`, null);
    }
    this.#bind(context.sessionId, backendId, context.workspaceId);
    const messages = messageValue.flatMap((value) => {
      const mapped = this.#mapMessageEnvelope(value, context.sessionId);
      return mapped ? [mapped] : [];
    });
    this.#messages.set(context.sessionId, new Map(messages.map((message) => [message.id, message])));
    const interactions = [...new Map([
      ...this.#mapPermissionList(permissionLists.legacy, context.sessionId),
      ...this.#mapPermissionList(permissionLists.v2, context.sessionId, "v2"),
      ...this.#mapQuestionList(questionLists.legacy, context.sessionId),
      ...this.#mapQuestionList(questionLists.v2, context.sessionId, "v2"),
    ].map((interaction) => [interaction.id, interaction])).values()];
    return {
      schemaVersion: 1,
      session: this.#mapSession(sessionValue, context, context.sessionId, statuses[backendId]),
      messages,
      todos: this.#mapTodos(todoValue, context.sessionId),
      interactions,
      latestSequence: this.#sequences.get(context.sessionId) ?? 0,
    };
  }

  async readInteractions(
    context: AgentEngineContext & { sessionId: string; backendSessionId?: string | null },
  ): Promise<CanonicalInteraction[]> {
    const client = this.#client(context);
    const backendId = this.#readBackendId(context);
    const [permissionLists, questionLists] = await Promise.all([
      this.#readInteractionLists(
        client.permission,
        client.permission?.list,
        client.v2?.session?.permission,
        client.v2?.session?.permission?.list,
        backendId,
        "permission",
      ),
      this.#readInteractionLists(
        client.question,
        client.question?.list,
        client.v2?.session?.question,
        client.v2?.session?.question?.list,
        backendId,
        "question",
      ),
    ]);
    this.#bind(context.sessionId, backendId, context.workspaceId);
    const interactions = [...new Map([
      ...this.#mapPermissionList(permissionLists.legacy, context.sessionId),
      ...this.#mapPermissionList(permissionLists.v2, context.sessionId, "v2"),
      ...this.#mapQuestionList(questionLists.legacy, context.sessionId),
      ...this.#mapQuestionList(questionLists.v2, context.sessionId, "v2"),
    ].map((interaction) => [interaction.id, interaction])).values()];
    for (const interaction of interactions) this.#interactions.set(interaction.id, interaction);
    return interactions;
  }

  async startRun(input: StartAgentRunInput): Promise<void> {
    const backendId = this.#resolveBackendId(input.sessionId, input.backendSessionId);
    const client = this.#client(input);
    const configuration = this.#sessionConfiguration.get(input.sessionId) ?? {};
    const configuredModel = isRecord(configuration.model)
      && stringValue(configuration.model.providerId)
      && stringValue(configuration.model.modelId)
      ? { providerID: configuration.model.providerId as string, modelID: configuration.model.modelId as string }
      : undefined;
    const execution = isRecord(configuration.execution) ? configuration.execution : {};
    const configuredAgent = stringValue(configuration.agentProfile) ?? stringValue(configuration.agent);
    const prompt = {
      ...(configuredModel && !("model" in input.prompt) ? { model: configuredModel } : {}),
      ...(configuredAgent && !("agent" in input.prompt) ? { agent: configuredAgent } : {}),
      ...(stringValue(execution.effort) && !("variant" in input.prompt) ? { variant: execution.effort } : {}),
      ...input.prompt,
    };
    if (this.options.startRun) {
      await this.options.startRun(client, { ...input, prompt }, backendId);
    } else if (input.delivery && input.delivery !== "start") {
      const parts = Array.isArray(input.prompt.parts) ? input.prompt.parts : [];
      const textPart = parts.length === 1 && isRecord(parts[0]) && parts[0].type === "text"
        && typeof parts[0].text === "string" ? parts[0].text : null;
      if (!textPart) {
        throw new AgentEngineError("runtime_request_failed", "OpenCode queued prompts require one text part", {
          runtimeId: this.runtimeId,
          sessionId: input.sessionId,
          delivery: input.delivery,
        });
      }
      const requestId = input.requestId ?? input.runId;
      const result = await requireMethod(client.v2?.session, client.v2?.session?.prompt, "v2.session.prompt")({
        sessionID: backendId,
        id: requestId,
        prompt: { text: textPart },
        delivery: input.delivery === "steer" ? "steer" : "queue",
      });
      const admitted = isRecord(result) && isRecord(result.data) && isRecord(result.data.data)
        ? result.data.data : isRecord(result) ? result.data : null;
      if (!isRecord(admitted) || admitted.id !== requestId || admitted.sessionID !== backendId) {
        throw requestError(`/api/session/${backendId}/prompt`, result);
      }
    } else {
      const result = await requireMethod(client.session, client.session?.promptAsync, "session.promptAsync")({
        sessionID: backendId,
        ...prompt,
      });
      assertAccepted(result, `/session/${backendId}/prompt_async`);
    }
    this.#activeRuns.set(input.sessionId, input.runId);
    this.#statuses.set(input.sessionId, { type: "starting" });
  }

  async deleteSession(input: DeleteAgentSessionInput): Promise<void> {
    const backendId = this.#resolveBackendId(input.sessionId, input.backendSessionId);
    const client = this.#client(input);
    const result = await requireMethod(client.session, client.session?.delete, "session.delete")({ sessionID: backendId });
    assertAccepted(result, `/session/${backendId}`);
    this.#publicToBackend.delete(input.sessionId);
    this.#backendToPublic.delete(backendId);
    this.#sessionWorkspace.delete(input.sessionId);
    this.#sessionConfiguration.delete(input.sessionId);
    this.#statuses.delete(input.sessionId);
    this.#messages.delete(input.sessionId);
  }

  async updateSession(input: UpdateAgentSessionInput): Promise<CanonicalAgentSession> {
    const backendId = this.#resolveBackendId(input.sessionId, input.backendSessionId);
    const client = this.#client(input);
    const result = unwrapData(await requireMethod(client.session, client.session?.update, "session.update")({
      sessionID: backendId,
      title: input.title,
    }), `/session/${backendId}`);
    if (!isRecord(result)) throw requestError(`/session/${backendId}`, result);
    return this.#mapSession(result, input, input.sessionId);
  }

  async forkSession(input: ForkAgentSessionInput): Promise<ForkAgentSessionResult> {
    const client = this.#client(input);
    const result = unwrapData(await requireMethod(client.session, client.session?.fork, "session.fork")({
      sessionID: input.sourceBackendSessionId,
      ...(input.upToMessageId ? { messageID: input.upToMessageId } : {}),
    }), `/session/${input.sourceBackendSessionId}/fork`);
    if (!isRecord(result) || !stringValue(result.id)) throw requestError(`/session/${input.sourceBackendSessionId}/fork`, result);
    const backendId = result.id as string;
    this.#bind(input.targetSessionId, backendId, input.workspaceId, {});
    return {
      session: {
        ...this.#mapSession({ ...result, title: input.title }, input, input.targetSessionId),
        id: input.targetSessionId,
        backendSessionId: backendId,
        title: input.title,
      },
      filesystemState: {
        sharedWorkingTree: true,
        checkpointHistoryCopied: false,
        filesRewound: false,
        warning: "The fork shares the current working tree and does not restore files or copy checkpoint history.",
      },
    };
  }

  async abortRun(input: AbortAgentRunInput): Promise<void> {
    const backendId = this.#resolveBackendId(input.sessionId, input.backendSessionId);
    const client = this.#client(input);
    if (this.options.abortRun) {
      await this.options.abortRun(client, input, backendId);
    } else {
      const result = await requireMethod(client.session, client.session?.abort, "session.abort")({ sessionID: backendId });
      assertAccepted(result, `/session/${backendId}/abort`);
    }
    this.#statuses.set(input.sessionId, { type: "aborting" });
  }

  async *subscribeEvents(context: AgentEngineContext, signal?: AbortSignal): AsyncIterable<CanonicalAgentEvent> {
    const client = this.#client(context);
    const subscription = await requireMethod(client.event, client.event?.subscribe, "event.subscribe")(
      undefined,
      signal ? { signal } : undefined,
    );
    if (!isRecord(subscription) || !subscription.stream || !(Symbol.asyncIterator in Object(subscription.stream))) {
      throw requestError("/event", subscription);
    }
    for await (const raw of subscription.stream as AsyncIterable<unknown>) {
      if (signal?.aborted) return;
      const event = openCodeEvent(raw);
      if (!event) continue;
      for (const mapped of this.#mapEvent(context, event)) yield mapped;
    }
  }

  async resolveInteraction(input: ResolveAgentInteractionInput): Promise<void> {
    const backendId = this.#resolveBackendId(input.sessionId, input.backendSessionId);
    const client = this.#client(input);
    const known = this.#interactions.get(input.interactionId);
    if (known?.kind === "question" || input.resolution.outcome === "answer" || input.resolution.outcome === "reject") {
      const v2 = known?.metadata?.protocol === "v2";
      if (input.resolution.outcome === "answer") {
        const answers = input.questionAnswers?.map((answer) => answer.values)
          ?? questionAnswers(known, input.resolution.values);
        const result = v2
          ? await requireMethod(client.v2?.session?.question, client.v2?.session?.question?.reply, "v2.session.question.reply")({
              sessionID: backendId,
              requestID: input.interactionId,
              questionV2Reply: { answers },
            })
          : await requireMethod(client.question, client.question?.reply, "question.reply")({
              requestID: input.interactionId,
              answers,
            });
        assertAccepted(result, v2
          ? `/api/session/${backendId}/question/${input.interactionId}/reply`
          : `/question/${input.interactionId}/reply`);
      } else {
        const result = v2
          ? await requireMethod(client.v2?.session?.question, client.v2?.session?.question?.reject, "v2.session.question.reject")({
              sessionID: backendId,
              requestID: input.interactionId,
            })
          : await requireMethod(client.question, client.question?.reject, "question.reject")({ requestID: input.interactionId });
        assertAccepted(result, v2
          ? `/api/session/${backendId}/question/${input.interactionId}/reject`
          : `/question/${input.interactionId}/reject`);
      }
      return;
    }
    const reply = input.resolution.outcome === "allow"
      ? isRecord(input.resolution.updatedInput) && input.resolution.updatedInput.permissionPersistence === "always" ? "always" : "once"
      : "reject";
    const v2 = known?.metadata?.protocol === "v2";
    const result = v2
      ? await requireMethod(client.v2?.session?.permission, client.v2?.session?.permission?.reply, "v2.session.permission.reply")({
          sessionID: backendId,
          requestID: input.interactionId,
          reply,
          ...(input.resolution.outcome === "deny" ? { message: input.resolution.reason } : {}),
        })
        : await requireMethod(client.permission, client.permission?.reply, "permission.reply")({
            requestID: input.interactionId,
            reply,
          });
    assertAccepted(result, v2
      ? `/api/session/${backendId}/permission/${input.interactionId}/reply`
      : `/permission/${input.interactionId}/reply`);
    this.#bind(input.sessionId, backendId, input.workspaceId);
  }

  async reloadConfiguration(context: AgentEngineContext): Promise<void> {
    const client = this.#client(context);
    if (this.options.reloadConfiguration) {
      await this.options.reloadConfiguration(client, context);
      return;
    }
    const result = await requireMethod(client.instance, client.instance?.dispose, "instance.dispose")();
    assertAccepted(result, "/instance/dispose");
  }

  async registerMcp(
    context: AgentEngineContext,
    name: string,
    configuration: Record<string, unknown>,
  ): Promise<void> {
    const client = this.#client(context);
    if (this.options.registerMcp) {
      await this.options.registerMcp(client, context, name, configuration);
      return;
    }
    const result = await requireMethod(client.mcp, client.mcp?.add, "mcp.add")({ name, config: configuration });
    assertAccepted(result, "/mcp");
  }

  async disconnectMcp(context: AgentEngineContext, name: string): Promise<void> {
    const client = this.#client(context);
    if (this.options.disconnectMcp) {
      await this.options.disconnectMcp(client, context, name);
      return;
    }
    const result = await requireMethod(client.mcp, client.mcp?.disconnect, "mcp.disconnect")({ name });
    assertAccepted(result, `/mcp/${name}/disconnect`);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.options.dispose) {
      await this.options.dispose();
    } else {
      await Promise.all([...new Set(this.#clients.values())].map(async (client) => {
        const owner = client.instance?.dispose ? client.instance : client.global;
        const result = await requireMethod(owner, client.instance?.dispose ?? client.global?.dispose, "instance.dispose")();
        assertAccepted(result, "/instance/dispose");
      }));
    }
    this.#clients.clear();
  }

  #client(context: AgentEngineContext): OpenCodeClientShape {
    if (this.#disposed) {
      throw new AgentEngineError("runtime_unavailable", "OpenCode adapter has been disposed", {
        runtimeId: this.runtimeId,
      });
    }
    const key = `${context.workspaceId}\0${context.directory}`;
    const existing = this.#clients.get(key);
    if (existing) return existing;
    const client = this.options.createClient(context) as OpenCodeClientShape;
    this.#clients.set(key, client);
    return client;
  }

  #bind(publicId: string, backendId: string, workspaceId: string, configuration?: JsonObject): void {
    this.#publicToBackend.set(publicId, backendId);
    this.#backendToPublic.set(backendId, publicId);
    this.#sessionWorkspace.set(publicId, workspaceId);
    if (configuration) this.#sessionConfiguration.set(publicId, jsonValue(configuration) as JsonObject);
  }

  #publicId(backendId: string): string {
    return this.#backendToPublic.get(backendId) ?? backendId;
  }

  #backendId(publicId: string): string {
    return this.#publicToBackend.get(publicId) ?? publicId;
  }

  #readBackendId(context: AgentEngineContext & { sessionId: string; backendSessionId?: string | null }): string {
    const backendId = this.#resolveBackendId(context.sessionId, context.backendSessionId ?? null);
    this.#bind(context.sessionId, backendId, context.workspaceId);
    return backendId;
  }

  #resolveBackendId(publicId: string, supplied: string | null): string {
    const mapped = this.#publicToBackend.get(publicId);
    if (mapped && supplied && mapped !== supplied) {
      throw new AgentEngineError("runtime_session_mismatch", "OpenCode backend session does not match the runtime binding", {
        runtimeId: this.runtimeId,
        sessionId: publicId,
        expectedBackendSessionId: mapped,
        backendSessionId: supplied,
      });
    }
    return supplied ?? mapped ?? publicId;
  }

  async #readStatuses(client: OpenCodeClientShape): Promise<Record<string, unknown>> {
    const data = unwrapData(await requireMethod(client.session, client.session?.status, "session.status")(), "/session/status");
    if (!isRecord(data)) throw requestError("/session/status", data);
    return data;
  }

  async #readInteractionLists(
    legacyOwner: object | undefined,
    legacyMethod: OpenCodeMethod | undefined,
    v2Owner: object | undefined,
    v2Method: OpenCodeMethod | undefined,
    backendId: string,
    kind: "permission" | "question",
  ): Promise<{ legacy: unknown[]; v2: unknown[] }> {
    const legacyPath = `/${kind}`;
    const v2Path = `/api/session/${backendId}/${kind}`;
    const reads = await Promise.allSettled([
      legacyOwner && legacyMethod
        ? requireMethod(legacyOwner, legacyMethod, `${kind}.list`)().then((result) => {
            const data = unwrapData(result, legacyPath);
            if (!Array.isArray(data)) throw requestError(legacyPath, data);
            return data;
          })
        : Promise.reject(requestError(legacyPath, null)),
      v2Owner && v2Method
        ? requireMethod(v2Owner, v2Method, `v2.session.${kind}.list`)({ sessionID: backendId }).then((result) => {
            const data = unwrapData(result, v2Path);
            if (!isRecord(data) || !Array.isArray(data.data)) throw requestError(v2Path, data);
            return data.data;
          })
        : Promise.reject(requestError(v2Path, null)),
    ]);
    if (reads.every((read) => read.status === "rejected")) {
      throw (reads[1] as PromiseRejectedResult).reason;
    }
    return {
      legacy: reads[0]?.status === "fulfilled" ? reads[0].value : [],
      v2: reads[1]?.status === "fulfilled" ? reads[1].value : [],
    };
  }

  #mapSession(
    value: Record<string, unknown>,
    context: AgentEngineContext,
    publicId: string,
    statusValue?: unknown,
  ): CanonicalAgentSession {
    const backendId = stringValue(value.id) ?? this.#backendId(publicId);
    const time = isRecord(value.time) ? value.time : {};
    const createdAt = numberValue(time.created) ?? this.#now();
    const updatedAt = numberValue(time.updated) ?? createdAt;
    const status = statusValue === undefined
      ? this.#statuses.get(publicId) ?? { type: "idle" as const }
      : statusFromOpenCode(statusValue);
    this.#statuses.set(publicId, status);
    const lastError = isRecord(value.error)
      ? { code: stringValue(value.error.name) ?? "opencode_error", message: errorMessage(value.error) }
      : null;
    const backendConfiguration = {
      ...(stringValue(value.agent) ? { agent: value.agent as string } : {}),
      ...(isRecord(value.model) ? { model: value.model } : {}),
      ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
      ...(stringValue(value.slug) ? { slug: value.slug as string } : {}),
    };
    return {
      id: publicId,
      workspaceId: this.#sessionWorkspace.get(publicId) ?? context.workspaceId,
      runtimeId: this.runtimeId,
      backendSessionId: backendId,
      title: stringValue(value.title) ?? stringValue(value.slug) ?? publicId,
      canonicalCwd: stringValue(value.directory) ?? context.directory,
      status,
      configuration: this.#sessionConfiguration.get(publicId) ?? jsonValue(backendConfiguration) as JsonObject,
      createdAt,
      updatedAt,
      lastError,
    };
  }

  #mapMessageEnvelope(value: unknown, publicSessionId: string): CanonicalAgentMessage | null {
    if (!isRecord(value) || !isRecord(value.info) || !Array.isArray(value.parts)) return null;
    const message = this.#mapMessageInfo(value.info, publicSessionId);
    if (!message) return null;
    const parts = value.parts.flatMap((part, ordinal) => {
      const mapped = this.#mapPart(part, publicSessionId, message, ordinal);
      return mapped ? [mapped] : [];
    });
    const withParts = { ...message, parts };
    this.#messageMap(publicSessionId).set(withParts.id, withParts);
    return withParts;
  }

  #mapMessageInfo(value: unknown, publicSessionId: string): CanonicalAgentMessage | null {
    if (!isRecord(value) || !stringValue(value.id)) return null;
    const role = value.role === "assistant" || value.role === "system" ? value.role : "user";
    const time = isRecord(value.time) ? value.time : {};
    const createdAt = numberValue(time.created) ?? this.#now();
    const completedAt = numberValue(time.completed);
    const existing = this.#messageMap(publicSessionId).get(value.id as string);
    const metadata = jsonValue({
      ...(stringValue(value.providerID) ? { providerId: value.providerID } : {}),
      ...(stringValue(value.modelID) ? { modelId: value.modelID } : {}),
      ...(stringValue(value.agent) ? { agent: value.agent } : {}),
      ...(stringValue(value.finish) ? { finish: value.finish } : {}),
    }) as JsonObject;
    const parts = existing?.parts ? [...existing.parts] : [];
    if (isRecord(value.error)) {
      const errorPart: CanonicalAgentPart = {
        id: `${value.id}:error`,
        messageId: value.id as string,
        sessionId: publicSessionId,
        ordinal: parts.length,
        type: "error",
        code: stringValue(value.error.name) ?? "opencode_error",
        message: errorMessage(value.error),
        retryable: isRecord(value.error.data) && value.error.data.isRetryable === true,
        createdAt: completedAt ?? createdAt,
        updatedAt: completedAt ?? createdAt,
      };
      const errorIndex = parts.findIndex((part) => part.id === errorPart.id);
      if (errorIndex >= 0) parts[errorIndex] = errorPart;
      else parts.push(errorPart);
    }
    return {
      id: value.id as string,
      sessionId: publicSessionId,
      role,
      parentId: stringValue(value.parentID),
      createdAt,
      completedAt,
      parts,
      ...(Object.keys(metadata).length ? { metadata } : {}),
    };
  }

  #mapPart(
    value: unknown,
    publicSessionId: string,
    message: CanonicalAgentMessage,
    ordinal: number,
  ): CanonicalAgentPart | null {
    if (!isRecord(value) || !stringValue(value.id)) return null;
    const id = value.id as string;
    const messageId = stringValue(value.messageID) ?? message.id;
    const time = isRecord(value.time) ? value.time : {};
    const createdAt = numberValue(time.start) ?? message.createdAt;
    const updatedAt = numberValue(time.end) ?? message.completedAt ?? createdAt;
    const base = { id, messageId, sessionId: publicSessionId, ordinal, createdAt, updatedAt };
    if (value.type === "text" || value.type === "reasoning") {
      const pending = this.#pendingDeltas.get(id) ?? "";
      const current = typeof value.text === "string" ? value.text : "";
      const text = pending.length > current.length ? pending : current;
      this.#pendingDeltas.delete(id);
      const state = numberValue(time.end) !== null || message.completedAt !== null ? "complete" as const : "streaming" as const;
      if (value.type === "reasoning") {
        return { ...base, type: "reasoning", text, visibility: "visible", state };
      }
      return { ...base, type: "text", text, state };
    }
    if (value.type === "tool") {
      const state = isRecord(value.state) ? value.state : {};
      const status = state.status;
      const mappedState: Extract<CanonicalAgentPart, { type: "tool" }>["state"] =
        status === "running" ? "running"
          : status === "completed" ? "completed"
            : status === "error" ? "error"
              : "pending";
      return {
        ...base,
        type: "tool",
        toolCallId: stringValue(value.callID) ?? id,
        toolName: stringValue(value.tool) ?? "tool",
        state: mappedState,
        ...(state.input !== undefined ? { input: jsonValue(state.input) } : {}),
        ...(state.output !== undefined ? { output: jsonValue(state.output) } : {}),
        ...(mappedState === "error" ? { error: errorMessage(state.error) } : {}),
      };
    }
    if (value.type === "file") {
      const source = isRecord(value.source) ? value.source : {};
      return {
        ...base,
        type: "file",
        name: stringValue(value.filename) ?? stringValue(source.path) ?? "attachment",
        ...(stringValue(value.mime) ? { mime: value.mime as string } : {}),
        ...(stringValue(value.url) ? { uri: value.url as string } : {}),
        ...(!stringValue(value.url) && stringValue(source.path) ? { workspacePath: source.path as string } : {}),
      };
    }
    if (value.type === "agent" || value.type === "subtask") {
      return {
        ...base,
        type: "agent",
        agentId: stringValue(value.name) ?? stringValue(value.agent) ?? id,
        label: stringValue(value.description) ?? stringValue(value.name) ?? undefined,
        state: "completed",
      };
    }
    return {
      ...base,
      type: "structured",
      value: jsonValue(value),
      schemaName: stringValue(value.type) ?? "opencode-part",
    };
  }

  #mapTodos(value: unknown, sessionId: string): CanonicalAgentTodo[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((todo, index) => {
      if (!isRecord(todo) || !stringValue(todo.content)) return [];
      return [{
        id: stringValue(todo.id) ?? `todo:${sessionId}:${index}`,
        content: todo.content as string,
        status: todoStatus(todo.status),
        priority: todoPriority(todo.priority),
      }];
    });
  }

  #mapPermissionList(value: unknown, sessionId: string, protocol: "legacy" | "v2" = "legacy"): CanonicalInteraction[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((permission) => {
      if (!isRecord(permission) || permission.sessionID !== this.#backendId(sessionId) || !stringValue(permission.id)) return [];
      const mapped = this.#permissionInteraction({ ...permission, protocol }, sessionId, this.#now());
      this.#interactions.set(mapped.id, mapped);
      return [mapped];
    });
  }

  #mapQuestionList(value: unknown, sessionId: string, protocol: "legacy" | "v2" = "legacy"): CanonicalInteraction[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((question) => {
      if (!isRecord(question) || question.sessionID !== this.#backendId(sessionId) || !stringValue(question.id)) return [];
      const mapped = this.#questionInteraction({ ...question, protocol }, sessionId, this.#now());
      this.#interactions.set(mapped.id, mapped);
      return [mapped];
    });
  }

  #permissionInteraction(value: Record<string, unknown>, sessionId: string, requestedAt: number): CanonicalInteraction {
    const id = stringValue(value.id) ?? "permission";
    const title = stringValue(value.permission) ?? stringValue(value.action) ?? "Permission required";
    const resources = Array.isArray(value.patterns) ? value.patterns : value.resources;
    return {
      id,
      sessionId,
      runId: this.#activeRuns.get(sessionId) ?? `run:${sessionId}`,
      kind: "permission",
      state: "pending",
      title,
      description: Array.isArray(resources) ? resources.filter((item): item is string => typeof item === "string").join("\n") : undefined,
      input: jsonValue(isRecord(value.metadata) ? value.metadata : {}),
      requestedAt,
      deadlineAt: null,
      resolvedAt: null,
      resolution: null,
      metadata: jsonValue({ protocol: value.protocol === "v2" || stringValue(value.action) ? "v2" : "legacy" }) as JsonObject,
    };
  }

  #questionInteraction(value: Record<string, unknown>, sessionId: string, requestedAt: number): CanonicalInteraction {
    const id = stringValue(value.id) ?? "question";
    const questions = Array.isArray(value.questions) ? value.questions.flatMap((question, index) => {
      if (!isRecord(question) || !stringValue(question.question)) return [];
      return [{
        id: stringValue(question.id) ?? `${id}:${index}`,
        prompt: question.question as string,
        ...(Array.isArray(question.options) ? {
          options: question.options.flatMap((option) => isRecord(option) && stringValue(option.label) ? [option.label as string] : []),
        } : {}),
        multiple: question.multiple === true,
      }];
    }) : [];
    return {
      id,
      sessionId,
      runId: this.#activeRuns.get(sessionId) ?? `run:${sessionId}`,
      kind: "question",
      state: "pending",
      title: stringValue(questions[0]?.prompt) ?? "Question",
      questions,
      requestedAt,
      deadlineAt: null,
      resolvedAt: null,
      resolution: null,
      metadata: jsonValue({ protocol: value.protocol === "v2" || value.type === "question.v2.asked" ? "v2" : "legacy" }) as JsonObject,
    };
  }

  #messageMap(sessionId: string): Map<string, CanonicalAgentMessage> {
    let messages = this.#messages.get(sessionId);
    if (!messages) {
      messages = new Map();
      this.#messages.set(sessionId, messages);
    }
    return messages;
  }

  #event(context: AgentEngineContext, event: OpenCodeEvent, sessionId: string, suffix: string, data: CanonicalAgentEventData): CanonicalAgentEvent {
    const sequence = (this.#sequences.get(sessionId) ?? 0) + 1;
    this.#sequences.set(sessionId, sequence);
    const occurredAt = numberValue(event.properties.timestamp)
      ?? numberValue(event.properties.time)
      ?? this.#now();
    return {
      schemaVersion: 1,
      id: `${event.id ?? `opencode:${sessionId}:${sequence}`}:${suffix}`,
      workspaceId: this.#sessionWorkspace.get(sessionId) ?? context.workspaceId,
      sessionId,
      runtimeId: this.runtimeId,
      sequence,
      occurredAt,
      data,
    };
  }

  #mapEvent(context: AgentEngineContext, event: OpenCodeEvent): CanonicalAgentEvent[] {
    const properties = event.properties;
    const backendSessionId = stringValue(properties.sessionID)
      ?? (isRecord(properties.info) ? stringValue(properties.info.sessionID) ?? stringValue(properties.info.id) : null);
    if (!backendSessionId) return [];
    const sessionId = this.#publicId(backendSessionId);
    this.#bind(sessionId, backendSessionId, context.workspaceId);

    if ((event.type === "session.created" || event.type === "session.updated") && isRecord(properties.info)) {
      const session = this.#mapSession(properties.info, context, sessionId);
      return [this.#event(context, event, sessionId, event.type, { type: event.type, session })];
    }
    if (event.type === "session.status" && properties.status !== undefined) {
      const status = statusFromOpenCode(properties.status);
      this.#statuses.set(sessionId, status);
      return [this.#event(context, event, sessionId, "status", { type: "session.status", status })];
    }
    if (event.type === "session.idle") {
      this.#statuses.set(sessionId, { type: "idle" });
      const events = [this.#event(context, event, sessionId, "status", { type: "session.status", status: { type: "idle" } })];
      const runId = this.#activeRuns.get(sessionId);
      if (runId) {
        events.push(this.#event(context, event, sessionId, "completed", { type: "run.completed", runId }));
        this.#activeRuns.delete(sessionId);
      }
      return events;
    }
    if (event.type === "session.next.retried") {
      const status: CanonicalSessionStatus = {
        type: "retrying",
        attempt: Math.max(1, numberValue(properties.attempt) ?? 1),
        message: errorMessage(properties.error),
        nextAt: numberValue(properties.timestamp) ?? this.#now(),
      };
      this.#statuses.set(sessionId, status);
      return [this.#event(context, event, sessionId, "retry", { type: "session.status", status })];
    }
    if (event.type === "session.error") {
      const runId = this.#activeRuns.get(sessionId) ?? `run:${sessionId}`;
      this.#activeRuns.delete(sessionId);
      return [this.#event(context, event, sessionId, "failed", {
        type: "run.failed",
        runId,
        code: isRecord(properties.error) ? stringValue(properties.error.name) ?? "opencode_error" : "opencode_error",
        message: errorMessage(properties.error),
        retryable: isRecord(properties.error) && isRecord(properties.error.data) && properties.error.data.isRetryable === true,
      })];
    }
    if (event.type === "session.next.step.ended") {
      const tokens = isRecord(properties.tokens) ? properties.tokens : {};
      const cache = isRecord(tokens.cache) ? tokens.cache : {};
      return [this.#event(context, event, sessionId, "usage", {
        type: "run.usage",
        runId: this.#activeRuns.get(sessionId) ?? `run:${sessionId}`,
        usage: {
          ...(numberValue(tokens.input) !== null ? { inputTokens: numberValue(tokens.input)! } : {}),
          ...(numberValue(tokens.output) !== null ? { outputTokens: numberValue(tokens.output)! } : {}),
          ...(numberValue(cache.read) !== null ? { cacheReadTokens: numberValue(cache.read)! } : {}),
          ...(numberValue(cache.write) !== null ? { cacheWriteTokens: numberValue(cache.write)! } : {}),
          ...(decimalValue(properties.cost) !== null ? { estimatedCostUsd: decimalValue(properties.cost)! } : {}),
          estimateOnly: true,
        },
      })];
    }
    if (event.type === "message.updated" && isRecord(properties.info)) {
      const message = this.#mapMessageInfo(properties.info, sessionId);
      if (!message) return [];
      this.#messageMap(sessionId).set(message.id, message);
      return [this.#event(context, event, sessionId, "message", { type: "message.updated", message })];
    }
    if (event.type === "message.part.delta") {
      const messageId = stringValue(properties.messageID);
      const partId = stringValue(properties.partID);
      const delta = typeof properties.delta === "string" ? properties.delta : null;
      if (!messageId || !partId || delta === null) return [];
      const existing = this.#messageMap(sessionId).get(messageId);
      const part = existing?.parts.find((candidate) => candidate.id === partId);
      if (part && (part.type === "text" || part.type === "reasoning")) {
        const updated = { ...part, text: part.text + delta, state: "streaming" as const, updatedAt: this.#now() };
        this.#messageMap(sessionId).set(messageId, {
          ...existing!,
          parts: existing!.parts.map((candidate) => candidate.id === partId ? updated : candidate),
        });
      } else {
        this.#pendingDeltas.set(partId, (this.#pendingDeltas.get(partId) ?? "") + delta);
      }
      return [this.#event(context, event, sessionId, "delta", {
        type: "message.part.delta",
        messageId,
        partId,
        field: part?.type === "reasoning" ? "reasoning" : "text",
        delta,
      })];
    }
    if (event.type === "message.part.updated" && isRecord(properties.part)) {
      const rawPart = properties.part;
      const messageId = stringValue(rawPart.messageID);
      if (!messageId) return [];
      let message = this.#messageMap(sessionId).get(messageId);
      if (!message) {
        message = {
          id: messageId,
          sessionId,
          role: "assistant",
          parentId: null,
          createdAt: this.#now(),
          completedAt: null,
          parts: [],
        };
      }
      const existingIndex = message.parts.findIndex((part) => part.id === rawPart.id);
      const part = this.#mapPart(rawPart, sessionId, message, existingIndex >= 0 ? existingIndex : message.parts.length);
      if (!part) return [];
      const parts = existingIndex >= 0
        ? message.parts.map((candidate, index) => index === existingIndex ? part : candidate)
        : [...message.parts, part];
      this.#messageMap(sessionId).set(messageId, { ...message, parts });
      return [this.#event(context, event, sessionId, "part", { type: "message.part.updated", messageId, part })];
    }
    if (event.type === "todo.updated") {
      return [this.#event(context, event, sessionId, "todos", {
        type: "todo.updated",
        todos: this.#mapTodos(properties.todos, sessionId),
      })];
    }
    if (event.type === "permission.asked" || event.type === "permission.v2.asked") {
      const interaction = this.#permissionInteraction({
        ...properties,
        protocol: event.type === "permission.v2.asked" ? "v2" : "legacy",
      }, sessionId, this.#now());
      this.#interactions.set(interaction.id, interaction);
      return [this.#event(context, event, sessionId, "permission", { type: "interaction.requested", interaction })];
    }
    if (event.type === "question.asked" || event.type === "question.v2.asked") {
      const interaction = this.#questionInteraction({
        ...properties,
        type: event.type,
        protocol: event.type === "question.v2.asked" ? "v2" : "legacy",
      }, sessionId, this.#now());
      this.#interactions.set(interaction.id, interaction);
      return [this.#event(context, event, sessionId, "question", { type: "interaction.requested", interaction })];
    }
    if (event.type === "permission.replied" || event.type === "permission.v2.replied") {
      const resolution: CanonicalInteractionResolution = properties.reply === "reject"
        ? { outcome: "deny", reason: "Rejected" }
        : { outcome: "allow" };
      return this.#resolvedInteractionEvent(context, event, sessionId, resolution);
    }
    if (event.type === "question.replied" || event.type === "question.v2.replied") {
      const answers = Array.isArray(properties.answers)
        ? properties.answers.flatMap((answer) => Array.isArray(answer) ? answer.filter((item): item is string => typeof item === "string") : [])
        : [];
      return this.#resolvedInteractionEvent(context, event, sessionId, { outcome: "answer", values: answers });
    }
    if (event.type === "question.rejected" || event.type === "question.v2.rejected") {
      return this.#resolvedInteractionEvent(context, event, sessionId, { outcome: "reject" });
    }
    return [];
  }

  #resolvedInteractionEvent(
    context: AgentEngineContext,
    event: OpenCodeEvent,
    sessionId: string,
    resolution: CanonicalInteractionResolution,
  ): CanonicalAgentEvent[] {
    const id = stringValue(event.properties.requestID);
    const current = id ? this.#interactions.get(id) : null;
    if (!id || !current) return [];
    const resolvedAt = this.#now();
    const interaction: CanonicalInteraction = {
      ...current,
      state: resolution.outcome === "timeout" ? "timed_out" : resolution.outcome === "cancelled" ? "cancelled" : "resolved",
      resolvedAt,
      resolution,
    };
    this.#interactions.set(id, interaction);
    return [this.#event(context, event, sessionId, "interaction", { type: "interaction.resolved", interaction })];
  }
}
