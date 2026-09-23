import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { CliOptions } from "./args.js";
import {
  JuggleWorkApiClient,
  JuggleWorkApiError,
  type OwnedInteraction,
  type SessionInfo,
  type SessionMessage,
  type SessionRun,
  type WorkspaceInfo,
} from "./api.js";
import { CliRenderer } from "./render.js";

export type Ask = (question: string) => Promise<string>;

export type PromptResult = {
  text: string;
  sessionId: string;
  aborted: boolean;
};

export type PromptInput = {
  context?: string | null;
  outputSchema?: Record<string, unknown> | null;
};

export const STDIN_CONTEXT_START = "--- BEGIN PIPED STDIN CONTEXT ---";
export const STDIN_CONTEXT_END = "--- END PIPED STDIN CONTEXT ---";

const delay = (ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));

function modelSelection(model: string | null): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error("--model must use provider/model format");
  }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

function textPartKey(messageId: string, partId: string): string {
  return `${messageId}:${partId}`;
}

function assistantTextParts(messages: SessionMessage[]): Array<{ messageId: string; partId: string; text: string }> {
  return messages.flatMap((message) => message.info.role !== "assistant" ? [] : message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => ({ messageId: message.info.id, partId: part.id, text: part.text! })));
}

function messageFailure(messages: SessionMessage[]): string | null {
  for (const message of messages) {
    const error = message.info.error;
    if (!error) continue;
    if (typeof error === "string") return error;
    if (typeof error === "object" && error && "message" in error && typeof error.message === "string") return error.message;
    return JSON.stringify(error);
  }
  return null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function permissionDetails(interaction: OwnedInteraction): { action: string; resources: string[]; save: string[] } {
  const v2 = interaction.v2;
  const action = interaction.action || v2?.action || interaction.permission || "requested action";
  const resources = stringList(interaction.resources).length
    ? stringList(interaction.resources)
    : stringList(v2?.resources).length
      ? stringList(v2?.resources)
      : stringList(interaction.patterns);
  const save = stringList(interaction.save).length
    ? stringList(interaction.save)
    : stringList(v2?.save).length
      ? stringList(v2?.save)
      : stringList(interaction.always);
  return { action, resources, save };
}

function permissionSummary(interaction: OwnedInteraction): string {
  const { action, resources, save } = permissionDetails(interaction);
  const requested = resources.slice(0, 6);
  const reusable = save.slice(0, 6);
  const requestSummary = requested.length ? `${action}: ${requested.join(", ")}` : action;
  return reusable.length ? `${requestSummary} (session scope: ${reusable.join(", ")})` : requestSummary;
}

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); } catch { return resolve(path); }
}

export async function chooseWorkspace(
  api: JuggleWorkApiClient,
  options: CliOptions,
  ask: Ask | null,
): Promise<WorkspaceInfo> {
  const { items, activeId } = await api.listWorkspaces();
  if (!items.length) throw new Error("The JuggleWork Server has no configured workspaces.");
  if (options.workspaceId) {
    const selected = items.find((item) => item.id === options.workspaceId);
    if (!selected) throw new Error(`Workspace ${options.workspaceId} was not found on the JuggleWork Server.`);
    return selected;
  }
  const requested = await canonicalPath(options.workspace);
  for (const item of items) {
    const candidate = item.path || item.directory;
    if (candidate && await canonicalPath(candidate) === requested) return item;
  }
  if (items.length === 1) return items[0]!;
  if (!ask) {
    throw new Error("Multiple workspaces are available. Pass --workspace-id to select one.");
  }
  const choices = items.map((item, index) =>
    `${index + 1}. ${item.displayName || item.name || item.path || item.id} (${item.id})`).join("\n");
  const answer = (await ask(`Available workspaces:\n${choices}\nWorkspace [${Math.max(1, items.findIndex((item) => item.id === activeId) + 1)}]: `)).trim();
  const fallback = Math.max(0, items.findIndex((item) => item.id === activeId));
  const index = answer ? Number(answer) - 1 : fallback;
  if (!Number.isInteger(index) || index < 0 || index >= items.length) throw new Error("Invalid workspace selection.");
  return items[index]!;
}

export class SessionController {
  private currentSessionValue: SessionInfo | null = null;
  private currentRunValue: SessionRun | null = null;
  private abortRequested = false;
  private lastAssistantText = "";

  constructor(
    readonly api: JuggleWorkApiClient,
    readonly workspace: WorkspaceInfo,
    readonly options: CliOptions,
    readonly renderer: CliRenderer,
    readonly ask: Ask | null,
  ) {}

