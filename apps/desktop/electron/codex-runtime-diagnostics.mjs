import path from "node:path";

const STEPS = ["binary", "version", "handshake", "token", "gateway", "model", "sandbox", "workspace"];
const SECRET = /(?:bearer\s+\S+|(?:token|secret|authorization|api[_-]?key)\s*[:=]\s*(?:bearer\s+)?\S+(?:\s+\S+)?|https?:\/\/127\.0\.0\.1:\d+\/\S+)/gi;

function safeError(error) {
  const code = typeof error?.code === "string" ? error.code.slice(0, 64) : "failed";
  const message = String(error?.message ?? "Check failed").replace(SECRET, "[redacted]").replace(/(?:[A-Za-z]:\\|\/)[^\s]+/g, "[path]").slice(0, 300);
  return { code, message };
}

/** Runs bounded, body-free Codex health checks in dependency order. */
export async function runCodexDiagnostics(input) {
  const results = [];
  for (const name of STEPS) {
    const checker = input?.checks?.[name];
    if (typeof checker !== "function") {
      results.push({ name, status: "unavailable" });
      continue;
    }
    try {
      const detail = await checker();
      results.push({ name, status: "ok", ...(name === "binary" && detail?.path ? { executable: path.basename(String(detail.path)) } : {}), ...(detail?.version ? { version: String(detail.version).slice(0, 64) } : {}) });
    } catch (error) {
      results.push({ name, status: "failed", error: safeError(error) });
      if (["binary", "version", "handshake"].includes(name)) break;
    }
  }
  return Object.freeze({ ok: results.every((item) => item.status === "ok"), checks: Object.freeze(results), generatedAt: Date.now() });
}
