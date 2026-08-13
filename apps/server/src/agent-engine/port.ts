import type {
  AgentRuntimeDescriptor,
  AgentRuntimeHealth,
  AgentRuntimeModel,
  CanonicalAgentEvent,
  CanonicalInteraction,
  CanonicalAgentMessage,
  CanonicalAgentSession,
  CanonicalInteractionResolution,
  CanonicalSessionSnapshot,
  AgentRuntimeCurrentTurnConfiguration,
} from "@jugglework/types/agent-runtime";

export interface AgentEngineContext {
  workspaceId: string;
  directory: string;
}

export interface CreateAgentSessionInput extends AgentEngineContext {
  sessionId: string;
  title: string;
  configuration: Record<string, unknown>;
}

export interface StartAgentRunInput extends AgentEngineContext {
  sessionId: string;
  backendSessionId: string | null;
  runId: string;
  requestId?: string;
  prompt: Record<string, unknown>;
  delivery?: "start" | "steer" | "enqueue";
  currentTurn?: AgentRuntimeCurrentTurnConfiguration;
}

export interface AbortAgentRunInput extends AgentEngineContext {
  sessionId: string;
  backendSessionId: string | null;
  runId: string;
}

export interface ResolveAgentInteractionInput extends AgentEngineContext {
  sessionId: string;
  backendSessionId: string | null;
  interactionId: string;
  resolution: CanonicalInteractionResolution;
  questionAnswers?: Array<{ questionId: string; values: string[] }>;
}

export interface ReadAgentSessionInput extends AgentEngineContext {
  sessionId: string;
  backendSessionId?: string | null;
  limit?: number;
}

export interface ListAgentSessionsInput extends AgentEngineContext {
  roots?: boolean;
  start?: number;
  search?: string;
  limit?: number;
}

export interface DeleteAgentSessionInput extends AgentEngineContext {
  sessionId: string;
  backendSessionId: string | null;
}

export interface UpdateAgentSessionInput extends AgentEngineContext {
  sessionId: string;
  backendSessionId: string | null;
  title: string;
}

export interface StopAgentSubagentInput extends AgentEngineContext {
  sessionId: string;
  backendSessionId: string | null;
  runId: string;
  taskId: string;
}

export interface ForkAgentSessionInput extends AgentEngineContext {
  sourceSessionId: string;
  sourceBackendSessionId: string;
  targetSessionId: string;
  title: string;
  upToMessageId?: string;
}

export interface ForkAgentSessionResult {
  session: CanonicalAgentSession;
  filesystemState: {
    sharedWorkingTree: true;
    checkpointHistoryCopied: false;
    filesRewound: false;
    warning: string;
  };
}

export interface AgentEnginePort {
  readonly runtimeId: string;

  descriptor(): Promise<AgentRuntimeDescriptor>;
  health(): Promise<AgentRuntimeHealth>;
  listModels(context: AgentEngineContext): Promise<AgentRuntimeModel[]>;
  listAgentProfiles?(context: AgentEngineContext): Promise<Array<{ id: string; label: string; description?: string }>>;
  listSkills?(context: AgentEngineContext): Promise<Array<{ id: string; label: string; description?: string }>>;
  listTools?(context: AgentEngineContext): Promise<Array<{ id: string; source: string | null; available: boolean }>>;
  createSession(input: CreateAgentSessionInput): Promise<CanonicalAgentSession>;
  restoreSession?(session: CanonicalAgentSession): void | Promise<void>;
  listSessions(context: ListAgentSessionsInput): Promise<CanonicalAgentSession[]>;
  readSession(context: ReadAgentSessionInput): Promise<CanonicalAgentSession>;
  readMessages(context: ReadAgentSessionInput): Promise<CanonicalAgentMessage[]>;
  readInteractions?(context: ReadAgentSessionInput): Promise<CanonicalInteraction[]>;
  readSnapshot(context: ReadAgentSessionInput): Promise<CanonicalSessionSnapshot>;
  updateSession?(input: UpdateAgentSessionInput): Promise<CanonicalAgentSession>;
  deleteSession?(input: DeleteAgentSessionInput): Promise<void>;
  startRun(input: StartAgentRunInput): Promise<void>;
  abortRun(input: AbortAgentRunInput): Promise<void>;
  stopSubagent?(input: StopAgentSubagentInput): Promise<void>;
  forkSession?(input: ForkAgentSessionInput): Promise<ForkAgentSessionResult>;
  subscribeEvents(context: AgentEngineContext, signal?: AbortSignal): AsyncIterable<CanonicalAgentEvent>;
  resolveInteraction(input: ResolveAgentInteractionInput): Promise<void>;
  reloadConfiguration(context: AgentEngineContext): Promise<void>;
  registerMcp(context: AgentEngineContext, name: string, configuration: Record<string, unknown>): Promise<void>;
  disconnectMcp(context: AgentEngineContext, name: string): Promise<void>;
  dispose(): Promise<void>;
}