  get currentSession(): SessionInfo | null { return this.currentSessionValue; }
  get currentRun(): SessionRun | null { return this.currentRunValue; }
  get lastResponse(): string { return this.lastAssistantText; }

  async listSessions(): Promise<SessionInfo[]> {
    const { items } = await this.api.listSessions(this.workspace.id, 50);
    return [...items].sort((left, right) => (right.time?.updated ?? 0) - (left.time?.updated ?? 0));
  }

  async createSession(title = "JuggleWork CLI"): Promise<SessionInfo> {
    const { item } = await this.api.createSession(this.workspace.id, title);
    this.currentSessionValue = item;
    if (this.options.fullAccess) {
      const mode = await this.api.getPermissionMode(this.workspace.id, item.id);
      if (!mode.supported) throw new Error("This JuggleWork Server does not support Full access mode.");
      await this.api.setFullAccess(
        this.workspace.id,
        item.id,
        mode.state?.authorityRevision ?? 0,
        mode.profileVersion,
      );
      this.renderer.info("Full access enabled for this session.");
    }
    this.renderer.session(item);
    return item;
  }

  async useSession(session: SessionInfo): Promise<void> {
    this.currentSessionValue = session;
    this.renderer.session(session);
  }

  async selectSession(id: string | null, latest = false): Promise<SessionInfo> {
    const sessions = await this.listSessions();
    if (!sessions.length) throw new Error("No sessions are available to resume.");
    if (id) {
      const exact = sessions.find((item) => item.id === id);
      const prefix = sessions.filter((item) => item.id.startsWith(id));
      const selected = exact ?? (prefix.length === 1 ? prefix[0] : null);
      if (!selected) throw new Error(prefix.length > 1 ? `Session prefix ${id} is ambiguous.` : `Session ${id} was not found.`);
      await this.useSession(selected);
      return selected;
    }
    if (latest || !this.ask) {
      await this.useSession(sessions[0]!);
      return sessions[0]!;
    }
    this.renderer.sessions(sessions.slice(0, 20));
    const answer = (await this.ask("Session ID (blank for latest): ")).trim();
    return this.selectSession(answer || sessions[0]!.id, true);
  }

  async resolveSession(target: string | null, allowPicker = false): Promise<SessionInfo> {
    const sessions = await this.listSessions();
    if (!sessions.length) throw new Error("No sessions are available.");
    if (!target) {
      if (!allowPicker) throw new Error("A session ID is required.");
      return this.selectSession(null, false);
    }
    const exact = sessions.find((item) => item.id === target);
    if (exact) return exact;
    const prefix = sessions.filter((item) => item.id.startsWith(target));
    if (prefix.length > 1) throw new Error(`Session prefix ${target} is ambiguous.`);
    if (prefix.length === 1) return prefix[0]!;
    throw new Error(`Session ${target} was not found.`);
  }

  async showSession(target: string): Promise<void> {
    const session = await this.resolveSession(target);
    const { item } = await this.api.getSnapshot(this.workspace.id, session.id);
    this.renderer.sessionSnapshot(item);
  }

  async forkSession(target: string | null): Promise<SessionInfo> {
    const source = await this.resolveSession(target, true);
    const { item } = await this.api.forkSession(this.workspace.id, source.id);
    this.renderer.sessionMutation("forked", item, { sourceSessionId: source.id });
    return item;
  }

  async queueSession(target: string, prompt: string): Promise<void> {
    const session = await this.resolveSession(target);
    const result = await this.api.queuePrompt(this.workspace.id, session.id, prompt);
    this.renderer.sessionQueued(session, result);
  }

  async renameSession(target: string, title: string): Promise<void> {
    const session = await this.resolveSession(target);
    const { item } = await this.api.updateSession(this.workspace.id, session.id, { title });
    this.renderer.sessionMutation("renamed", item);
  }

  async archiveSession(target: string, archived: boolean): Promise<void> {
    const session = await this.resolveSession(target);
    const { item } = await this.api.updateSession(this.workspace.id, session.id, { archived });
    this.renderer.sessionMutation(archived ? "archived" : "unarchived", item);
  }

  async deleteSession(target: string, force: boolean): Promise<void> {
    const session = await this.resolveSession(target);
    if (force && target !== session.id) {
      throw new Error("--force requires the complete, exact session ID; prefixes are not accepted.");
    }
    if (!force) {
      if (!this.ask) throw new Error("Session deletion requires interactive confirmation, or --force with the complete, exact session ID.");
      const answer = (await this.ask(`Permanently delete ${session.id} (${session.title ?? "Untitled"})? Type the exact session ID to confirm: `)).trim();
      if (answer !== session.id) throw new Error("Session deletion was not confirmed.");
    }
    await this.api.deleteSession(this.workspace.id, session.id);
    this.renderer.sessionMutation("deleted", session);
  }

