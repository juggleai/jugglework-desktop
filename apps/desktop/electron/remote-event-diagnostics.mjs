import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

const MAX_LOG_BYTES = 1024 * 1024;
const ALLOWED_METADATA_KEYS = new Set([
  "accepted",
  "attempt",
  "bindingCount",
  "code",
  "contentType",
  "eventType",
  "hasAuthorization",
  "hasCursor",
  "projectedCount",
  "reason",
  "retryDelayMs",
  "status",
]);

/** @param {unknown} value */
function safeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, candidate]) => {
    if (!ALLOWED_METADATA_KEYS.has(key) || !["boolean", "number", "string"].includes(typeof candidate)) return [];
    if (typeof candidate !== "string") return [[key, candidate]];
    if (key === "eventType" && !/^[a-z0-9._-]{1,128}$/i.test(candidate)) return [[key, "unknown"]];
    return [[key, candidate.slice(0, 128)]];
  }));
}

/**
 * Opt-in, content-free remote event diagnostics. The allowlist intentionally
 * excludes URLs, headers, tokens, and all workspace/session/control identifiers.
 * @param {{ enabled: boolean, logsDirectory: string, now?: () => Date, console?: Pick<Console, "debug" | "info" | "warn" | "error"> }} options
 */
export function createRemoteEventDiagnostics({ enabled, logsDirectory, now = () => new Date(), console: consoleTarget = console }) {
  const filePath = path.join(logsDirectory, "remote-session-events.log");
  let writes = Promise.resolve();
  let initialized = false;

  async function initialize() {
    if (initialized) return;
    initialized = true;
    await mkdir(logsDirectory, { recursive: true });
    const size = await stat(filePath).then((entry) => entry.size, () => 0);
    if (size >= MAX_LOG_BYTES) {
      await rename(filePath, `${filePath}.previous`).catch(() => undefined);
    }
  }

  /** @param {"debug" | "info" | "warn" | "error"} level @param {string} message @param {unknown} metadata */
  function write(level, message, metadata) {
    if (!enabled) return;
    const safe = safeMetadata(metadata);
    const record = { timestamp: now().toISOString(), level, message: String(message).slice(0, 160), ...safe };
    try { consoleTarget[level]?.("[desktop-remote-events]", record); } catch {}
    writes = writes.then(async () => {
      await initialize();
      await appendFile(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    }).catch(() => undefined);
  }

  return Object.freeze({
    filePath,
    debug: (message, metadata) => write("debug", message, metadata),
    info: (message, metadata) => write("info", message, metadata),
    warn: (message, metadata) => write("warn", message, metadata),
    error: (message, metadata) => write("error", message, metadata),
    flush: () => writes,
  });
}
