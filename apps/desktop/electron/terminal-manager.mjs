import { randomUUID } from "node:crypto";

export function terminalEnvironment(source) {
  // Allowlist rather than attempting to enumerate every internal/provider token.
  const env = {};
  for (const key of ["HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH"]) {
    if (typeof source[key] === "string") env[key] = source[key];
  }
  return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" };
}

export function assertTerminalSender(event, window) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("UNTRUSTED_TERMINAL_SENDER");
}

export class TerminalManager {
  constructor({ resolveTarget, spawn, shell, env, maxTerminals = 16, maxChars = 512 * 1024 }) {
    this.resolveTarget = resolveTarget;
    this.spawn = spawn;
    this.shell = shell;
    this.env = env;
    this.maxTerminals = maxTerminals;
    this.maxChars = maxChars;
    this.entries = new Map();
    this.pending = new Map();
    this.generations = new Map();
    this.lastCreate = new Map();
  }
  async open(owner, target) {
    const key = JSON.stringify([owner, target?.workspaceId, target?.sessionId]);
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.pending.size >= this.maxTerminals) throw new Error("TERMINAL_LIMIT");
    const generation = this.generations.get(owner) ?? 0;
    const promise = (async () => {
      const binding = await this.resolveTarget(target);
      if (binding.executionKind !== "local") throw new Error("REMOTE_TERMINAL_UNSUPPORTED");
      if ((this.generations.get(owner) ?? 0) !== generation) throw new Error("TARGET_CLOSED");
      const existing = [...this.entries.values()].find((e) => e.key === key);
      if (existing) return this.metadata(existing, binding.bindingRevision !== existing.binding.bindingRevision);
      if (this.entries.size >= this.maxTerminals) {
        const expired = [...this.entries.values()].find((e) => e.state === "exited");
        if (expired) this.remove(expired);
      }
      if (this.entries.size >= this.maxTerminals) throw new Error("TERMINAL_LIMIT");
      if (Date.now() - (this.lastCreate.get(owner) ?? 0) < 250) throw new Error("TERMINAL_RATE_LIMIT");
      this.lastCreate.set(owner, Date.now());
      const child = this.spawn(this.shell, [], { name: "xterm-256color", cwd: binding.initialCwd, cols: 80, rows: 24, env: terminalEnvironment(this.env) });
      const entry = { key, owner, terminalId: randomUUID(), binding, child, state: "running", exitCode: null, output: "", end: 0, disposables: [] };
      this.entries.set(entry.terminalId, entry);
      entry.disposables.push(child.onData((data) => {
        entry.end += data.length;
        entry.output = (entry.output + data).slice(-this.maxChars);
      }));
      entry.disposables.push(child.onExit(({ exitCode }) => {
        entry.state = "exited";
        entry.exitCode = exitCode;
      }));
      return this.metadata(entry);
    })();
    this.pending.set(key, promise);
    try { return await promise; } finally { this.pending.delete(key); }
  }
  metadata(e, stale = false) {
    return { terminalId: e.terminalId, binding: e.binding, state: e.state, exitCode: e.exitCode, stale };
  }
  owned(owner, id) {
    const e = this.entries.get(id);
    if (!e || e.owner !== owner) throw new Error("TERMINAL_NOT_FOUND");
    return e;
  }
  read(owner, id, cursor = 0) {
    const e = this.owned(owner, id);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > e.end) throw new Error("INVALID_CURSOR");
    const start = e.end - e.output.length;
    const from = Math.max(cursor, start);
    const data = e.output.slice(from - start, from - start + 32768);
    return { ...this.metadata(e), data, cursor: from + data.length, gap: cursor < start };
  }
  write(owner, id, data) {
    const e = this.owned(owner, id);
    if (e.state !== "running") throw new Error("TERMINAL_NOT_RUNNING");
    if (typeof data !== "string" || data.length > 16384) throw new Error("INVALID_INPUT");
    e.child.write(data);
  }
  resize(owner, id, cols, rows) {
    const e = this.owned(owner, id);
    if (![cols, rows].every((n) => Number.isInteger(n) && n >= 2 && n <= 500)) throw new Error("INVALID_SIZE");
    if (e.state === "running") e.child.resize(cols, rows);
  }
  terminate(owner, id) {
    const e = this.owned(owner, id);
    if (e.state === "running") { e.state = "terminating"; e.child.kill(); }
    return this.metadata(e);
  }
  async restart(owner, id) {
    const e = this.owned(owner, id);
    if (e.state !== "exited") throw new Error("TERMINAL_STILL_RUNNING");
    this.remove(e);
    return this.open(owner, e.binding);
  }
  remove(e) {
    this.entries.delete(e.terminalId);
    for (const d of e.disposables) d.dispose();
    if (e.state !== "exited") { try { e.child.kill(); } catch { /* process already gone */ } }
  }
  disposeOwner(owner) {
    this.generations.set(owner, (this.generations.get(owner) ?? 0) + 1);
    for (const e of this.entries.values()) if (e.owner === owner) this.remove(e);
  }
  dispose() {
    for (const e of this.entries.values()) this.disposeOwner(e.owner);
    // Invalidate in-flight creations even if no process exists yet.
    for (const key of this.pending.keys()) this.disposeOwner(JSON.parse(key)[0]);
  }
}