  async status(): Promise<Record<string, unknown>> {
    const server = await this.api.status();
    const active = await this.api.listActiveRuns(this.workspace.id);
    const result = {
      workspace: this.workspace,
      session: this.currentSessionValue,
      activeRuns: active.items,
      server,
    };
    if (this.options.json) this.renderer.event("status", result);
    else {
      this.renderer.info(`Workspace: ${this.workspace.displayName || this.workspace.name || this.workspace.path || this.workspace.id}`);
      this.renderer.info(`Session: ${this.currentSessionValue?.id ?? "none"}`);
      this.renderer.info(`Active runs: ${active.items.length}`);
    }
    return result;
  }

  async plan(): Promise<void> {
    if (!this.currentSessionValue) throw new Error("No session is selected. Use /new or /resume first.");
    const snapshot = await this.api.getSnapshot(this.workspace.id, this.currentSessionValue.id);
    if (this.options.json) this.renderer.event("plan", { items: snapshot.item.todos });
    else if (!snapshot.item.todos.length) this.renderer.info("Plan: no task items reported by the runtime.");
    else snapshot.item.todos.forEach((item) => this.renderer.info(`[${item.status}] ${item.content} (${item.priority})`));
  }

  async permissions(requested?: "request-approval" | "full-access"): Promise<void> {
    if (!this.currentSessionValue) throw new Error("No session is selected. Use /new or /resume first.");
    const mode = await this.api.getPermissionMode(this.workspace.id, this.currentSessionValue.id);
    if (!mode.supported) throw new Error("This JuggleWork Server does not support session permission modes.");
    if (requested) {
      const revision = mode.state?.authorityRevision ?? 0;
      if (requested === "full-access") {
        if (!this.ask) throw new Error("Full access requires an interactive acknowledgement or the expert-only CLI bypass flag.");
        const answer = (await this.ask("Full access may auto-approve file, shell, network, connector, and descendant-agent actions. Type 'enable full access' to continue: ")).trim().toLowerCase();
        if (answer !== "enable full access") throw new Error("Full access was not enabled.");
        await this.api.setFullAccess(this.workspace.id, this.currentSessionValue.id, revision, mode.profileVersion);
      } else {
        await this.api.setRequestApproval(this.workspace.id, this.currentSessionValue.id, revision);
      }
    }
    const current = requested ? await this.api.getPermissionMode(this.workspace.id, this.currentSessionValue.id) : mode;
    this.renderer.info(`Approval: ${current.state?.effectiveMode ?? "request-approval"} (Server authoritative)`);
    const effectiveSandbox = current.state?.effectiveMode === "full-access" ? "danger-full-access" : this.options.sandbox;
    this.renderer.info(`Sandbox: ${effectiveSandbox} (mapped to the Server permission mode; independent process sandbox controls are not exposed by this Server API)`);
  }

  async compact(): Promise<void> {
    if (!this.currentSessionValue) throw new Error("No session is selected. Use /new or /resume first.");
    const model = modelSelection(this.options.model);
    if (!model) throw new Error("/compact requires --model provider/model because the Server summarize API requires an explicit model.");
    await this.api.compactSession(this.workspace.id, this.currentSessionValue.id, model);
    this.renderer.info("Compaction was accepted by the runtime.");
  }

  async abortCurrentRun(): Promise<boolean> {
    let run = this.currentRunValue;
    if (!run && this.currentSessionValue) {
      const active = await this.api.listActiveRuns(this.workspace.id);
      run = active.items.find((item) => item.sessionId === this.currentSessionValue?.id) ?? null;
    }
    if (!run) return false;
    try {
      const result = await this.api.abortRun(this.workspace.id, run.sessionId, run.runId, randomUUID());
      if (result.abortRequested !== true && result.accepted !== true) return false;
    } catch (error) {
      if (error instanceof JuggleWorkApiError && (error.code === "run_mismatch" || error.status === 404)) return false;
      throw error;
    }
    this.abortRequested = true;
    this.renderer.warn("Stop requested. Waiting for the task to finish stopping…");
    return true;
  }

