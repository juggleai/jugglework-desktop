import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const REDACTED = "[REDACTED]";

export function redactCommandOutput(value) {
  let text = String(value ?? "");
  text = text.replace(/\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Api-Key)\s*:\s*[^\r\n]+/gi, (match) => `${match.split(":", 1)[0]}: ${REDACTED}`);
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`);
  text = text.replace(/((?:access[_-]?key|secret[_-]?key|api[_-]?key|api[_-]?secret|client[_-]?secret|session[_-]?token|access[_-]?token|refresh[_-]?token|password|cookie|credential)s?\s*[=:]\s*)[^\s,;&]+/gi, `$1${REDACTED}`);
  text = text.replace(/([?&](?:token|access_key|secret_key|api_key|client_secret|session_token|authorization)=)[^&#\s]+/gi, `$1${REDACTED}`);
  return text.trim().slice(0, 2_000);
}

function defaultRun(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({
      status,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
    child.stdin.end(options.input);
  });
}

function parseStatOutput(output) {
  const text = output.trim();
  try {
    const parsed = JSON.parse(text);
    const source = parsed.data ?? parsed;
    const exactPutTime = text.match(/["']?putTime["']?\s*:\s*["']?(\d+)/i)?.[1];
    return {
      size: Number(source.fsize ?? source.size),
      etag: source.hash ?? source.etag,
      mime: source.mimeType ?? source.mime,
      putTime: exactPutTime ?? (source.putTime === undefined ? undefined : String(source.putTime)),
    };
  } catch {
    const size = text.match(/(?:fsize|size)\s*[:=]\s*(\d+)/i)?.[1];
    const etag = text.match(/(?:hash|etag)\s*[:=]\s*["']?([A-Za-z0-9_-]+)/i)?.[1];
    const mime = text.match(/(?:mimeType|mime)\s*[:=]\s*["']?([^\s"']+)/i)?.[1];
    const putTime = text.match(/putTime\s*[:=]\s*["']?(\d+)/i)?.[1];
    if (!size || !etag) throw new Error(`Unable to parse qshell stat response: ${redactCommandOutput(text) || "<empty>"}`);
    return { size: Number(size), etag, ...(mime ? { mime } : {}), ...(putTime ? { putTime } : {}) };
  }
}

export function createQshellAdapter({ bucket, run = defaultRun, binary = "qshell" }) {
  if (!bucket) throw new Error("Qiniu bucket is required");

  async function invoke(args, options) {
    const result = await run(binary, args, options);
    return { ...result, status: result.status ?? result.code ?? 0 };
  }

  return {
    async stat(key) {
      const result = await invoke(["stat", bucket, key]);
      if (result.status === 0) return parseStatOutput(result.stdout);
      const detail = `${result.stdout}\n${result.stderr}`;
      if (/\b(612|631)\b|no such file|not (?:exist|found)|does not exist/i.test(detail)) return null;
      throw new Error(`qshell stat failed for ${key}: ${redactCommandOutput(detail)}`);
    },

    async uploadFile(key, localPath, mime, { overwrite = false } = {}) {
      const args = ["fput", bucket, key, localPath, "--mimetype", mime];
      if (overwrite) args.push("--overwrite");
      const result = await invoke(args);
      if (result.status !== 0) throw new Error(`qshell fput failed for ${key}: ${redactCommandOutput(`${result.stdout}\n${result.stderr}`)}`);
    },

    async uploadContent(key, content, mime, options = {}) {
      const directory = await mkdtemp(path.join(os.tmpdir(), "jugglework-qiniu-release-"));
      const localPath = path.join(directory, "payload");
      try {
        await writeFile(localPath, content, { mode: 0o600 });
        await this.uploadFile(key, localPath, mime, options);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },

    async delete(key) {
      const result = await invoke(["delete", bucket, key]);
      if (result.status !== 0) throw new Error(`qshell delete failed for ${key}: ${redactCommandOutput(`${result.stdout}\n${result.stderr}`)}`);
    },

    async refresh(urls) {
      if (!Array.isArray(urls) || urls.length === 0) throw new Error("At least one CDN URL is required for refresh");
      const result = await invoke(["cdnrefresh"], { input: `${urls.join("\n")}\n` });
      if (result.status !== 0) throw new Error(`qshell cdnrefresh failed: ${redactCommandOutput(`${result.stdout}\n${result.stderr}`)}`);
    },
  };
}
