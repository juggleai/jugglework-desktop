import type { RuntimeProviderStatus, SessionInfo, SessionSnapshot, WorkspaceInfo } from "./api.js";
import type { CloudOrganization, CloudUser } from "./cloud-client.js";
import type { DoctorReport } from "./doctor.js";
import { CLI_VERSION } from "./version.js";

type RendererOptions = { json: boolean; color: boolean; exec?: boolean };

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  promptBackground: "\u001b[48;5;238m",
};

type WelcomeInfo = {
  workspace: WorkspaceInfo;
  model: string | null;
  sandbox: "workspace-write" | "danger-full-access";
  approval: "on-request" | "never";
  cloud: string;
  owned: boolean;
};

function safeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u200e-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const WIDE_GRAPHEME = /[\u1100-\u115f\u2329-\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u;

function displayWidth(value: string): number {
  return Array.from(graphemeSegmenter.segment(value)).reduce((width, part) => width + (WIDE_GRAPHEME.test(part.segment) ? 2 : 1), 0);
}

function fitTerminalText(value: string, width: number, keepEnd = false): string {
  if (displayWidth(value) <= width) return value;
  const segments = Array.from(graphemeSegmenter.segment(value), (part) => part.segment);
  const selected: string[] = [];
  let used = displayWidth("…");
  for (const segment of keepEnd ? segments.reverse() : segments) {
    const segmentWidth = displayWidth(segment);
    if (used + segmentWidth > width) break;
    if (keepEnd) selected.unshift(segment);
    else selected.push(segment);
    used += segmentWidth;
  }
  return keepEnd ? `…${selected.join("")}` : `${selected.join("")}…`;
}

export class CliRenderer {
  private lineOpen = false;
  private workingTimer: NodeJS.Timeout | null = null;
  private workingStartedAt = 0;
  private workingVisible = false;
  private readonly secretValues = new Set<string>();
  constructor(private readonly options: RendererOptions) {}

  registerSecretValues(values: Iterable<string | null | undefined>): void {
    for (const value of values) {
      if (value) this.secretValues.add(value);
    }
  }

  private redact<T>(value: T): T {
    return redactSecrets(value, this.secretValues) as T;
  }

  private redactText(value: string): string {
    return this.redact(value);
  }

  private style(value: string, code: string): string {
    return this.options.color ? `${code}${value}${ANSI.reset}` : value;
  }

  private clearWorkingLine(): void {
    if (!this.workingVisible) return;
    if (process.stdout.isTTY) process.stdout.write("\r\u001b[2K");
    else process.stdout.write("\n");
    this.workingVisible = false;
  }

  private drawWorkingLine(): void {
    if (!this.workingTimer || this.lineOpen) return;
    const seconds = Math.floor((Date.now() - this.workingStartedAt) / 1000);
    const message = `● Working (${seconds}s · esc to interrupt)`;
    const fitted = fitTerminalText(message, Math.max(4, (process.stdout.columns || 80) - 1));
    if (this.workingVisible && process.stdout.isTTY) process.stdout.write("\r\u001b[2K");
    process.stdout.write(this.style(fitted, ANSI.dim));
    this.workingVisible = true;
  }

  submittedPrompt(prompt: string): void {
    if (this.options.json || this.options.exec) return;
    this.ensureLine();
    const width = Math.max(4, process.stdout.columns || 80);
    const text = fitTerminalText(`› ${safeTerminalText(this.redactText(prompt))}`, width);
    const row = `${text}${" ".repeat(Math.max(0, width - displayWidth(text)))}`;
    process.stdout.write(`${this.style(row, ANSI.promptBackground)}\n`);
  }

  taskContext(model: string | null, workspace: WorkspaceInfo): void {
    if (this.options.json || this.options.exec) return;
    const location = workspace.path || workspace.directory || workspace.displayName || workspace.name || workspace.id;
    const label = `${model ?? "runtime default"} · ${safeTerminalText(this.redactText(location))}`;
    const width = Math.max(4, (process.stdout.columns || 80) - 1);
    process.stdout.write(`${this.style(fitTerminalText(label, width, true), ANSI.dim)}\n`);
  }

  startWorking(): void {
    if (this.options.json || this.options.exec || this.workingTimer) return;
    this.workingStartedAt = Date.now();
    this.workingTimer = setInterval(() => this.drawWorkingLine(), 1_000);
    this.workingTimer.unref();
    this.drawWorkingLine();
  }

  stopWorking(): void {
    if (!this.workingTimer) return;
    clearInterval(this.workingTimer);
    this.workingTimer = null;
    this.clearWorkingLine();
    if (!this.lineOpen) process.stdout.write("\n");
  }

  event(type: string, data: Record<string, unknown> = {}): void {
    if (this.options.json) process.stdout.write(`${JSON.stringify(this.redact({ type, ...data }))}\n`);
  }

  info(message: string): void {
    if (this.options.json) return this.event("status", { message });
    this.ensureLine();
    this.clearWorkingLine();
    const stream = this.options.exec ? process.stderr : process.stdout;
    stream.write(`${this.style(this.redactText(message), ANSI.dim)}\n`);
    this.drawWorkingLine();
  }

  warn(message: string): void {
    if (this.options.json) return this.event("warning", { message });
    this.ensureLine();
    this.clearWorkingLine();
    process.stderr.write(`${this.style(this.redactText(message), ANSI.yellow)}\n`);
    this.drawWorkingLine();
  }

  error(message: string): void {
    if (this.options.json) return this.event("error", { message });
    this.ensureLine();
    this.clearWorkingLine();
    process.stderr.write(`${this.style(`Error: ${this.redactText(message)}`, ANSI.red)}\n`);
    this.drawWorkingLine();
  }

  banner(workspace: WorkspaceInfo, serverUrl: string, owned: boolean): void {
    if (this.options.json) return this.event("ready", { workspaceId: workspace.id, workspace: workspace.path, serverUrl, owned });
    const label = this.redactText(workspace.displayName || workspace.name || workspace.path || workspace.id);
    const stream = this.options.exec ? process.stderr : process.stdout;
    stream.write(`${this.style("JuggleWork", ANSI.bold)} ${this.style(`· ${label}`, ANSI.dim)}\n`);
    stream.write(`${this.style(owned ? "local runtime" : this.redactText(serverUrl), ANSI.dim)}\n`);
  }

  welcome(info: WelcomeInfo): void {
    if (this.options.json) return;
    const directory = info.workspace.path || info.workspace.directory || info.workspace.displayName || info.workspace.name || info.workspace.id;
    const rows: Array<{ label: string; value: string; keepEnd?: boolean }> = [
      { label: "", value: `>_ JuggleWork (v${CLI_VERSION})` },
      { label: "", value: "" },
      { label: "model:       ", value: info.model ?? "runtime default · /model for details" },
      { label: "directory:   ", value: directory, keepEnd: true },
      { label: "permissions: ", value: `${info.sandbox} · ${info.approval} (requested)` },
      { label: "cloud:       ", value: info.cloud },
      { label: "runtime:     ", value: info.owned ? "local embedded Server" : "connected Server" },
    ];
    const contentWidth = Math.max(4, Math.min(70, (process.stdout.columns || 80) - 4));
    const border = `╭${"─".repeat(contentWidth + 2)}╮`;
    process.stdout.write(`\n${this.style(border, ANSI.dim)}\n`);
    rows.forEach((row, index) => {
      const label = fitTerminalText(row.label, contentWidth);
      const remaining = contentWidth - displayWidth(label);
      const value = safeTerminalText(this.redactText(row.value));
      const fitted = `${label}${remaining > 0 ? fitTerminalText(value, remaining, row.keepEnd) : ""}`;
      const padded = `${fitted}${" ".repeat(contentWidth - displayWidth(fitted))}`;
      process.stdout.write(`${this.style("│ ", ANSI.dim)}${this.style(padded, index === 0 ? ANSI.bold : ANSI.dim)}${this.style(" │", ANSI.dim)}\n`);
    });
    process.stdout.write(`${this.style(`╰${"─".repeat(contentWidth + 2)}╯`, ANSI.dim)}\n\n`);
  }

  session(session: SessionInfo): void {
    if (this.options.json) return this.event("session", { session });
    const stream = this.options.exec ? process.stderr : process.stdout;
    stream.write(`${this.style("session", ANSI.dim)} ${this.redactText(session.id)} ${this.redactText(session.title ?? "")}\n`);
  }

  sessions(items: SessionInfo[]): void {
    if (this.options.json) return this.event("sessions", { items });
    if (!items.length) {
      this.info("No sessions found.");
      return;
    }
    for (const item of items) {
      const updated = item.time?.updated ? new Date(item.time.updated).toLocaleString() : "";
      const archived = item.time?.archived ? "  archived" : "";
      const status = item.status?.type ? `  ${item.status.type}` : "";
      process.stdout.write(`${this.style(this.redactText(item.id), ANSI.cyan)}  ${this.redactText(item.title ?? "Untitled")}${this.style(`${status}${archived}${updated ? `  ${updated}` : ""}`, ANSI.dim)}\n`);
    }
  }

  sessionSnapshot(snapshot: SessionSnapshot): void {
    if (this.options.json) return this.event("session_snapshot", { snapshot });
    this.session(snapshot.session);
    this.info(`Status: ${snapshot.status.type}; messages: ${snapshot.messages.length}; todos: ${snapshot.todos.length}`);
    for (const message of snapshot.messages) {
      const text = message.parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
      process.stdout.write(`${this.style(message.info.role, ANSI.cyan)}${text ? `  ${this.redactText(text)}` : ""}\n`);
    }
  }

  sessionMutation(action: "forked" | "renamed" | "archived" | "unarchived" | "deleted", session: SessionInfo, data: Record<string, unknown> = {}): void {
    if (this.options.json) return this.event("session_mutation", { action, session, ...data });
    this.info(`Session ${session.id} ${action}${session.title ? `: ${session.title}` : ""}.`);
  }

  sessionQueued(session: SessionInfo, result: { disposition: "enqueued"; admissionId: string }): void {
    if (this.options.json) return this.event("session_queue", { session, result });
    this.info(`Prompt queued for ${session.id} (admission ${result.admissionId}).`);
  }

  account(status: "signed_in" | "signed_out", user: CloudUser | null, deployment: string): void {
    if (this.options.json) return this.event("account", { status, user, deployment });
    this.info(status === "signed_in"
      ? `Signed in to ${deployment}${user?.email ? ` as ${user.email}` : user?.name ? ` as ${user.name}` : ""}.`
      : `Not signed in to ${deployment}.`);
  }

  organizations(items: CloudOrganization[], selectedId: string | null): void {
    if (this.options.json) return this.event("organizations", { label: "Account organizations", items, selectedId });
    process.stdout.write(`${this.style("Account organizations", ANSI.bold)}\n`);
    if (!items.length) return this.info("No organizations found.");
    for (const item of items) {
      const selected = item.id === selectedId || item.slug === selectedId ? "*" : " ";
      process.stdout.write(`${selected} ${this.style(item.slug, ANSI.cyan)}  ${this.redactText(item.name)}  ${this.style(item.id, ANSI.dim)}\n`);
    }
  }

  organizationSelected(organization: CloudOrganization, ephemeral: boolean): void {
    if (this.options.json) return this.event("organization_selected", { organization, persisted: !ephemeral });
    this.info(`Using organization ${organization.name} (${organization.slug})${ephemeral ? " for this environment-token session" : ""}.`);
  }

  inventory(label: string, kind: string, items: Array<Record<string, unknown>>, organization?: CloudOrganization): void {
    if (this.options.json) return this.event("inventory", { label, kind, organization, items });
    process.stdout.write(`${this.style(label, ANSI.bold)}${organization ? this.style(` · ${organization.name}`, ANSI.dim) : ""}\n`);
    if (!items.length) return this.info(`No ${kind} found.`);
    for (const item of items) {
      const id = typeof item.id === "string" ? item.id : "";
      const name = typeof item.name === "string" ? item.name : id;
      const provider = typeof item.providerId === "string" ? `  ${item.providerId}` : typeof item.provider === "string" ? `  ${item.provider}` : "";
      process.stdout.write(`${this.style(this.redactText(id), ANSI.cyan)}  ${this.redactText(name)}${this.style(provider, ANSI.dim)}\n`);
    }
  }

  providerMutation(action: "imported" | "removed", cloudProviderId: string, status: RuntimeProviderStatus | null): void {
    if (this.options.json) return this.event("provider_mutation", { action, cloudProviderId, status });
    this.info(`Provider ${cloudProviderId} ${action}${status?.loaded ? " and is visible to the runtime" : ""}.`);
  }

  doctor(report: DoctorReport): void {
    if (this.options.json) return this.event("doctor", { report });
    process.stdout.write(`${this.style("JuggleWork doctor", ANSI.bold)}\n`);
    for (const check of report.checks) {
      const marker = check.status === "pass" ? "PASS" : check.status === "warning" ? "WARN" : "FAIL";
      const color = check.status === "pass" ? ANSI.cyan : check.status === "warning" ? ANSI.yellow : ANSI.red;
      process.stdout.write(`${this.style(marker.padEnd(4), color)}  ${check.id.padEnd(20)} ${this.redactText(check.message)}\n`);
    }
    process.stdout.write(`\n${report.summary.pass} passed, ${report.summary.warning} warnings, ${report.summary.failure} failed\n`);
  }

  assistantStart(): void {
    if (this.options.json || this.options.exec) return;
    this.ensureLine();
    this.clearWorkingLine();
    process.stdout.write(`${this.style("assistant › ", ANSI.cyan)}`);
    this.lineOpen = true;
  }

  delta(text: string, messageId?: string, partId?: string): void {
    if (!text) return;
    if (this.options.json) return this.event("delta", { text, messageId, partId });
    if (this.options.exec) return;
    const safeText = this.redactText(text);
    process.stdout.write(safeText);
    this.lineOpen = !safeText.endsWith("\n");
    if (!this.lineOpen) this.drawWorkingLine();
  }

  final(text: string, sessionId: string): void {
    if (this.options.json) return this.event("final", { text, sessionId });
    if (this.options.exec) {
      const safeText = this.redactText(text);
      process.stdout.write(safeText.endsWith("\n") ? safeText : `${safeText}\n`);
      return;
    }
    this.ensureLine();
  }

  ensureLine(): void {
    this.clearWorkingLine();
    if (!this.options.json && this.lineOpen) {
      process.stdout.write("\n");
      this.lineOpen = false;
    }
  }

  promptLabel(): string {
    return this.style("› ", ANSI.bold);
  }
}

const SECRET_KEY = /^(?:authorization|cookie|set-cookie|password|username|token|host[_-]?token|access[_-]?token|refresh[_-]?token|api[_-]?key)$/i;

export function redactSecrets(value: unknown, registeredSecrets: Iterable<string> = []): unknown {
  const secrets = [...registeredSecrets].filter(Boolean).sort((left, right) => right.length - left.length);
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") {
      return secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), item);
    }
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return item;
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(item as Record<string, unknown>)) {
      result[key] = SECRET_KEY.test(key) ? "[REDACTED]" : visit(nested);
    }
    return result;
  };
  return visit(value);
}