  private async handlePermission(interaction: OwnedInteraction): Promise<void> {
    if (!this.ask || this.options.approval === "never") {
      throw new Error(`Permission required (${permissionSummary(interaction)}). The configured approval policy is fail-closed; re-run interactively with --approval on-request or use --dangerously-bypass-approvals-and-sandbox subject to Server policy.`);
    }
    this.renderer.ensureLine();
    this.renderer.info(`Permission requested: ${permissionSummary(interaction)}`);
    const supportsGrant = permissionDetails(interaction).save.length > 0;
    const answer = (await this.ask(supportsGrant
      ? "Allow [o]nce, for this [s]ession, or [r]eject? "
      : "Allow [o]nce or [r]eject? ")).trim().toLowerCase();
    if (supportsGrant && (answer === "s" || answer === "session" || answer === "always")) {
      await this.api.grantPermission(this.workspace.id, interaction);
      return;
    }
    await this.api.replyPermission(
      this.workspace.id,
      interaction,
      answer === "o" || answer === "once" || answer === "y" || answer === "yes" ? "allow_once" : "reject",
    );
  }

  private async handleQuestion(interaction: OwnedInteraction): Promise<void> {
    if (!this.ask) throw new Error("The task asked a question. Re-run in an interactive terminal to answer it.");
    const answers: Array<{ questionId: string; values: string[] }> = [];
    for (const [questionIndex, question] of (interaction.questions ?? []).entries()) {
      this.renderer.ensureLine();
      this.renderer.info(question.question);
      question.options.forEach((option, index) => this.renderer.info(`  ${index + 1}. ${option.label}`));
      const suffix = question.multiple ? " (comma-separated)" : "";
      const raw = (await this.ask(`Answer${suffix}: `)).trim();
      const values = raw.split(",").map((value) => value.trim()).filter(Boolean).map((value) => {
        const index = Number(value) - 1;
        return Number.isInteger(index) && index >= 0 && index < question.options.length
          ? question.options[index]!.label
          : value;
      });
      if (!values.length) throw new Error("A question answer cannot be empty.");
      answers.push({ questionId: question.id || String(questionIndex), values: question.multiple ? values : values.slice(0, 1) });
    }
    await this.api.replyQuestion(this.workspace.id, interaction, answers);
  }

  private async resolveInteractions(seen: Set<string>): Promise<void> {
    if (!this.currentSessionValue) return;
    const { item } = await this.api.getInteractions(this.workspace.id, this.currentSessionValue.id);
    for (const interaction of item.permissions) {
      const key = `permission:${interaction.targetSessionId}:${interaction.id}`;
      if (seen.has(key)) continue;
      await this.handlePermission(interaction);
      seen.add(key);
    }
    for (const interaction of item.questions) {
      const key = `question:${interaction.targetSessionId}:${interaction.id}`;
      if (seen.has(key)) continue;
      await this.handleQuestion(interaction);
      seen.add(key);
    }
  }

