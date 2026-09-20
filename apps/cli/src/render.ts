import type { SessionInfo, WorkspaceInfo } from "./api.js";

type RendererOptions = { json: boolean; color: boolean };

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
};

export class CliRenderer {
  private lineOpen = false;
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

  event(type: string, data: Record<string, unknown> = {}): void {
    if (this.options.json) process.stdout.write(`${JSON.stringify(this.redact({ type, ...data }))}\n`);
  }

  info(message: string): void {
    if (this.options.json) return this.event("status", { message });
    this.ensureLine();
    process.stdout.write(`${this.style(this.redactText(message), ANSI.dim)}\n`);
  }

  warn(message: string): void {
    if (this.options.json) return this.event("warning", { message });
    this.ensureLine();
    process.stderr.write(`${this.style(this.redactText(message), ANSI.yellow)}\n`);
  }

  error(message: string): void {
    if (this.options.json) return this.event("error", { message });
    this.ensureLine();
    process.stderr.write(`${this.style(`Error: ${this.redactText(message)}`, ANSI.red)}\n`);
  }

  banner(workspace: WorkspaceInfo, serverUrl: string, owned: boolean): void {
    if (this.options.json) return this.event("ready", { workspaceId: workspace.id, workspace: workspace.path, serverUrl, owned });
    const label = this.redactText(workspace.displayName || workspace.name || workspace.path || workspace.id);
    process.stdout.write(`${this.style("JuggleWork", ANSI.bold)} ${this.style(`· ${label}`, ANSI.dim)}\n`);
    process.stdout.write(`${this.style(owned ? "local runtime" : this.redactText(serverUrl), ANSI.dim)}\n`);
  }

  session(session: SessionInfo): void {
    if (this.options.json) return this.event("session", { session });
    process.stdout.write(`${this.style("session", ANSI.dim)} ${this.redactText(session.id)} ${this.redactText(session.title ?? "")}\n`);
  }

  sessions(items: SessionInfo[]): void {
    if (this.options.json) return this.event("sessions", { items });
    if (!items.length) {
      this.info("No sessions found.");
      return;
    }
    for (const item of items) {
      const updated = item.time?.updated ? new Date(item.time.updated).toLocaleString() : "";
      process.stdout.write(`${this.style(this.redactText(item.id), ANSI.cyan)}  ${this.redactText(item.title ?? "Untitled")}${updated ? this.style(`  ${updated}`, ANSI.dim) : ""}\n`);
    }
  }

  assistantStart(): void {
    if (this.options.json) return;
    this.ensureLine();
    process.stdout.write(`${this.style("assistant › ", ANSI.cyan)}`);
    this.lineOpen = true;
  }

  delta(text: string, messageId?: string, partId?: string): void {
    if (!text) return;
    if (this.options.json) return this.event("delta", { text, messageId, partId });
    const safeText = this.redactText(text);
    process.stdout.write(safeText);
    this.lineOpen = !safeText.endsWith("\n");
  }

  final(text: string, sessionId: string): void {
    if (this.options.json) this.event("final", { text, sessionId });
    this.ensureLine();
  }

  ensureLine(): void {
    if (!this.options.json && this.lineOpen) {
      process.stdout.write("\n");
      this.lineOpen = false;
    }
  }

  promptLabel(): string {
    return this.style("you › ", ANSI.bold);
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