  async runPrompt(prompt: string, input: PromptInput = {}): Promise<PromptResult> {
    const text = prompt.trim();
    if (!text) throw new Error("Prompt cannot be empty.");
    const session = this.currentSessionValue ?? await this.createSession(this.options.title || text.slice(0, 80));
    const before = await this.api.getSnapshot(this.workspace.id, session.id);
    const baselineMessages = new Set(before.item.messages.map((message) => message.info.id));
    const baselineErrors = new Map(before.item.messages.map((message) => [message.info.id, JSON.stringify(message.info.error ?? null)]));
    const baselineParts = new Map(assistantTextParts(before.item.messages)
      .map((part) => [textPartKey(part.messageId, part.partId), part.text]));
    const context = input.context?.trim();
    const promptBody: Record<string, unknown> = {
      parts: [
        { type: "text", text },
        ...(context ? [{ type: "text", text: `\n${STDIN_CONTEXT_START}\n${context}\n${STDIN_CONTEXT_END}` }] : []),
      ],
    };
    const model = modelSelection(this.options.model);
    if (model) promptBody.model = model;
    if (this.options.agent) promptBody.agent = this.options.agent;
    if (this.options.reasoningEffort) promptBody.reasoning_effort = this.options.reasoningEffort;
    if (input.outputSchema) promptBody.format = { type: "json_schema", schema: input.outputSchema };
    this.abortRequested = false;
    const deadline = Date.now() + this.options.timeoutMs;
    const started = await this.api.startRun(this.workspace.id, session.id, {
      origin: "local-renderer",
      startCommandCorrelationId: randomUUID(),
      prompt: promptBody,
      whenBusy: "steer",
    }, Math.max(1, deadline - Date.now()));
    if (started.disposition === "started") {
      this.currentRunValue = started.run;
    } else {
      const active = await this.api.listActiveRuns(this.workspace.id);
      this.currentRunValue = active.items.find((item) => item.sessionId === session.id) ?? null;
      this.renderer.info("Prompt steered into the active task.");
    }
    this.renderer.event("run_started", { sessionId: session.id, runId: this.currentRunValue?.runId ?? null });

    const printed = new Map(baselineParts);
    const seenInteractions = new Set<string>();
    let assistantStarted = false;
    let lastRetryAttempt = -1;
    let waitingReported = false;
    let finalText = "";
    try {
      while (Date.now() < deadline) {
        await this.resolveInteractions(seenInteractions);
        const snapshot = await this.api.getSnapshot(this.workspace.id, session.id);
        const messages = snapshot.item.messages.filter((message) => message.info.role === "assistant" && (
          !baselineMessages.has(message.info.id)
          || JSON.stringify(message.info.error ?? null) !== baselineErrors.get(message.info.id)
          || message.parts.some((part) => part.type === "text" && typeof part.text === "string"
            && part.text !== baselineParts.get(textPartKey(message.info.id, part.id)))
        ));
        const failure = messageFailure(messages);
        if (failure) throw new Error(failure);

        const textParts = assistantTextParts(snapshot.item.messages).filter((part) => {
          const baseline = baselineParts.get(textPartKey(part.messageId, part.partId));
          return baseline === undefined || part.text !== baseline;
        });
        finalText = textParts.map((part) => {
          const baseline = baselineParts.get(textPartKey(part.messageId, part.partId)) ?? "";
          return part.text.startsWith(baseline) ? part.text.slice(baseline.length) : part.text;
        }).join("\n");
        for (const part of textParts) {
          const key = textPartKey(part.messageId, part.partId);
          const previous = printed.get(key) ?? "";
          if (part.text === previous) continue;
          if (!assistantStarted) { this.renderer.assistantStart(); assistantStarted = true; }
          const delta = part.text.startsWith(previous) ? part.text.slice(previous.length) : `\n${part.text}`;
          this.renderer.delta(delta, part.messageId, part.partId);
          printed.set(key, part.text);
        }

        const isIdle = snapshot.item.status.type === "idle";
        const isRetry = snapshot.item.status.type === "retry" || snapshot.item.status.type === "retrying";
        if (isRetry) {
          const attempt = snapshot.item.status.attempt ?? 0;
          if (attempt !== lastRetryAttempt) {
            lastRetryAttempt = attempt;
            this.renderer.warn(`Provider retry ${attempt}${snapshot.item.status.message ? `: ${snapshot.item.status.message}` : ""}`);
          }
        }
        if (snapshot.item.status.type === "waiting") {
          if (!waitingReported) this.renderer.info("Waiting for input.");
          waitingReported = true;
        } else {
          waitingReported = false;
        }

        let terminal = false;
        if (this.currentRunValue) {
          try {
            const observation = await this.api.observeRun(
              this.workspace.id,
              session.id,
              this.currentRunValue.runId,
              isIdle ? "idle" : snapshot.item.status.type === "waiting" ? "waiting" : isRetry ? "retrying" : "running",
            );
            terminal = observation.cleared === true;
          } catch (error) {
            if (!(error instanceof JuggleWorkApiError && (error.code === "run_mismatch" || error.status === 404))) throw error;
            this.currentRunValue = null;
          }
        }
        if (isIdle && !terminal) {
          const active = await this.api.listActiveRuns(this.workspace.id);
          const activeRun = active.items.find((item) => item.sessionId === session.id);
          if (activeRun) this.currentRunValue = activeRun;
          else terminal = true;
        } else if (!isIdle && !this.currentRunValue) {
          const active = await this.api.listActiveRuns(this.workspace.id);
          this.currentRunValue = active.items.find((item) => item.sessionId === session.id) ?? null;
        }
        if (isIdle && terminal) {
          this.lastAssistantText = finalText;
          this.renderer.final(finalText, session.id);
          return { text: finalText, sessionId: session.id, aborted: this.abortRequested };
        }
        await delay(250);
      }
      await this.abortCurrentRun().catch(() => {});
      throw new Error(`Task timed out after ${Math.round(this.options.timeoutMs / 1000)} seconds.`);
    } catch (error) {
      if (this.currentRunValue && !this.abortRequested) {
        await this.abortCurrentRun().catch(() => {});
      }
      throw error;
    } finally {
      this.currentRunValue = null;
    }
  }
}
